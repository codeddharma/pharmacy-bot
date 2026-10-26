import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { batches, interactionRules, orders, products } from "../../db/schema.ts";
import { audit } from "../../services/customers.ts";
import { availableMap, expiryCutoff } from "../../services/inventory.ts";
import { rupeesToPaise } from "../../types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, currentUser, idParam, notFound, parse, requireAny } from "../http.ts";

const ym = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM");
const monthEnd = (v: string) => {
  const [y, m] = v.split("-").map(Number) as [number, number];
  return `${v}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

const ProductBody = z.object({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9.-]{1,40}$/, "Capital letters, digits, dots and dashes"),
  brand: z.string().min(1),
  generic: z.string().min(1),
  composition: z.array(z.object({ name: z.string().min(1), strength: z.string().nullable() })).min(1),
  form: z.string().min(1),
  pack: z.object({ size: z.number().positive(), unit: z.string().min(1), label: z.string().min(1) }),
  manufacturer: z.string().min(1),
  category: z.string().min(1),
  system: z.enum(["allopathy", "ayurveda", "herbal", "homeopathy", "unani", "other"]),
  schedule: z.enum(["OTC", "G", "H", "H1", "X"]),
  maxPacksPerOrder: z.number().int().min(0),
  mrp: z.number().nonnegative(),
  aliases: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  verifiedPrice: z.boolean().default(false),
  verifiedSchedule: z.boolean().default(false),
  notes: z.string().nullable().default(null),
  replacedBy: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  active: z.boolean().default(true),
  reorderLevel: z.number().int().min(0).default(0),
  rack: z.string().nullable().default(null),
  manualHold: z.number().int().min(0).default(0),
});

function toRow(b: Partial<z.infer<typeof ProductBody>>) {
  const { mrp, ...rest } = b;
  return {
    ...rest,
    ...(mrp !== undefined ? { mrpPaise: rupeesToPaise(mrp) } : {}),
    ...(b.schedule ? { rxRequired: b.schedule !== "OTC" } : {}),
    updatedAt: new Date(),
  };
}

const BatchBody = z.object({
  batchNo: z.string().min(1).max(40),
  mfg: ym,
  exp: ym,
  qty: z.number().int().min(0),
});

export function catalogueRoutes(app: FastifyInstance, ctx: AppContext) {
  const policy = async () => {
    const s = await ctx.settings.get();
    return { now: ctx.now?.() ?? new Date(), nearExpiryDays: s.inventory.nearExpiryDays, timezone: s.hours.timezone };
  };
  const changed = async (sku?: string) => {
    await ctx.catalogue.load();
    ctx.bus.emit({ type: "catalogue.changed" });
    if (sku) ctx.bus.emit({ type: "stock.changed", sku });
  };

  app.get("/api/products", { preHandler: requireAny("inventory.view") }, async (req) => {
    const q = parse(z.object({ q: z.string().optional(), stock: z.enum(["all", "low", "out", "expiring"]).default("all") }), req.query);
    const p = await policy();
    const avail = await availableMap(ctx.db, p);
    const cutoff = expiryCutoff(p);
    const nearRows = await ctx.db
      .select({ sku: batches.sku, qty: sql<number>`sum(${batches.qty})::int` })
      .from(batches)
      .where(and(sql`${batches.exp} <= ${cutoff}`, sql`${batches.qty} > 0`))
      .groupBy(batches.sku);
    const nearExpiry = new Map(nearRows.map((r) => [r.sku, r.qty]));

    let rows = ctx.catalogue.products.map((pr) => {
      const a = avail.get(pr.sku) ?? 0;
      return {
        ...pr,
        available: a,
        nearExpiryPacks: nearExpiry.get(pr.sku) ?? 0,
        stockStatus: a === 0 ? "out" : a <= pr.reorderLevel ? "low" : "ok",
      };
    });
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((r) =>
        [r.sku, r.brand, r.generic, r.manufacturer, ...r.aliases].some((f) => f.toLowerCase().includes(needle)),
      );
    }
    if (q.stock === "low") rows = rows.filter((r) => r.active && r.stockStatus !== "ok");
    if (q.stock === "out") rows = rows.filter((r) => r.active && r.stockStatus === "out");
    if (q.stock === "expiring") rows = rows.filter((r) => r.nearExpiryPacks > 0);
    return { products: rows };
  });

  app.get("/api/products/:sku", { preHandler: requireAny("inventory.view") }, async (req) => {
    const { sku } = req.params as { sku: string };
    const product = ctx.catalogue.get(sku);
    if (!product) throw notFound("Medicine not found");
    const p = await policy();
    const rows = await ctx.db.select().from(batches).where(eq(batches.sku, sku)).orderBy(asc(batches.exp));
    const cutoff = expiryCutoff(p);
    return {
      product,
      available: (await availableMap(ctx.db, p, [sku])).get(sku) ?? 0,
      batches: rows.map((b) => ({ ...b, sellable: b.exp > cutoff })),
    };
  });

  app.post("/api/products", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const body = parse(ProductBody, req.body);
    if (ctx.catalogue.get(body.sku)) throw badRequest(`SKU ${body.sku} already exists`);
    await ctx.db.insert(products).values({ ...toRow(body), sku: body.sku } as typeof products.$inferInsert);
    await audit(ctx.db, { action: "product_created", userId: user.id, entity: "product", entityId: body.sku });
    await changed(body.sku);
    return { product: ctx.catalogue.get(body.sku) };
  });

  app.patch("/api/products/:sku", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { sku } = req.params as { sku: string };
    if (!ctx.catalogue.get(sku)) throw notFound("Medicine not found");
    const body = parse(ProductBody.partial().omit({ sku: true }), req.body);
    await ctx.db.update(products).set(toRow(body)).where(eq(products.sku, sku));
    await audit(ctx.db, { action: "product_updated", userId: user.id, entity: "product", entityId: sku, data: body });
    await changed(sku);
    return { product: ctx.catalogue.get(sku) };
  });

  /** Deletes a medicine that has never been ordered; otherwise marks it discontinued so order history stays intact. */
  app.delete("/api/products/:sku", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { sku } = req.params as { sku: string };
    if (!ctx.catalogue.get(sku)) throw notFound("Medicine not found");
    const [used] = await ctx.db
      .select({ id: orders.id })
      .from(orders)
      .where(sql`${orders.lines} @> ${JSON.stringify([{ sku }])}::jsonb`)
      .limit(1);
    if (used) {
      await ctx.db.update(products).set({ active: false, updatedAt: new Date() }).where(eq(products.sku, sku));
    } else {
      await ctx.db.delete(products).where(eq(products.sku, sku));
    }
    await audit(ctx.db, { action: used ? "product_discontinued" : "product_deleted", userId: user.id, entity: "product", entityId: sku });
    await changed(sku);
    return { deleted: !used, discontinued: !!used };
  });

  // ---- batches

  app.post("/api/products/:sku/batches", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { sku } = req.params as { sku: string };
    if (!ctx.catalogue.get(sku)) throw notFound("Medicine not found");
    const b = parse(BatchBody, req.body);
    if (b.exp < b.mfg) throw badRequest("Expiry is before manufacture");
    const [existing] = await ctx.db.select().from(batches).where(and(eq(batches.sku, sku), eq(batches.batchNo, b.batchNo)));
    if (existing && existing.exp.slice(0, 7) !== b.exp) throw badRequest(`Batch ${b.batchNo} already exists with expiry ${existing.exp.slice(0, 7)}`);
    if (existing) {
      await ctx.db.update(batches).set({ qty: existing.qty + b.qty }).where(eq(batches.id, existing.id));
    } else {
      await ctx.db.insert(batches).values({ sku, batchNo: b.batchNo, mfg: `${b.mfg}-01`, exp: monthEnd(b.exp), qty: b.qty });
    }
    await audit(ctx.db, { action: "stock_added", userId: user.id, entity: "product", entityId: sku, data: b });
    ctx.bus.emit({ type: "stock.changed", sku });
    const notified = await ctx.engine.notifyBackInStock(sku);
    return { ok: true, notified };
  });

  app.patch("/api/batches/:id", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(BatchBody.partial(), req.body);
    const [row] = await ctx.db
      .update(batches)
      .set({
        ...(body.batchNo ? { batchNo: body.batchNo } : {}),
        ...(body.mfg ? { mfg: `${body.mfg}-01` } : {}),
        ...(body.exp ? { exp: monthEnd(body.exp) } : {}),
        ...(body.qty !== undefined ? { qty: body.qty } : {}),
      })
      .where(eq(batches.id, id))
      .returning();
    if (!row) throw notFound("Batch not found");
    await audit(ctx.db, { action: "batch_updated", userId: user.id, entity: "batch", entityId: String(id), data: body });
    ctx.bus.emit({ type: "stock.changed", sku: row.sku });
    if (body.qty) await ctx.engine.notifyBackInStock(row.sku);
    return { batch: row };
  });

  app.delete("/api/batches/:id", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const [row] = await ctx.db.delete(batches).where(eq(batches.id, id)).returning();
    if (!row) throw notFound("Batch not found");
    await audit(ctx.db, { action: "batch_deleted", userId: user.id, entity: "batch", entityId: String(id), data: { sku: row.sku, batchNo: row.batchNo, qty: row.qty } });
    ctx.bus.emit({ type: "stock.changed", sku: row.sku });
    return { ok: true };
  });

  // ---- interaction rules (maintained by pharmacists)

  const RuleBody = z.object({
    ingredientA: z.string().min(2).transform((s) => s.toLowerCase().trim()),
    ingredientB: z.string().min(2).transform((s) => s.toLowerCase().trim()),
    message: z.string().min(5),
    severity: z.enum(["warn", "block"]),
    active: z.boolean().default(true),
  });

  app.get("/api/interactions", { preHandler: requireAny("inventory.view") }, async () => ({
    rules: await ctx.db.select().from(interactionRules).orderBy(asc(interactionRules.ingredientA)),
  }));

  app.post("/api/interactions", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const body = parse(RuleBody, req.body);
    const [rule] = await ctx.db.insert(interactionRules).values({ ...body, createdBy: user.id }).returning();
    await audit(ctx.db, { action: "interaction_rule_created", userId: user.id, entity: "interaction_rule", entityId: String(rule!.id), data: body });
    return { rule };
  });

  app.patch("/api/interactions/:id", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(RuleBody.partial(), req.body);
    const [rule] = await ctx.db.update(interactionRules).set(body).where(eq(interactionRules.id, id)).returning();
    if (!rule) throw notFound("Rule not found");
    await audit(ctx.db, { action: "interaction_rule_updated", userId: user.id, entity: "interaction_rule", entityId: String(id), data: body });
    return { rule };
  });

  app.delete("/api/interactions/:id", { preHandler: requireAny("inventory.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    await ctx.db.delete(interactionRules).where(eq(interactionRules.id, id));
    await audit(ctx.db, { action: "interaction_rule_deleted", userId: user.id, entity: "interaction_rule", entityId: String(id) });
    return { ok: true };
  });
}
