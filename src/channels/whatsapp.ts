import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChannelSender, Engine } from "../core/engine.ts";
import { shortLabel } from "../core/format.ts";
import type { Button, InboundMessage, OutboundMessage } from "../types.ts";

export interface WhatsAppConfig {
  token: string; // permanent system-user access token
  phoneNumberId: string;
  verifyToken: string; // any secret string, also entered in the Meta app's webhook settings
  appSecret: string; // for X-Hub-Signature-256
  graphVersion: string; // e.g. "v23.0"
}

const MAX_BUTTONS = 3; // WhatsApp reply buttons per message
const BUTTON_TITLE = 20;
const LIST_ROWS = 10;
const ROW_TITLE = 24;
const BODY_MAX = 1024;

/**
 * WhatsApp Cloud API adapter. The engine's buttons become reply buttons (up to 3, short
 * titles) or a list message (up to 10 rows) — WhatsApp's limits.
 */
export function createWhatsApp(cfg: WhatsAppConfig) {
  const graph = `https://graph.facebook.com/${cfg.graphVersion}`;

  async function call(path: string, body: unknown) {
    const res = await fetch(`${graph}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`WhatsApp ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  const post = (to: string, payload: Record<string, unknown>) =>
    call(`${cfg.phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload });

  async function sendOne(to: string, m: OutboundMessage) {
    const buttons = (m.buttons ?? []).flat();

    if (m.requestLocation) {
      await post(to, {
        type: "interactive",
        interactive: { type: "location_request_message", body: { text: m.text.slice(0, BODY_MAX) }, action: { name: "send_location" } },
      });
      if (buttons.length) await sendChoices(to, "Or:", buttons);
      return;
    }
    if (buttons.length === 0) {
      for (const chunk of chunks(m.text, 4000)) await post(to, { type: "text", text: { body: chunk, preview_url: true } });
      return;
    }
    // Interactive bodies are limited to 1024 characters: send long text separately.
    if (m.text.length > BODY_MAX) {
      for (const chunk of chunks(m.text, 4000)) await post(to, { type: "text", text: { body: chunk, preview_url: true } });
      await sendChoices(to, "Choose an option:", buttons);
    } else {
      await sendChoices(to, m.text, buttons);
    }
  }

  async function sendChoices(to: string, body: string, buttons: Button[]) {
    if (buttons.length <= MAX_BUTTONS && buttons.every((b) => b.label.length <= BUTTON_TITLE)) {
      await post(to, {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.action, title: b.label } })) },
        },
      });
      return;
    }
    for (let i = 0; i < buttons.length; i += LIST_ROWS) {
      const page = buttons.slice(i, i + LIST_ROWS);
      await post(to, {
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: i === 0 ? body : "More options:" },
          action: {
            button: "Choose",
            sections: [
              {
                title: "Options",
                rows: page.map((b) => ({
                  id: b.action,
                  title: shortLabel(b.label, ROW_TITLE),
                  ...(b.label.length > ROW_TITLE ? { description: shortLabel(b.label, 72) } : {}),
                })),
              },
            ],
          },
        },
      });
    }
  }

  const sender: ChannelSender = {
    async send(to, messages) {
      for (const m of messages) await sendOne(to, m);
    },
    async sendTemplate(to, template, language, params) {
      await post(to, {
        type: "template",
        template: {
          name: template,
          language: { code: language },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
        },
      });
    },
  };

  async function downloadMedia(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const metaRes = await fetch(`${graph}/${id}`, { headers: { authorization: `Bearer ${cfg.token}` } });
    if (!metaRes.ok) throw new Error(`WhatsApp media ${id} lookup failed: ${metaRes.status}`);
    const meta = (await metaRes.json()) as { url: string; mime_type: string; file_size?: number };
    if (meta.file_size && meta.file_size > 20 * 1024 * 1024) throw new Error("File too large");
    const fileRes = await fetch(meta.url, { headers: { authorization: `Bearer ${cfg.token}` } });
    if (!fileRes.ok) throw new Error(`WhatsApp media ${id} download failed: ${fileRes.status}`);
    return { data: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type };
  }

  /** Turns one webhook message into an InboundMessage, or a reply for unsupported types. */
  async function toInbound(msg: any, profileName?: string): Promise<InboundMessage | string | null> {
    const base = { channel: "whatsapp" as const, channelUserId: String(msg.from), messageId: String(msg.id), profileName };
    switch (msg.type) {
      case "text":
        return { ...base, text: msg.text?.body ?? "" };
      case "interactive": {
        const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
        return reply?.id ? { ...base, action: String(reply.id) } : null;
      }
      case "button": // quick-reply button on a template
        return { ...base, text: msg.button?.text ?? msg.button?.payload ?? "" };
      case "location":
        return { ...base, location: { lat: Number(msg.location.latitude), lng: Number(msg.location.longitude) } };
      case "contacts": {
        const phone = msg.contacts?.[0]?.phones?.[0]?.phone;
        return phone ? { ...base, contactPhone: String(phone) } : null;
      }
      case "image": {
        const { data, mimeType } = await downloadMedia(msg.image.id);
        return { ...base, text: msg.image.caption, media: { kind: "image", mimeType, data } };
      }
      case "document": {
        const mime = String(msg.document?.mime_type ?? "");
        const kind = mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : null;
        if (!kind) return "I can read photos and PDFs. Please send the prescription as one of those.";
        const { data, mimeType } = await downloadMedia(msg.document.id);
        return { ...base, text: msg.document.caption, media: { kind, mimeType, data } };
      }
      default:
        return "Please send text, a photo or a PDF of your prescription.";
    }
  }

  function verifySignature(raw: Buffer | undefined, header: unknown): boolean {
    if (!raw || typeof header !== "string" || !header.startsWith("sha256=")) return false;
    const expected = Buffer.from(createHmac("sha256", cfg.appSecret).update(raw).digest("hex"));
    const got = Buffer.from(header.slice(7));
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  function register(app: FastifyInstance, engine: Engine) {
    // Meta checks the webhook URL once with a GET.
    app.get("/webhooks/whatsapp", async (req, reply) => {
      const q = req.query as Record<string, string>;
      if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === cfg.verifyToken) return reply.send(q["hub.challenge"]);
      return reply.status(403).send();
    });

    app.post("/webhooks/whatsapp", async (req, reply) => {
      if (!verifySignature(req.rawBody, req.headers["x-hub-signature-256"])) return reply.status(401).send();
      reply.send({ ok: true }); // acknowledge first; Meta retries slow webhooks
      const body = req.body as any;
      for (const entry of body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [String(c.wa_id), c.profile?.name]));
          for (const msg of value.messages ?? []) {
            void (async () => {
              try {
                const inbound = await toInbound(msg, names.get(String(msg.from)));
                if (!inbound) return;
                if (typeof inbound === "string") return sender.send(String(msg.from), [{ text: inbound }]);
                const out = await engine.handle(inbound);
                await sender.send(inbound.channelUserId, out);
              } catch (err) {
                console.error("[whatsapp] message:", err);
                await sender.send(String(msg.from), [{ text: "Sorry, something went wrong on my side. Please try again." }]).catch(() => undefined);
              }
            })();
          }
        }
      }
    });
  }

  return { sender, register, toInbound };
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}
