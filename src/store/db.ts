import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import {
  InventorySchema,
  type Customer,
  type Inventory,
  type Order,
  type Reservation,
  type Session,
  type WaitlistEntry,
} from "../types.ts";

/**
 * All bot data lives in JSON files under DATA_DIR. lowdb writes each file atomically
 * (temp file + rename), and every read-modify-write goes through `withLock`, so two
 * customers buying the last strip at the same moment can't corrupt the stock count.
 * Run only one bot process against a data folder.
 */
export interface Store {
  dir: string;
  inventory: Low<Inventory>;
  orders: Low<Order[]>;
  reservations: Low<Reservation[]>;
  customers: Low<Record<string, Customer>>;
  sessions: Low<Record<string, Session>>;
  waitlist: Low<WaitlistEntry[]>;
  /** Run `fn` with exclusive access to the data. Do not nest calls. */
  withLock<T>(fn: () => Promise<T> | T): Promise<T>;
  audit(event: string, userId: string | null, data?: Record<string, unknown>): Promise<void>;
  saveUpload(userId: string, data: Buffer, ext: string): Promise<string>;
}

export async function openStore(dir: string): Promise<Store> {
  const inventoryPath = path.join(dir, "inventory.json");
  if (!existsSync(inventoryPath)) throw new Error(`Missing ${inventoryPath}`);

  const inventory = await JSONFilePreset<Inventory>(inventoryPath, { meta: { near_expiry_days: 90 }, items: {} });
  const parsed = InventorySchema.safeParse(inventory.data);
  if (!parsed.success) {
    throw new Error(`inventory.json is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }

  const orders = await JSONFilePreset<Order[]>(path.join(dir, "orders.json"), []);
  const reservations = await JSONFilePreset<Reservation[]>(path.join(dir, "reservations.json"), []);
  const customers = await JSONFilePreset<Record<string, Customer>>(path.join(dir, "customers.json"), {});
  const sessions = await JSONFilePreset<Record<string, Session>>(path.join(dir, "sessions.json"), {});
  const waitlist = await JSONFilePreset<WaitlistEntry[]>(path.join(dir, "waitlist.json"), []);

  let tail: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  }

  const auditPath = path.join(dir, "audit.jsonl");
  async function audit(event: string, userId: string | null, data: Record<string, unknown> = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, userId, ...data });
    await appendFile(auditPath, line + "\n");
  }

  async function saveUpload(userId: string, data: Buffer, ext: string) {
    const folder = path.join(dir, "uploads", userId.replace(/[^a-z0-9_-]/gi, "_"));
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
    await writeFile(file, data, { mode: 0o600 });
    return file;
  }

  return { dir, inventory, orders, reservations, customers, sessions, waitlist, withLock, audit, saveUpload };
}
