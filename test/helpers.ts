import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config as baseConfig, type Config } from "../src/config.ts";
import { Engine, type Notifier } from "../src/core/engine.ts";
import { MockPaymentProvider } from "../src/core/payment.ts";
import type { Extraction, Extractor } from "../src/extract/types.ts";
import { CatalogueStore } from "../src/store/catalogue.ts";
import { openStore } from "../src/store/db.ts";
import type { InboundMessage, OutboundMessage } from "../src/types.ts";

/** A fresh copy of the real catalogue and inventory in a temp folder, with empty runtime files. */
export function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pharmacy-bot-test-"));
  const src = path.resolve("data");
  copyFileSync(path.join(src, "catalogue.json"), path.join(dir, "catalogue.json"));
  copyFileSync(path.join(src, "inventory.json"), path.join(dir, "inventory.json"));
  for (const [f, v] of [["orders.json", "[]"], ["reservations.json", "[]"], ["customers.json", "{}"], ["sessions.json", "{}"]]) {
    writeFileSync(path.join(dir, f!), v!);
  }
  return dir;
}

export class FakeExtractor implements Extractor {
  readonly name = "fake";
  next: Extraction = { document_type: "unreadable", language: "en", items: [] };
  calls = 0;
  async extract(): Promise<Extraction> {
    this.calls++;
    return this.next;
  }
}

export async function setup(opts: { extractor?: Extractor | null; config?: Partial<Config> } = {}) {
  const dir = tempDataDir();
  const store = await openStore(dir);
  const catalogue = new CatalogueStore(path.join(dir, "catalogue.json"));
  const clock = { now: new Date("2026-10-22T10:00:00+05:30") };
  const sentToUsers: { userId: string; messages: OutboundMessage[] }[] = [];
  const sentToAdmins: string[] = [];
  const notifier: Notifier = {
    async toUser(userId, messages) {
      sentToUsers.push({ userId, messages });
    },
    async toAdmins(text) {
      sentToAdmins.push(text);
    },
  };
  const config: Config = { ...baseConfig, adminChatIds: ["999"], pharmacyPhone: "+91 99999 00000", ...opts.config };
  const engine = new Engine({
    store,
    catalogue,
    extractor: opts.extractor === undefined ? null : opts.extractor,
    payment: new MockPaymentProvider(),
    notifier,
    config,
    now: () => clock.now,
  });

  let seq = 0;
  const user = "tg:1001";
  const send = async (m: Omit<InboundMessage, "userId" | "channel" | "messageId"> & { userId?: string }) => {
    const out = await engine.handle({ userId: user, channel: "telegram", messageId: `m${++seq}`, ...m });
    return out;
  };
  const say = (text: string) => send({ text });
  const tap = (action: string) => send({ action });
  const advance = (minutes: number) => {
    clock.now = new Date(clock.now.getTime() + minutes * 60_000);
  };

  return { dir, store, catalogue, engine, clock, advance, send, say, tap, user, sentToUsers, sentToAdmins, config };
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
