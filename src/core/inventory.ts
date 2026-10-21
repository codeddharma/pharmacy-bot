import { randomUUID } from "node:crypto";
import type { Store } from "../store/db.ts";
import type { Batch, Inventory, InventoryItem, Reservation } from "../types.ts";

/** Last moment a batch can be used: the end of its expiry month ("2027-11" -> 30 Nov 2027 23:59:59). */
export function expiryEnd(exp: string): Date {
  const [y, m] = exp.split("-").map(Number) as [number, number];
  return new Date(y, m, 0, 23, 59, 59);
}

/** Batches that can still be sold, earliest expiry first (FEFO). */
export function sellableBatches(item: InventoryItem, now: Date, nearExpiryDays: number): Batch[] {
  const cutoff = now.getTime() + nearExpiryDays * 24 * 60 * 60 * 1000;
  return item.batches
    .filter((b) => b.qty > 0 && expiryEnd(b.exp).getTime() > cutoff)
    .sort((a, b) => expiryEnd(a.exp).getTime() - expiryEnd(b.exp).getTime());
}

export function availableIn(inv: Inventory, sku: string, now: Date): number {
  const item = inv.items[sku];
  if (!item) return 0;
  const good = sellableBatches(item, now, inv.meta.near_expiry_days).reduce((sum, b) => sum + b.qty, 0);
  return Math.max(good - item.reserved, 0);
}

export function available(store: Store, sku: string, now: Date): number {
  return availableIn(store.inventory.data, sku, now);
}

/**
 * Holds up to `qty` packs for an order. Returns how many were held.
 * Call only inside store.withLock, then write inventory and reservations.
 */
export function reserveIn(
  store: Store,
  orderId: string,
  sku: string,
  qty: number,
  now: Date,
  ttlMinutes: number,
): number {
  const granted = Math.min(qty, availableIn(store.inventory.data, sku, now));
  if (granted <= 0) return 0;
  store.inventory.data.items[sku]!.reserved += granted;
  store.reservations.data.push({
    id: randomUUID(),
    orderId,
    sku,
    qty: granted,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
  });
  return granted;
}

function releaseIn(store: Store, reservations: Reservation[]) {
  for (const r of reservations) {
    const item = store.inventory.data.items[r.sku];
    if (item) item.reserved = Math.max(item.reserved - r.qty, 0);
  }
  const ids = new Set(reservations.map((r) => r.id));
  store.reservations.data = store.reservations.data.filter((r) => !ids.has(r.id));
}

export async function releaseOrder(store: Store, orderId: string): Promise<void> {
  await store.withLock(async () => {
    releaseIn(store, store.reservations.data.filter((r) => r.orderId === orderId));
    await Promise.all([store.inventory.write(), store.reservations.write()]);
  });
}

/** Keeps an order's stock held while the customer is still working through checkout. */
export async function extendOrder(store: Store, orderId: string, now: Date, ttlMinutes: number): Promise<void> {
  await store.withLock(async () => {
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
    for (const r of store.reservations.data) if (r.orderId === orderId) r.expiresAt = expiresAt;
    await store.reservations.write();
  });
}

/**
 * Turns an order's reservations into sold stock, taking packs from the earliest-expiring
 * sellable batch first. Returns which batches each SKU came from (for recall tracing).
 */
export async function commitOrder(
  store: Store,
  orderId: string,
  now: Date,
): Promise<Map<string, { batch: string; exp: string; qty: number }[]>> {
  return store.withLock(async () => {
    const inv = store.inventory.data;
    const mine = store.reservations.data.filter((r) => r.orderId === orderId);
    const allocations = new Map<string, { batch: string; exp: string; qty: number }[]>();

    for (const r of mine) {
      const item = inv.items[r.sku];
      if (!item) throw new Error(`Reserved SKU ${r.sku} is missing from inventory.json`);
      let left = r.qty;
      const picked: { batch: string; exp: string; qty: number }[] = [];
      for (const b of sellableBatches(item, now, inv.meta.near_expiry_days)) {
        if (left === 0) break;
        const take = Math.min(b.qty, left);
        b.qty -= take;
        left -= take;
        picked.push({ batch: b.batch, exp: b.exp, qty: take });
      }
      if (left > 0) throw new Error(`Not enough sellable stock of ${r.sku} to fill reservation ${r.id}`);
      item.reserved = Math.max(item.reserved - r.qty, 0);
      allocations.set(r.sku, [...(allocations.get(r.sku) ?? []), ...picked]);
    }

    const ids = new Set(mine.map((r) => r.id));
    store.reservations.data = store.reservations.data.filter((r) => !ids.has(r.id));
    await Promise.all([store.inventory.write(), store.reservations.write()]);
    return allocations;
  });
}

/** Releases every reservation past its expiry. Returns the affected order IDs. */
export async function expireReservations(store: Store, now: Date): Promise<string[]> {
  return store.withLock(async () => {
    const expired = store.reservations.data.filter((r) => new Date(r.expiresAt) <= now);
    if (expired.length === 0) return [];
    releaseIn(store, expired);
    await Promise.all([store.inventory.write(), store.reservations.write()]);
    return [...new Set(expired.map((r) => r.orderId))];
  });
}

export async function addStock(
  store: Store,
  sku: string,
  batch: Batch,
): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  return store.withLock(async () => {
    const item = store.inventory.data.items[sku];
    if (!item) return { ok: false as const, error: `${sku} is not in inventory.json` };
    const existing = item.batches.find((b) => b.batch === batch.batch);
    if (existing) {
      if (existing.exp !== batch.exp) {
        return { ok: false as const, error: `Batch ${batch.batch} already exists with expiry ${existing.exp}` };
      }
      existing.qty += batch.qty;
    } else {
      item.batches.push(batch);
    }
    await store.inventory.write();
    return { ok: true as const, total: item.batches.reduce((s, b) => s + b.qty, 0) };
  });
}
