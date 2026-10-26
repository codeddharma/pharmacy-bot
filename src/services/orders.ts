import { and, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import type { DB, DbOrTx } from "../db/client.ts";
import { orderEvents, orders, type OrderLine, type OrderStatus } from "../db/schema.ts";
import type { Product } from "../types.ts";
import { rupeesToPaise } from "../types.ts";
import { zonedParts } from "./hours.ts";
import { availableMap, reserveIn, type StockPolicy } from "./inventory.ts";

export type Order = typeof orders.$inferSelect;

export interface CartRequest {
  product: Product;
  qty: number;
  notes: string[];
}

export interface Pricing {
  feeRupees: number;
  freeAboveRupees: number;
}

export const OPEN_STATUSES: OrderStatus[] = ["reserved", "awaiting_payment"];
export const ACTIVE_STATUSES: OrderStatus[] = ["confirmed", "preparing", "out_for_delivery"];

/** Which status changes staff may make. */
export const STAFF_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  confirmed: ["preparing", "out_for_delivery", "cancelled"],
  preparing: ["out_for_delivery", "cancelled"],
  out_for_delivery: ["delivered", "cancelled"],
  reserved: ["cancelled"],
  awaiting_payment: ["cancelled"],
};

export function priceLines(lines: OrderLine[], pricing: Pricing) {
  const subtotalPaise = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const deliveryFeePaise =
    lines.length === 0 || subtotalPaise >= rupeesToPaise(pricing.freeAboveRupees) ? 0 : rupeesToPaise(pricing.feeRupees);
  return { subtotalPaise, deliveryFeePaise, totalPaise: subtotalPaise + deliveryFeePaise };
}

class NothingReserved extends Error {}

/**
 * Checks stock and holds it for every requested item in one transaction, so nobody else
 * can take the same packs in between. Items with no stock come back in `outOfStock`.
 * Returns order = null when nothing could be held.
 */
export async function createReservedOrder(
  db: DB,
  args: {
    customerId: number;
    channel: string;
    requests: CartRequest[];
    excluded: { name: string; reason: string }[];
    pricing: Pricing;
    stock: StockPolicy;
    ttlMinutes: number;
  },
): Promise<{ order: Order | null; outOfStock: Product[] }> {
  const day = zonedParts(args.stock.now, args.stock.timezone).ymd.replace(/-/g, "").slice(2);
  for (let attempt = 0; attempt < 5; attempt++) {
    const outOfStock: Product[] = [];
    try {
      const order = await db.transaction(async (tx) => {
        const prefix = `PB-${day}-`;
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(orders)
          .where(like(orders.id, `${prefix}%`))) as [{ n: number }];
        const id = `${prefix}${String(n + 1 + attempt).padStart(4, "0")}`;

        // The order row must exist before reservations can point at it.
        await tx.insert(orders).values({
          id,
          customerId: args.customerId,
          channel: args.channel,
          status: "reserved",
          lines: [],
          excluded: [],
          subtotalPaise: 0,
          deliveryFeePaise: 0,
          totalPaise: 0,
          createdAt: args.stock.now,
          updatedAt: args.stock.now,
        });

        const lines: OrderLine[] = [];
        for (const req of args.requests) {
          const before = (await availableMap(tx, args.stock, [req.product.sku])).get(req.product.sku) ?? 0;
          const granted = await reserveIn(tx, id, req.product.sku, req.qty, args.stock, args.ttlMinutes);
          if (granted === 0) {
            outOfStock.push(req.product);
            continue;
          }
          const notes = [...req.notes];
          if (granted < req.qty) notes.push(`Only ${before} in stock.`);
          lines.push({
            sku: req.product.sku,
            brand: req.product.brand,
            packLabel: req.product.pack.label,
            qty: granted,
            mrpPaise: req.product.mrpPaise,
            lineTotalPaise: req.product.mrpPaise * granted,
            note: notes.length ? notes.join(" ") : undefined,
          });
        }
        if (lines.length === 0) throw new NothingReserved();

        const [row] = await tx
          .update(orders)
          .set({
            lines,
            excluded: [...args.excluded, ...outOfStock.map((p) => ({ name: p.brand, reason: "Out of stock right now." }))],
            ...priceLines(lines, args.pricing),
          })
          .where(eq(orders.id, id))
          .returning();
        await tx.insert(orderEvents).values({ orderId: id, status: "reserved", at: args.stock.now });
        return row!;
      });
      return { order, outOfStock };
    } catch (err) {
      if (err instanceof NothingReserved) return { order: null, outOfStock };
      // Another order took the same ID at the same moment: try the next number.
      if ((err as { code?: string }).code === "23505" || /duplicate key/i.test(String((err as Error).message))) continue;
      throw err;
    }
  }
  throw new Error("Could not allocate an order ID");
}

export async function getOrder(db: DbOrTx, id: string | undefined): Promise<Order | undefined> {
  if (!id) return undefined;
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}

export async function updateOrder(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<Order, "id">>,
  event?: { status?: string; note?: string; userId?: number | null; at: Date },
): Promise<Order> {
  const [row] = await db
    .update(orders)
    .set({ ...patch, updatedAt: event?.at ?? new Date() })
    .where(eq(orders.id, id))
    .returning();
  if (!row) throw new Error(`Order ${id} not found`);
  if (event) {
    await db.insert(orderEvents).values({
      orderId: id,
      status: event.status ?? row.status,
      note: event.note ?? null,
      userId: event.userId ?? null,
      at: event.at,
    });
  }
  return row;
}

/** A confirmed order for the same items within the window, if any (for the duplicate warning). */
export async function recentSameOrder(
  db: DbOrTx,
  customerId: number,
  skus: string[],
  since: Date,
): Promise<Order | undefined> {
  const recent = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        inArray(orders.status, ["confirmed", "preparing", "out_for_delivery", "delivered"]),
        gte(orders.createdAt, since),
      ),
    )
    .orderBy(desc(orders.createdAt));
  const key = [...skus].sort().join(",");
  return recent.find((o) => o.lines.map((l) => l.sku).sort().join(",") === key);
}
