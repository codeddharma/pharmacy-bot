import type { Store } from "../store/db.ts";
import type { Order, OrderLine, OrderStatus, Product } from "../types.ts";
import { availableIn, reserveIn } from "./inventory.ts";

export interface CartRequest {
  product: Product;
  qty: number;
  notes: string[];
}

export interface Pricing {
  deliveryFee: number;
  freeDeliveryAbove: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function priceLines(lines: OrderLine[], pricing: Pricing) {
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const deliveryFee = lines.length === 0 || subtotal >= pricing.freeDeliveryAbove ? 0 : pricing.deliveryFee;
  return { subtotal, deliveryFee, total: round2(subtotal + deliveryFee) };
}

function nextOrderId(store: Store, now: Date): string {
  const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const prefix = `PB-${day}-`;
  const count = store.orders.data.filter((o) => o.id.startsWith(prefix)).length;
  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

/**
 * Checks stock and holds it for every requested item in one step, so nobody else can
 * take the same packs in between. Items with no stock come back in `outOfStock`.
 * Returns order = null when nothing could be held.
 */
export async function createReservedOrder(
  store: Store,
  args: {
    userId: string;
    channel: string;
    requests: CartRequest[];
    excluded: { name: string; reason: string }[];
    pricing: Pricing;
    now: Date;
    ttlMinutes: number;
  },
): Promise<{ order: Order | null; outOfStock: Product[] }> {
  return store.withLock(async () => {
    const { now } = args;
    const id = nextOrderId(store, now);
    const lines: OrderLine[] = [];
    const outOfStock: Product[] = [];

    for (const req of args.requests) {
      const before = availableIn(store.inventory.data, req.product.sku, now);
      const granted = reserveIn(store, id, req.product.sku, req.qty, now, args.ttlMinutes);
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
        mrp: req.product.mrp,
        lineTotal: round2(req.product.mrp * granted),
        note: notes.length ? notes.join(" ") : undefined,
      });
    }

    if (lines.length === 0) return { order: null, outOfStock };

    const order: Order = {
      id,
      userId: args.userId,
      channel: args.channel,
      status: "reserved",
      lines,
      excluded: [...args.excluded, ...outOfStock.map((p) => ({ name: p.brand, reason: "Out of stock right now." }))],
      ...priceLines(lines, args.pricing),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    store.orders.data.push(order);
    await Promise.all([store.orders.write(), store.inventory.write(), store.reservations.write()]);
    return { order, outOfStock };
  });
}

export function getOrder(store: Store, id: string | undefined): Order | undefined {
  return id ? store.orders.data.find((o) => o.id === id) : undefined;
}

export async function updateOrder(store: Store, id: string, patch: Partial<Order> & { status?: OrderStatus }, now: Date) {
  return store.withLock(async () => {
    const order = store.orders.data.find((o) => o.id === id);
    if (!order) throw new Error(`Order ${id} not found`);
    Object.assign(order, patch, { updatedAt: now.toISOString() });
    await store.orders.write();
    return order;
  });
}

export const OPEN_STATUSES: OrderStatus[] = ["reserved", "awaiting_payment"];
