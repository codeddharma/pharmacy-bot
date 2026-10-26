import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../db/client.ts";
import { batches, products, reservations } from "../db/schema.ts";
import { zonedParts } from "./hours.ts";

/**
 * Stock rules:
 * - A batch can be sold only if it expires more than `nearExpiryDays` from today.
 * - available = sellable packs − packs held by open orders − packs held manually.
 * - Sales take the earliest-expiring sellable batch first (FEFO).
 */

export interface StockPolicy {
  now: Date;
  nearExpiryDays: number;
  timezone: string;
}

/** Batches expiring on or before this date (YYYY-MM-DD) are not sold. */
export function expiryCutoff(p: StockPolicy): string {
  return zonedParts(new Date(p.now.getTime() + p.nearExpiryDays * 86_400_000), p.timezone).ymd;
}

export async function availableMap(db: DbOrTx, p: StockPolicy, skus?: string[]): Promise<Map<string, number>> {
  const cutoff = expiryCutoff(p);
  const good = await db
    .select({ sku: batches.sku, qty: sql<number>`coalesce(sum(${batches.qty}), 0)::int` })
    .from(batches)
    .where(and(gt(batches.exp, cutoff), gt(batches.qty, 0), skus ? inArray(batches.sku, skus) : undefined))
    .groupBy(batches.sku);
  const held = await db
    .select({ sku: reservations.sku, qty: sql<number>`coalesce(sum(${reservations.qty}), 0)::int` })
    .from(reservations)
    .where(and(gt(reservations.expiresAt, p.now), skus ? inArray(reservations.sku, skus) : undefined))
    .groupBy(reservations.sku);
  const manual = await db
    .select({ sku: products.sku, hold: products.manualHold })
    .from(products)
    .where(skus ? inArray(products.sku, skus) : undefined);

  const out = new Map<string, number>();
  const goodBy = new Map(good.map((r) => [r.sku, r.qty]));
  const heldBy = new Map(held.map((r) => [r.sku, r.qty]));
  for (const m of manual) {
    out.set(m.sku, Math.max((goodBy.get(m.sku) ?? 0) - (heldBy.get(m.sku) ?? 0) - m.hold, 0));
  }
  return out;
}

export async function available(db: DbOrTx, sku: string, p: StockPolicy): Promise<number> {
  return (await availableMap(db, p, [sku])).get(sku) ?? 0;
}

/**
 * Holds up to `qty` packs for an order inside a transaction. The product row is locked
 * first, so two customers can't both take the last pack. Returns how many were held.
 */
export async function reserveIn(tx: Tx, orderId: string, sku: string, qty: number, p: StockPolicy, ttlMinutes: number) {
  await tx.select({ sku: products.sku }).from(products).where(eq(products.sku, sku)).for("update");
  const granted = Math.min(qty, await available(tx, sku, p));
  if (granted <= 0) return 0;
  await tx.insert(reservations).values({
    orderId,
    sku,
    qty: granted,
    expiresAt: new Date(p.now.getTime() + ttlMinutes * 60_000),
  });
  return granted;
}

export async function releaseOrder(db: DbOrTx, orderId: string): Promise<string[]> {
  const removed = await db.delete(reservations).where(eq(reservations.orderId, orderId)).returning({ sku: reservations.sku });
  return [...new Set(removed.map((r) => r.sku))];
}

export async function extendOrder(db: DbOrTx, orderId: string, until: Date): Promise<void> {
  await db.update(reservations).set({ expiresAt: until }).where(eq(reservations.orderId, orderId));
}

export async function hasReservations(db: DbOrTx, orderId: string): Promise<boolean> {
  const [row] = await db.select({ id: reservations.id }).from(reservations).where(eq(reservations.orderId, orderId)).limit(1);
  return !!row;
}

export type Allocations = Map<string, { batch: string; exp: string; qty: number }[]>;

/**
 * Turns an order's holds into sold stock, earliest-expiring batch first, and records
 * which batches went out. Throws if the held stock is no longer there.
 */
export async function commitOrderIn(tx: Tx, orderId: string, p: StockPolicy): Promise<Allocations> {
  const cutoff = expiryCutoff(p);
  const mine = await tx.select().from(reservations).where(eq(reservations.orderId, orderId));
  const allocations: Allocations = new Map();

  for (const r of mine) {
    await tx.select({ sku: products.sku }).from(products).where(eq(products.sku, r.sku)).for("update");
    const rows = await tx
      .select()
      .from(batches)
      .where(and(eq(batches.sku, r.sku), gt(batches.exp, cutoff), gt(batches.qty, 0)))
      .orderBy(asc(batches.exp), asc(batches.id));
    let left = r.qty;
    const picked: { batch: string; exp: string; qty: number }[] = [];
    for (const b of rows) {
      if (left === 0) break;
      const take = Math.min(b.qty, left);
      await tx.update(batches).set({ qty: b.qty - take }).where(eq(batches.id, b.id));
      left -= take;
      picked.push({ batch: b.batchNo, exp: b.exp.slice(0, 7), qty: take });
    }
    if (left > 0) throw new Error(`Not enough sellable stock of ${r.sku} for order ${orderId}`);
    allocations.set(r.sku, [...(allocations.get(r.sku) ?? []), ...picked]);
  }
  await tx.delete(reservations).where(eq(reservations.orderId, orderId));
  return allocations;
}

/** Deletes expired holds. Returns the affected order IDs. */
export async function expireReservations(db: DbOrTx, now: Date): Promise<string[]> {
  const removed = await db
    .delete(reservations)
    .where(lte(reservations.expiresAt, now))
    .returning({ orderId: reservations.orderId });
  return [...new Set(removed.map((r) => r.orderId))];
}

/** Puts sold packs back into the batches they came from (used when a confirmed order is cancelled). */
export async function restockIn(tx: Tx, sku: string, picked: { batch: string; qty: number }[]) {
  for (const b of picked) {
    await tx
      .update(batches)
      .set({ qty: sql`${batches.qty} + ${b.qty}` })
      .where(and(eq(batches.sku, sku), eq(batches.batchNo, b.batch)));
  }
}
