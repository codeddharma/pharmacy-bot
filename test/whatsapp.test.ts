import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";
import Fastify from "fastify";
import { createWhatsApp } from "../src/channels/whatsapp.ts";
import type { Engine } from "../src/core/engine.ts";
import type { InboundMessage } from "../src/types.ts";

const cfg = { token: "t", phoneNumberId: "123", verifyToken: "verify-me", appSecret: "app-secret", graphVersion: "v23.0" };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureFetch() {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("maps WhatsApp messages to the engine's format", async () => {
  const wa = createWhatsApp(cfg);
  assert.deepEqual(await wa.toInbound({ from: "919876543210", id: "w1", type: "text", text: { body: "2 dolo" } }, "Asha"), {
    channel: "whatsapp",
    channelUserId: "919876543210",
    messageId: "w1",
    profileName: "Asha",
    text: "2 dolo",
  });
  const tap = (await wa.toInbound({ from: "91", id: "w2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "items:ok", title: "Yes" } } })) as InboundMessage;
  assert.equal(tap.action, "items:ok");
  const loc = (await wa.toInbound({ from: "91", id: "w3", type: "location", location: { latitude: 23.03, longitude: 72.58 } })) as InboundMessage;
  assert.deepEqual(loc.location, { lat: 23.03, lng: 72.58 });
  assert.match(String(await wa.toInbound({ from: "91", id: "w4", type: "sticker" })), /Please send text/);
});

test("up to 3 short buttons become reply buttons; more become a list", async () => {
  const calls = captureFetch();
  const wa = createWhatsApp(cfg);
  await wa.sender.send("919876543210", [{ text: "Is this correct?", buttons: [[{ label: "✅ Yes", action: "items:ok" }, { label: "✖ Cancel", action: "cancel" }]] }]);
  assert.equal(calls[0]!.url, "https://graph.facebook.com/v23.0/123/messages");
  assert.equal(calls[0]!.body.interactive.type, "button");
  assert.deepEqual(calls[0]!.body.interactive.action.buttons.map((b: any) => b.reply.id), ["items:ok", "cancel"]);

  await wa.sender.send("919876543210", [
    {
      text: "Which one?",
      buttons: [
        [{ label: "1: Crocin Advance (strip of 20 tablets)", action: "pick:0:CROCINADV500-20" }],
        [{ label: "1: Calpol 500 (strip of 15 tablets)", action: "pick:0:CALPOL500-15" }],
        [{ label: "1: None of these", action: "drop:0" }],
        [{ label: "✅ Yes, continue", action: "items:ok" }],
      ],
    },
  ]);
  const list = calls[1]!.body.interactive;
  assert.equal(list.type, "list");
  assert.equal(list.action.sections[0].rows.length, 4);
  assert.ok(list.action.sections[0].rows.every((r: any) => r.title.length <= 24));

  await wa.sender.send("919876543210", [{ text: "Share your location", requestLocation: true }]);
  assert.equal(calls[2]!.body.interactive.type, "location_request_message");
});

test("webhook: verification handshake and signature check", async () => {
  const wa = createWhatsApp(cfg);
  const handled: InboundMessage[] = [];
  const engine = { handle: async (m: InboundMessage) => (handled.push(m), []) } as unknown as Engine;
  captureFetch();
  const app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as any).rawBody = body;
    done(null, JSON.parse(String(body)));
  });
  wa.register(app, engine);

  const ok = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42" });
  assert.equal(ok.body, "42");
  assert.equal((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42" })).statusCode, 403);

  const body = JSON.stringify({
    entry: [{ changes: [{ value: { contacts: [{ wa_id: "919876543210", profile: { name: "Asha" } }], messages: [{ from: "919876543210", id: "wamid.1", type: "text", text: { body: "eno" } }] } }] }],
  });
  const bad = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
  assert.equal(bad.statusCode, 401);
  const sig = "sha256=" + createHmac("sha256", cfg.appSecret).update(body).digest("hex");
  const good = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
  assert.equal(good.statusCode, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(handled[0]?.text, "eno");
  assert.equal(handled[0]?.profileName, "Asha");
  await app.close();
});
