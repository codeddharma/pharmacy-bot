import { Bot, InlineKeyboard, Keyboard, type Api } from "grammy";
import type { Config } from "../config.ts";
import type { Engine, Notifier } from "../core/engine.ts";
import type { InboundMessage, OutboundMessage } from "../types.ts";

const CHANNEL = "telegram";

function chatIdOf(userId: string): number | null {
  const [prefix, id] = userId.split(":");
  return prefix === "tg" && id ? Number(id) : null;
}

async function send(api: Api, chatId: number | string, m: OutboundMessage) {
  let reply_markup: InlineKeyboard | Keyboard | { remove_keyboard: true } | undefined;
  if (m.buttons?.length) {
    const kb = new InlineKeyboard();
    m.buttons.forEach((row, i) => {
      for (const b of row) kb.text(b.label, b.action);
      if (i < m.buttons!.length - 1) kb.row();
    });
    reply_markup = kb;
  } else if (m.requestContact) {
    reply_markup = new Keyboard().requestContact("📱 Share my phone number").resized().oneTime();
  } else if (m.removeKeyboard) {
    reply_markup = { remove_keyboard: true };
  }
  await api.sendMessage(chatId, m.text, { reply_markup });
}

/**
 * Telegram adapter: long polling, so it runs from a laptop with no server or webhook.
 * Turns Telegram updates into InboundMessages for the engine and renders its replies.
 */
export function createTelegram(config: Config) {
  const bot = new Bot(config.telegramToken);

  const notifier: Notifier = {
    async toUser(userId, messages) {
      const chatId = chatIdOf(userId);
      if (chatId === null) return;
      for (const m of messages) await send(bot.api, chatId, m).catch((e) => console.error(`[telegram] send to ${userId}:`, e));
    },
    async toAdmins(text) {
      for (const id of config.adminChatIds) {
        await bot.api.sendMessage(id, text).catch((e) => console.error(`[telegram] admin ${id}:`, e));
      }
    },
  };

  async function download(fileId: string, size: number | undefined): Promise<Buffer | null> {
    if (size && size > config.maxUploadBytes) return null;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  function attach(engine: Engine) {
    bot.on("message", async (ctx) => {
      if (ctx.chat.type !== "private") return;
      const m = ctx.message;
      const base = { userId: `tg:${ctx.chat.id}`, channel: CHANNEL, messageId: `tg:${ctx.chat.id}:${m.message_id}` };
      let inbound: InboundMessage | null = null;

      try {
        if (m.text) {
          inbound = { ...base, text: m.text };
        } else if (m.contact) {
          if (m.contact.user_id !== ctx.from.id) {
            await ctx.reply("Please share your own phone number, or type it.");
            return;
          }
          inbound = { ...base, contactPhone: m.contact.phone_number };
        } else if (m.photo?.length) {
          const largest = m.photo[m.photo.length - 1]!;
          await ctx.replyWithChatAction("typing");
          const data = await download(largest.file_id, largest.file_size);
          if (!data) {
            await ctx.reply("That file is too large. Please send a photo under 20 MB.");
            return;
          }
          inbound = { ...base, text: m.caption, media: { kind: "image", mimeType: "image/jpeg", data } };
        } else if (m.document) {
          const mime = m.document.mime_type ?? "";
          const kind = mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : null;
          if (!kind) {
            await ctx.reply("I can read photos and PDFs. Please send the prescription as one of those.");
            return;
          }
          await ctx.replyWithChatAction("typing");
          const data = await download(m.document.file_id, m.document.file_size);
          if (!data) {
            await ctx.reply("That file is too large. Please send a file under 20 MB.");
            return;
          }
          inbound = { ...base, text: m.caption, media: { kind, mimeType: mime, data } };
        } else {
          await ctx.reply("Please send text, a photo or a PDF of your prescription.");
          return;
        }

        await ctx.replyWithChatAction("typing");
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
        // Hide the buttons that were just used so old steps can't be tapped again.
        // "Notify me" buttons sit under the cart, so that message keeps its buttons.
        if (!action.startsWith("notify:")) {
          await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
        }
        const out = await engine.handle({
          userId: `tg:${chatId}`,
          channel: CHANNEL,
          messageId: `tgcb:${ctx.callbackQuery.id}`,
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

  async function start() {
    await bot.api.setMyCommands([
      { command: "start", description: "Start ordering" },
      { command: "help", description: "How to order" },
      { command: "status", description: "Your recent orders" },
      { command: "cancel", description: "Cancel what you're doing" },
      { command: "pharmacist", description: "Talk to our pharmacist" },
    ]);
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (me) => console.log(`[telegram] running as @${me.username} (long polling)`),
    });
  }

  return { bot, notifier, attach, start };
}
