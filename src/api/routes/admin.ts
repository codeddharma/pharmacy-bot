import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Permission } from "../../auth/permissions.ts";
import { auditLog, consultations, customers, orders, users } from "../../db/schema.ts";
import { audit } from "../../services/customers.ts";
import type { AppEvent } from "../../services/events.ts";
import { formatWhen, hoursText, shopStatus, zonedParts } from "../../services/hours.ts";
import { availableMap, expiryCutoff } from "../../services/inventory.ts";
import { SettingsSchema } from "../../services/settings.ts";
import type { AppContext } from "../context.ts";
import { currentUser, pageQuery, parse, requireAny, type AuthUser } from "../http.ts";

const SOLD = sql`('confirmed','preparing','out_for_delivery','delivered')`;

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? (r as Row[])) as Row[];

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---------------------------------------------------------------- settings and shop status

  app.get("/api/settings", { preHandler: requireAny() }, async () => ({ settings: await ctx.settings.get() }));

  app.put("/api/settings", { preHandler: requireAny("settings.manage") }, async (req) => {
    const user = currentUser(req);
    const next = parse(SettingsSchema, req.body);
    const saved = await ctx.settings.save(next, user.id);
    await audit(ctx.db, { action: "settings_updated", userId: user.id });
    ctx.bus.emit({ type: "settings.changed" });
    return { settings: saved };
  });

  const statusPayload = async () => {
    const s = await ctx.settings.get();
    const now = ctx.now?.() ?? new Date();
    const st = shopStatus(now, s.hours);
    const today = zonedParts(now, s.hours.timezone).weekday;
    return {
      open: st.open,
      reason: st.reason,
      override: s.hours.override,
      todayHours: hoursText(s.hours, today),
      closesAt: st.closesAt,
      nextOpenAt: st.nextOpenAt,
      nextOpenText: st.nextOpenAt ? formatWhen(st.nextOpenAt, now, s.hours.timezone) : null,
    };
  };

  app.get("/api/shop-status", { preHandler: requireAny() }, async () => statusPayload());

  app.post("/api/shop-status", { preHandler: requireAny("hours.toggle", "settings.manage") }, async (req) => {
    const user = currentUser(req);
    const { override } = parse(z.object({ override: z.enum(["auto", "open", "closed"]) }), req.body);
    const s = structuredClone(await ctx.settings.get());
    s.hours.override = override;
    await ctx.settings.save(s, user.id);
    await audit(ctx.db, { action: "hours_override", userId: user.id, data: { override } });
    ctx.bus.emit({ type: "settings.changed" });
    return statusPayload();
  });

  /** Counts for the sidebar badges. */
  app.get("/api/badges", { preHandler: requireAny() }, async (req) => {
    const u = currentUser(req);
    const has = (p: Permission) => u.permissions.includes(p);
    const [q] = has("consultations.view")
      ? ((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(consultations).where(eq(consultations.status, "open"))) as [{ n: number }])
      : [{ n: 0 }];
    const [m] = has("inbox.view")
      ? ((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(customers).where(sql`${customers.unread} > 0`)) as [{ n: number }])
      : [{ n: 0 }];
    const [o] = has("orders.view")
      ? ((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(sql`${orders.status} = 'confirmed' and ${orders.agentId} is null`)) as [{ n: number }])
      : [{ n: 0 }];
    return { openQuestions: q.n, unreadChats: m.n, unassignedOrders: o.n };
  });

  // ---------------------------------------------------------------- statistics

  app.get("/api/stats", { preHandler: requireAny("stats.view") }, async (req) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(7) }), req.query);
    const s = await ctx.settings.get();
    const tz = s.hours.timezone;
    const now = ctx.now?.() ?? new Date();
    const since = new Date(now.getTime() - days * 86_400_000);
    const todayYmd = zonedParts(now, tz).ymd;

    const series = rowsOf(
      await ctx.db.execute(sql`
        select to_char((${orders.createdAt} at time zone ${tz})::date, 'YYYY-MM-DD') as day,
               count(*)::int as orders,
               coalesce(sum(${orders.totalPaise}), 0)::int as revenue
        from ${orders}
        where ${orders.status} in ${SOLD} and ${orders.createdAt} >= ${since}
        group by 1 order by 1`),
    );
    const byDay = new Map(series.map((r) => [String(r.day), r]));
    const filled = Array.from({ length: days }, (_, i) => {
      const ymd = zonedParts(new Date(now.getTime() - (days - 1 - i) * 86_400_000), tz).ymd;
      const r = byDay.get(ymd);
      return { day: ymd, orders: Number(r?.orders ?? 0), revenuePaise: Number(r?.revenue ?? 0) };
    });
    const today = filled.find((d) => d.day === todayYmd) ?? { orders: 0, revenuePaise: 0 };
    const totalOrders = filled.reduce((a, d) => a + d.orders, 0);
    const totalRevenue = filled.reduce((a, d) => a + d.revenuePaise, 0);

    const byStatus = rowsOf(
      await ctx.db.execute(sql`select ${orders.status} as status, count(*)::int as n from ${orders} where ${orders.createdAt} >= ${since} group by 1`),
    ).map((r) => ({ status: String(r.status), count: Number(r.n) }));

    const topProducts = rowsOf(
      await ctx.db.execute(sql`
        select l->>'sku' as sku, max(l->>'brand') as brand, sum((l->>'qty')::int)::int as qty, sum((l->>'lineTotalPaise')::int)::int as revenue
        from ${orders}, jsonb_array_elements(${orders.lines}) l
        where ${orders.status} in ${SOLD} and ${orders.createdAt} >= ${since}
        group by 1 order by qty desc limit 8`),
    ).map((r) => ({ sku: String(r.sku), brand: String(r.brand), qty: Number(r.qty), revenuePaise: Number(r.revenue) }));

    const payment = rowsOf(
      await ctx.db.execute(sql`select coalesce(${orders.paymentMethod}, 'none') as method, count(*)::int as n from ${orders} where ${orders.status} in ${SOLD} and ${orders.createdAt} >= ${since} group by 1`),
    ).map((r) => ({ method: String(r.method), count: Number(r.n) }));

    const [refused] = rowsOf(
      await ctx.db.execute(sql`select count(*)::int as n from ${auditLog} where ${auditLog.action} = 'item_refused' and ${auditLog.data}->>'code' = 'prescription' and ${auditLog.at} >= ${since}`),
    );
    const waitlistDemand = rowsOf(
      await ctx.db.execute(sql`select w.sku, p.brand, count(*)::int as n from waitlist w join products p on p.sku = w.sku group by 1, 2 order by n desc limit 5`),
    ).map((r) => ({ sku: String(r.sku), brand: String(r.brand), waiting: Number(r.n) }));

    const [answerTime] = rowsOf(
      await ctx.db.execute(sql`select avg(extract(epoch from (${consultations.answeredAt} - ${consultations.createdAt})) / 60)::float as mins, count(*)::int as n from ${consultations} where ${consultations.answeredAt} is not null and ${consultations.createdAt} >= ${since}`),
    );
    const [deliveryTime] = rowsOf(
      await ctx.db.execute(sql`
        select avg(extract(epoch from (d.at - c.at)) / 60)::float as mins, count(*)::int as n
        from order_events d join order_events c on c.order_id = d.order_id and c.status = 'confirmed'
        where d.status = 'delivered' and d.at >= ${since}`),
    );
    const agents = rowsOf(
      await ctx.db.execute(sql`
        select u.name, count(*)::int as delivered
        from ${orders} o join ${users} u on u.id = o.agent_id
        where o.status = 'delivered' and o.updated_at >= ${since}
        group by u.name order by delivered desc limit 8`),
    ).map((r) => ({ name: String(r.name), delivered: Number(r.delivered) }));

    const policy = { now, nearExpiryDays: s.inventory.nearExpiryDays, timezone: tz };
    const avail = await availableMap(ctx.db, policy);
    let low = 0;
    let out = 0;
    for (const p of ctx.catalogue.products) {
      if (!p.active || p.schedule === "X") continue;
      const a = avail.get(p.sku) ?? 0;
      if (a === 0) out++;
      else if (a <= p.reorderLevel) low++;
    }
    const [near] = rowsOf(
      await ctx.db.execute(sql`select count(distinct sku)::int as n from batches where qty > 0 and exp <= ${expiryCutoff(policy)}`),
    );
    const [active] = rowsOf(await ctx.db.execute(sql`select count(*)::int as n from ${orders} where ${orders.status} in ('confirmed','preparing','out_for_delivery')`));
    const [openQ] = rowsOf(await ctx.db.execute(sql`select count(*)::int as n from ${consultations} where ${consultations.status} = 'open'`));
    const [newCustomers] = rowsOf(await ctx.db.execute(sql`select count(*)::int as n from ${customers} where ${customers.createdAt} >= ${since}`));

    return {
      days,
      kpis: {
        ordersToday: today.orders,
        revenueTodayPaise: today.revenuePaise,
        orders: totalOrders,
        revenuePaise: totalRevenue,
        avgOrderPaise: totalOrders ? Math.round(totalRevenue / totalOrders) : 0,
        activeOrders: Number(active?.n ?? 0),
        openQuestions: Number(openQ?.n ?? 0),
        newCustomers: Number(newCustomers?.n ?? 0),
        refusedPrescriptionItems: Number(refused?.n ?? 0),
        avgAnswerMinutes: answerTime?.mins == null ? null : Math.round(Number(answerTime.mins)),
        avgDeliveryMinutes: deliveryTime?.mins == null ? null : Math.round(Number(deliveryTime.mins)),
        lowStock: low,
        outOfStock: out,
        nearExpiry: Number(near?.n ?? 0),
      },
      series: filled,
      byStatus,
      topProducts,
      payment,
      waitlistDemand,
      agents,
    };
  });

  // ---------------------------------------------------------------- activity log

  app.get("/api/audit", { preHandler: requireAny("audit.view") }, async (req) => {
    const q = parse(pageQuery.extend({ action: z.string().optional(), userId: z.coerce.number().int().optional() }), req.query);
    const rows = await ctx.db
      .select({ a: auditLog, userName: users.name, customerName: customers.name })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .leftJoin(customers, eq(auditLog.customerId, customers.id))
      .where(and(q.action ? eq(auditLog.action, q.action) : undefined, q.userId ? eq(auditLog.userId, q.userId) : undefined))
      .orderBy(desc(auditLog.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return { entries: rows.map((r) => ({ ...r.a, userName: r.userName, customerName: r.customerName })) };
  });

  // ---------------------------------------------------------------- live updates (server-sent events)

  app.get("/api/events", { preHandler: requireAny() }, async (req, reply) => {
    const user = currentUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // tell Nginx not to buffer the stream
    });
    res.write(`retry: 5000\n\n`);
    const off = ctx.bus.on((event) => {
      if (allowed(user, event)) res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      off();
    });
  });
}

function allowed(u: AuthUser, e: AppEvent): boolean {
  const has = (p: Permission) => u.permissions.includes(p);
  switch (e.type) {
    case "order.created":
    case "order.updated":
      return has("orders.view") || (has("deliveries.own") && e.agentId === u.id);
    case "message.in":
    case "message.out":
      return has("inbox.view");
    case "consultation.created":
    case "consultation.updated":
    case "consultation.escalated":
      return has("consultations.view");
    case "stock.changed":
    case "catalogue.changed":
      return has("inventory.view");
    case "settings.changed":
      return true;
  }
}
