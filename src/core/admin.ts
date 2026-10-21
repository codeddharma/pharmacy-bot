import type { Config } from "../config.ts";
import type { CatalogueStore } from "../store/catalogue.ts";
import type { Store } from "../store/db.ts";
import type { OutboundMessage } from "../types.ts";
import type { Notifier } from "./engine.ts";
import { rupees } from "./format.ts";
import { addStock, available, sellableBatches } from "./inventory.ts";
import type { Matcher } from "./matcher.ts";

export function isAdmin(userId: string, config: Config): boolean {
  const id = userId.split(":")[1];
  return !!id && config.adminChatIds.includes(id);
}

interface AdminContext {
  store: Store;
  catalogue: CatalogueStore;
  matcher: Matcher;
  notifier: Notifier;
  now: Date;
}

const ADMIN_HELP =
  "Admin commands:\n" +
  "/stock <name or SKU>: stock and batches\n" +
  "/lowstock: items at or below reorder level\n" +
  "/addstock <SKU> <qty> <batch> <exp YYYY-MM> [mfg YYYY-MM]\n" +
  "/orders: last 10 orders\n" +
  "/reload: reload catalogue.json";

/** Returns null when the text isn't an admin command. */
export async function adminCommand(ctx: AdminContext, text: string): Promise<OutboundMessage[] | null> {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd?.toLowerCase()) {
    case "/adminhelp":
      return [{ text: ADMIN_HELP }];
    case "/stock":
      return [{ text: stockReport(ctx, args.join(" ")) }];
    case "/lowstock":
      return [{ text: lowStockReport(ctx) }];
    case "/addstock":
      return [{ text: await addStockCommand(ctx, args) }];
    case "/orders":
      return [{ text: ordersReport(ctx) }];
    case "/reload": {
      const r = ctx.catalogue.reload();
      return [{ text: r.ok ? `Reloaded ${r.count} products.` : `Reload failed, keeping the old catalogue:\n${r.error}` }];
    }
  }
  return null;
}

function stockReport(ctx: AdminContext, query: string): string {
  if (!query) return "Usage: /stock <name or SKU>";
  const skus = ctx.catalogue.get(query.toUpperCase()) ? [query.toUpperCase()] : ctx.matcher.match(query).candidates;
  if (skus.length === 0) return `Nothing matches "${query}".`;

  const nearDays = ctx.store.inventory.data.meta.near_expiry_days;
  return skus
    .map((sku) => {
      const p = ctx.catalogue.get(sku)!;
      const item = ctx.store.inventory.data.items[sku];
      if (!item) return `${sku} ${p.brand}: not in inventory.json`;
      const sellable = new Set(sellableBatches(item, ctx.now, nearDays).map((b) => b.batch));
      const batches = item.batches
        .map((b) => `   ${b.batch} exp ${b.exp}: ${b.qty}${sellable.has(b.batch) || b.qty === 0 ? "" : " (near expiry, not sold)"}`)
        .join("\n");
      return (
        `${sku}: ${p.brand} (${p.pack.label}), ${rupees(p.mrp)}, schedule ${p.schedule}${p.active ? "" : ", discontinued"}\n` +
        `   available ${available(ctx.store, sku, ctx.now)}, reserved ${item.reserved}, reorder at ${item.reorder_level}, rack ${item.rack ?? "-"}\n` +
        (batches || "   no batches")
      );
    })
    .join("\n\n");
}

function lowStockReport(ctx: AdminContext): string {
  const rows = Object.entries(ctx.store.inventory.data.items)
    .map(([sku, item]) => ({ sku, item, p: ctx.catalogue.get(sku), avail: available(ctx.store, sku, ctx.now) }))
    .filter((r) => r.p?.active && r.p.schedule !== "X" && r.avail <= r.item.reorder_level)
    .sort((a, b) => a.avail - b.avail);
  if (rows.length === 0) return "Nothing is at or below its reorder level.";
  return "Low stock:\n" + rows.map((r) => `• ${r.sku}: ${r.avail} available (reorder at ${r.item.reorder_level})`).join("\n");
}

async function addStockCommand(ctx: AdminContext, args: string[]): Promise<string> {
  const [skuRaw, qtyRaw, batch, exp, mfg] = args;
  const sku = skuRaw?.toUpperCase();
  const qty = Number(qtyRaw);
  if (!sku || !batch || !exp || !Number.isInteger(qty) || qty <= 0 || !/^\d{4}-\d{2}$/.test(exp) || (mfg && !/^\d{4}-\d{2}$/.test(mfg))) {
    return "Usage: /addstock <SKU> <qty> <batch> <exp YYYY-MM> [mfg YYYY-MM]\nExample: /addstock OTRIVIN-OXY-10ML 20 OTX6J001 2028-09";
  }
  const product = ctx.catalogue.get(sku);
  if (!product) return `Unknown SKU ${sku}.`;

  const result = await addStock(ctx.store, sku, { batch, exp, mfg: mfg ?? ctx.now.toISOString().slice(0, 7), qty });
  if (!result.ok) return result.error;
  await ctx.store.audit("stock_added", null, { sku, qty, batch, exp });

  const waiting = ctx.store.waitlist.data.filter((w) => w.sku === sku);
  let notified = 0;
  if (waiting.length > 0 && available(ctx.store, sku, ctx.now) > 0) {
    for (const w of waiting) {
      await ctx.notifier.toUser(w.userId, [{ text: `Good news: ${product.brand} is back in stock. Send "${product.brand}" to order it.` }]);
      notified++;
    }
    await ctx.store.withLock(async () => {
      ctx.store.waitlist.data = ctx.store.waitlist.data.filter((w) => w.sku !== sku);
      await ctx.store.waitlist.write();
    });
  }
  return `Added ${qty} of ${sku} (batch ${batch}, exp ${exp}). Now ${available(ctx.store, sku, ctx.now)} available.` +
    (notified ? ` Told ${notified} waiting customer${notified > 1 ? "s" : ""}.` : "");
}

function ordersReport(ctx: AdminContext): string {
  const recent = ctx.store.orders.data.slice(-10).reverse();
  if (recent.length === 0) return "No orders yet.";
  return recent
    .map((o) => `${o.id} ${o.status}: ${rupees(o.total)}, ${o.lines.map((l) => `${l.brand} × ${l.qty}`).join(", ")}`)
    .join("\n");
}
