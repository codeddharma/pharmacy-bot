import path from "node:path";
import { openDatabase } from "../src/db/client.ts";
import { seedCatalogue, seedRoles, seedSettings } from "../src/db/seed.ts";
import { Engine, type ChannelSender } from "../src/core/engine.ts";
import { MockPaymentProvider } from "../src/payments/mock.ts";
import type { Extraction, Extractor } from "../src/extract/types.ts";
import { CatalogueCache } from "../src/services/catalogue.ts";
import { EventBus, type AppEvent } from "../src/services/events.ts";
import { SettingsService, type Settings } from "../src/services/settings.ts";
import type { InboundMessage, OutboundMessage } from "../src/types.ts";

export class FakeExtractor implements Extractor {
  readonly name = "fake";
  next: Extraction = { document_type: "unreadable", language: "en", items: [] };
  calls = 0;
  async extract(): Promise<Extraction> {
    this.calls++;
    return this.next;
  }
}

export class FakeSender implements ChannelSender {
  sent: { to: string; messages: OutboundMessage[] }[] = [];
  templates: { to: string; template: string; params: string[] }[] = [];
  async send(to: string, messages: OutboundMessage[]) {
    this.sent.push({ to, messages });
  }
  async sendTemplate(to: string, template: string, _lang: string, params: string[]) {
    this.templates.push({ to, template, params });
  }
  lastText(): string {
    return this.sent.at(-1)?.messages.map((m) => m.text).join("\n") ?? "";
  }
}

/** A fresh in-memory PostgreSQL with the real catalogue and stock, and an engine wired to fakes. */
export async function setup(opts: { extractor?: Extractor | null; settings?: (s: Settings) => void } = {}) {
  const { db, close } = await openDatabase({});
  await seedRoles(db);
  await seedSettings(db);
  await seedCatalogue(db, path.resolve("data/catalogue.json"), path.resolve("data/inventory.json"));

  const settings = new SettingsService(db);
  const s = structuredClone(await settings.get());
  s.pharmacy.phone = "+91 99999 00000";
  opts.settings?.(s);
  await settings.save(s, null);

  const catalogue = new CatalogueCache(db);
  await catalogue.load();
  const bus = new EventBus();
  const events: AppEvent[] = [];
  bus.on((e) => events.push(e));
  const telegram = new FakeSender();
  const whatsapp = new FakeSender();
  const clock = { now: new Date("2026-10-22T10:00:00+05:30") };
  const uploads: string[] = [];

  const engine = new Engine({
    db,
    catalogue,
    settings,
    bus,
    extractor: opts.extractor === undefined ? null : opts.extractor,
    payments: new MockPaymentProvider("http://localhost:3000"),
    senders: { telegram, whatsapp },
    saveUpload: async (key, _data, ext) => {
      const p = `/uploads/${key}/${uploads.length}.${ext}`;
      uploads.push(p);
      return p;
    },
    now: () => clock.now,
  });

  let seq = 0;
  const user = "1001";
  const send = (m: Partial<InboundMessage> & { channelUserId?: string }) =>
    engine.handle({ channel: "telegram", channelUserId: user, messageId: `m${++seq}`, ...m } as InboundMessage);
  const say = (text: string) => send({ text });
  const tap = (action: string) => send({ action });
  const advance = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };

  return { db, close, engine, settings, catalogue, bus, events, telegram, whatsapp, clock, advance, send, say, tap, user, uploads };
}

/** Consent once so tests can start ordering straight away. */
export async function consented(opts?: Parameters<typeof setup>[0]) {
  const t = await setup(opts);
  await t.say("/start");
  await t.tap("consent:yes");
  return t;
}

export const textOf = (out: OutboundMessage[]) => out.map((m) => m.text).join("\n---\n");
export const actionsOf = (out: OutboundMessage[]) => out.flatMap((m) => (m.buttons ?? []).flat().map((b) => b.action));
