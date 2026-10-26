import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { customers, orderEvents, orders, users, type OrderStatus } from "../../db/schema.ts";
import type { AppContext } from "../context.ts";
import { badRequest, can, currentUser, forbidden, notFound, pageQuery, parse, requireAny } from "../http.ts";

const STATUSES = ["reserved", "awaiting_payment", "confirmed", "preparing", "out_for_delivery", "delivered", "cancelled", "expired"] as const;

export function orderRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/orders", { preHandler: requireAny("orders.view", "deliveries.own") }, async (req) => {
    const user = currentUser(req);
    const q = parse(
      pageQuery.extend({
        status: z.string().optional(), // comma-separated
        q: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        agentId: z.coerce.number().int().optional(),
        view: z.enum(["all", "active", "today"]).default("all"),
      }),
      req.query,
    );
    const where: (SQL | undefined)[] = [];
    // Delivery agents only ever see their own deliveries.
    if (!can(req, "orders.view")) where.push(eq(orders.agentId, user.id));
    else if (q.agentId) where.push(eq(orders.agentId, q.agentId));

    if (q.status) where.push(inArray(orders.status, q.status.split(",").filter((s): s is OrderStatus => (STATUSES as readonly string[]).includes(s))));
    if (q.view === "active") where.push(inArray(orders.status, ["confirmed", "preparing", "out_for_delivery"]));
    if (q.view === "today") where.push(gte(orders.createdAt, new Date(Date.now() - 24 * 3600_000)));
    if (q.from) where.push(gte(orders.createdAt, new Date(q.from)));
    if (q.to) where.push(lte(orders.createdAt, new Date(q.to)));
    if (q.q) where.push(or(ilike(orders.id, `%${q.q}%`), ilike(customers.name, `%${q.q}%`), ilike(customers.phone, `%${q.q}%`)));

    const cond = and(...where);
    const rows = await ctx.db
      .select({ order: orders, customerName: customers.name, customerPhone: customers.phone, channel: customers.channel, agentName: users.name })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(users, eq(orders.agentId, users.id))
      .where(cond)
      .orderBy(desc(orders.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ total }] = (await ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(cond)) as [{ total: number }];
    return { orders: rows.map((r) => ({ ...r.order, customerName: r.customerName, customerPhone: r.customerPhone, agentName: r.agentName })), total };
  });

  app.get("/api/orders/:id", { preHandler: requireAny("orders.view", "deliveries.own") }, async (req) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const [row] = await ctx.db
      .select({ order: orders, customer: customers, agentName: users.name, agentPhone: users.phone })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .leftJoin(users, eq(orders.agentId, users.id))
      .where(eq(orders.id, id));
    if (!row) throw notFound("Order not found");
    if (!can(req, "orders.view") && row.order.agentId !== user.id) throw forbidden();
    const events = await ctx.db
      .select({ event: orderEvents, userName: users.name })
      .from(orderEvents)
      .leftJoin(users, eq(orderEvents.userId, users.id))
      .where(eq(orderEvents.orderId, id))
      .orderBy(asc(orderEvents.at), asc(orderEvents.id));
    const c = row.customer;
    return {
      order: row.order,
      agent: row.order.agentId ? { id: row.order.agentId, name: row.agentName, phone: row.agentPhone } : null,
      // Agents get only what they need to deliver.
      customer: can(req, "customers.view")
        ? { id: c.id, name: c.name, phone: c.phone, channel: c.channel, address: c.address, pincode: c.pincode }
        : { name: c.name, phone: c.phone },
      events: events.map((e) => ({ ...e.event, userName: e.userName })),
    };
  });

  app.post("/api/orders/:id/assign", { preHandler: requireAny("orders.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const { agentId } = parse(z.object({ agentId: z.number().int().positive() }), req.body);
    const r = await ctx.engine.assignAgent(id, agentId, user.id);
    return { order: r.order, warning: r.notifyError ? `Done, but the customer couldn't be messaged: ${r.notifyError}` : null };
  });

  app.post("/api/orders/:id/status", { preHandler: requireAny("orders.manage", "deliveries.own") }, async (req) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const body = parse(z.object({ status: z.enum(STATUSES), note: z.string().max(500).optional() }), req.body);
    if (!can(req, "orders.manage")) {
      const [o] = await ctx.db.select({ agentId: orders.agentId }).from(orders).where(eq(orders.id, id));
      if (!o || o.agentId !== user.id) throw forbidden("This delivery isn't assigned to you");
      if (!["out_for_delivery", "delivered"].includes(body.status)) throw forbidden("Agents can only mark orders picked up or delivered");
    }
    if (body.status === "cancelled") throw badRequest("Use cancel to cancel an order");
    const r = await ctx.engine.setOrderStatus(id, body.status, user.id, body.note);
    return { order: r.order, warning: r.notifyError ? `Done, but the customer couldn't be messaged: ${r.notifyError}` : null };
  });

  app.post("/api/orders/:id/cancel", { preHandler: requireAny("orders.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().min(3).max(300) }), req.body);
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    if (!o) throw notFound("Order not found");
    if (o.paymentStatus === "paid" && !can(req, "orders.refund")) throw forbidden("This order was paid by UPI; cancelling it needs refund permission");
    const r = await ctx.engine.cancelOrder(id, user.id, reason);
    return { order: r.order, warning: r.notifyError ? `Cancelled, but the customer couldn't be messaged: ${r.notifyError}` : null };
  });
}
