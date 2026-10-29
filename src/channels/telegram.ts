import type { FastifyInstance } from "fastify";
import { Bot, InlineKeyboard, Keyboard, type Api, type Context } from "grammy";
import type { ChannelSender, Engine } from "../core/engine.ts";
import type { InboundMessage, OutboundMessage } from "../types.ts";

const MAX_UPLOAD = 20 * 1024 * 1024; // Telegram bots can't download bigger files

function inlineKeyboard(rows: OutboundMessage["buttons"]) {
  const kb = new InlineKeyboard();
  rows!.forEach((row, i) => {
    for (const b of row) kb.text(b.label, b.action);
    if (i < rows!.length - 1) kb.row();
  });
  return kb;
}

async function send(api: Api, chatId: string | number, m: OutboundMessage) {
  const wantsKeyboard = m.requestContact || m.requestLocation;
  if (wantsKeyboard) {
    const kb = new Keyboard();
    if (m.requestContact) kb.requestContact("📱 Share my phone number");
    if (m.requestLocation) kb.requestLocation("📍 Share my location");
    await api.sendMessage(chatId, m.text, { reply_markup: kb.resized().oneTime() });
    // A message can carry only one keyboard, so inline buttons go in a second message.
    if (m.buttons?.length) await api.sendMessage(chatId, "Or:", { reply_markup: inlineKeyboard(m.buttons) });
    return;
  }
  const reply_markup = m.buttons?.length ? inlineKeyboard(m.buttons) : m.removeKeyboard ? { remove_keyboard: true as const } : undefined;
  await api.sendMessage(chatId, m.text, { reply_markup, link_preview_options: { is_disabled: true } });
}

/**
 * Telegram adapter. Production uses a webhook (Telegram calls our HTTPS server);
 * local development uses long polling, so it runs on a laptop with no public URL.
 */
export function createTelegram(token: string) {
  const bot = new Bot(token);

  const sender: ChannelSender = {
    async send(chatId, messages) {
      for (const m of messages) await send(bot.api, chatId, m);
    },
  };

  async function download(fileId: string, size: number | undefined): Promise<Buffer | null> {
    if (size && size > MAX_UPLOAD) return null;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function toInbound(ctx: Context): Promise<InboundMessage | string | null> {
    const m = ctx.message!;
    const base = {
      channel: "telegram" as const,
      channelUserId: String(ctx.chat!.id),
      messageId: `${ctx.chat!.id}:${m.message_id}`,
      profileName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || undefined,
    };
    if (m.text) return { ...base, text: m.text };
    if (m.location) return { ...base, location: { lat: m.location.latitude, lng: m.location.longitude } };
    if (m.contact) {
      if (m.contact.user_id !== ctx.from?.id) return "Please share your own phone number, or type it.";
      return { ...base, contactPhone: m.contact.phone_number };
    }
    if (m.photo?.length) {
      const largest = m.photo[m.photo.length - 1]!;
      const data = await download(largest.file_id, largest.file_size);
      if (!data) return "That file is too large. Please send a photo under 20 MB.";
      return { ...base, text: m.caption, media: { kind: "image", mimeType: "image/jpeg", data } };
    }
    if (m.document) {
      const mime = m.document.mime_type ?? "";
      const kind = mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : null;
      if (!kind) return "I can read photos and PDFs. Please send the prescription as one of those.";
      const data = await download(m.document.file_id, m.document.file_size);
      if (!data) return "That file is too large. Please send a file under 20 MB.";
      return { ...base, text: m.caption, media: { kind, mimeType: mime, data } };
    }
    return null;
  }

  function attach(engine: Engine) {
    bot.on("message", async (ctx) => {
      if (ctx.chat.type !== "private") return;
      try {
        const inbound = await toInbound(ctx);
        if (inbound === null) {
          await ctx.reply("Please send text, a photo or a PDF of your prescription.");
          return;
        }
        if (typeof inbound === "string") {
          await ctx.reply(inbound);
          return;
        }
        await ctx.replyWithChatAction("typing").catch(() => undefined);
        for (const out of await engine.handle(inbound)) await send(ctx.api, ctx.chat.id, out);
      } catch (err) {
        console.error("[telegram] message handler:", err);
        await ctx.reply("Sorry, something went wrong on my side. Please try again.").catch(() => undefined);
      }
    });

    bot.on("callback_query:data", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const chatId = ctx.chat?.id;
      if (chatId === undefined || ctx.chat?.type !== "private") return;
      const action = ctx.callbackQuery.data;
      try {
        // Hide used buttons so old steps can't be tapped again. Keep the cart's
        // "notify me" and "alternative" buttons, which sit next to the main ones.
        if (!/^(notify|alt):/.test(action)) {
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        }
        const out = await engine.handle({
          channel: "telegram",
          channelUserId: String(chatId),
          messageId: `cb:${ctx.callbackQuery.id}`,
          action,
        });
        for (const m of out) await send(ctx.api, chatId, m);
      } catch (err) {
        console.error("[telegram] button handler:", err);
        await ctx.api.sendMessage(chatId, "Sorry, something went wrong on my side. Please try again.").catch(() => undefined);
      }
    });

    bot.catch((err) => console.error("[telegram]", err.error));
  }

  const commands = [
    { command: "start", description: "Start ordering" },
    { command: "help", description: "How to order" },
    { command: "status", description: "Your recent orders" },
    { command: "ask", description: "Ask our pharmacist" },
    { command: "hours", description: "Opening hours" },
    { command: "cancel", description: "Cancel what you're doing" },
  ];

  async function startPolling() {
    await bot.api.deleteWebhook();
    await bot.api.setMyCommands(commands);
    void bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (me) => console.log(`[telegram] @${me.username} (long polling)`),
    });
  }

  /** Adds POST /webhooks/telegram. Call before the server starts listening. */
  async function registerWebhookRoute(app: FastifyInstance, secret: string) {
    await bot.init();
    app.post("/webhooks/telegram", async (req, reply) => {
      if (req.headers["x-telegram-bot-api-secret-token"] !== secret) return reply.status(401).send();
      // Reply at once and handle in the background, so a slow AI call can't make Telegram resend.
      void bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]).catch((e) => console.error("[telegram] update:", e));
      return reply.send({ ok: true });
    });
  }

  /**
   * Points Telegram at our webhook. Throws a short error without the request payload,
   * because Telegram's error object includes the secret token.
   */
  async function setWebhook(publicUrl: string, secret: string) {
    try {
      await bot.api.setMyCommands(commands);
      await bot.api.setWebhook(`${publicUrl}/webhooks/telegram`, {
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
    } catch (err) {
      const e = err as { description?: string; message?: string };
      throw new Error(e.description ?? e.message ?? "unknown error");
    }
    console.log(`[telegram] @${bot.botInfo.username} (webhook ${publicUrl}/webhooks/telegram)`);
  }

  return { bot, sender, attach, startPolling, registerWebhookRoute, setWebhook };
}
