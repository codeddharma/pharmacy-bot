import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ALL_PERMISSIONS, effectivePermissions, isPermission, PERMISSIONS, type Permission } from "../../auth/permissions.ts";
import { hashPassword } from "../../auth/password.ts";
import { authSessions, consultations, customers, orders, roles, users } from "../../db/schema.ts";
import { audit } from "../../services/customers.ts";
import type { AppContext } from "../context.ts";
import { badRequest, can, currentUser, forbidden, idParam, notFound, pageQuery, parse, requireAny } from "../http.ts";

const permissionList = z.array(z.string().refine(isPermission, "Unknown permission")).transform((l) => l as Permission[]);

const publicUser = (u: typeof users.$inferSelect, role?: typeof roles.$inferSelect) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  roleId: u.roleId,
  roleKey: role?.key,
  roleName: role?.name,
  grantPermissions: u.grantPermissions,
  denyPermissions: u.denyPermissions,
  permissions: role ? effectivePermissions(role.permissions, u.grantPermissions, u.denyPermissions) : [],
  vehicle: u.vehicle,
  telegramChatId: u.telegramChatId,
  onDuty: u.onDuty,
  isActive: u.isActive,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

export function peopleRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---------------------------------------------------------------- customers

  app.get("/api/customers", { preHandler: requireAny("customers.view") }, async (req) => {
    const q = parse(pageQuery.extend({ q: z.string().optional() }), req.query);
    const cond = q.q
      ? or(ilike(customers.name, `%${q.q}%`), ilike(customers.phone, `%${q.q}%`), ilike(customers.pincode, `%${q.q}%`))
      : undefined;
    const rows = await ctx.db
      .select({
        customer: customers,
        // Sub-queries spell out table names: Drizzle prints bare column names inside sql``,
        // and a bare "id" would resolve to the inner table's id.
        orderCount: sql<number>`(select count(*)::int from orders o where o.customer_id = customers.id and o.status in ('confirmed','preparing','out_for_delivery','delivered'))`,
        spentPaise: sql<number>`(select coalesce(sum(o.total_paise),0)::int from orders o where o.customer_id = customers.id and o.status in ('confirmed','preparing','out_for_delivery','delivered'))`,
      })
      .from(customers)
      .where(cond)
      .orderBy(desc(sql`coalesce(${customers.lastMessageAt}, ${customers.createdAt})`))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ total }] = (await ctx.db.select({ total: sql<number>`count(*)::int` }).from(customers).where(cond)) as [{ total: number }];
    return {
      customers: rows.map((r) => ({ ...stripBotState(r.customer), orderCount: r.orderCount, spentPaise: r.spentPaise })),
      total,
    };
  });

  app.get("/api/customers/:id", { preHandler: requireAny("customers.view") }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [c] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!c) throw notFound("Customer not found");
    const recentOrders = await ctx.db.select().from(orders).where(eq(orders.customerId, id)).orderBy(desc(orders.createdAt)).limit(20);
    const questions = await ctx.db.select().from(consultations).where(eq(consultations.customerId, id)).orderBy(desc(consultations.createdAt)).limit(20);
    return { customer: stripBotState(c), orders: recentOrders, consultations: questions };
  });

  app.patch("/api/customers/:id", { preHandler: requireAny("customers.manage") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: z.string().min(1).nullable().optional(),
        phone: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        pincode: z.string().regex(/^[1-9]\d{5}$/).nullable().optional(),
        blocked: z.boolean().optional(),
      }),
      req.body,
    );
    const [c] = await ctx.db.update(customers).set(body).where(eq(customers.id, id)).returning();
    if (!c) throw notFound("Customer not found");
    await audit(ctx.db, { action: "customer_updated", userId: user.id, customerId: id, data: body });
    return { customer: stripBotState(c) };
  });

  // ---------------------------------------------------------------- staff and agents

  app.get("/api/users", { preHandler: requireAny("users.manage") }, async () => {
    const rows = await ctx.db.select({ u: users, r: roles }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).orderBy(asc(users.name));
    return { users: rows.map((r) => publicUser(r.u, r.r)) };
  });

  app.get("/api/agents", { preHandler: requireAny("orders.view", "orders.manage") }, async () => {
    const dayAgo = new Date((ctx.now?.() ?? new Date()).getTime() - 86_400_000);
    const rows = await ctx.db
      .select({
        u: users,
        active: sql<number>`(select count(*)::int from orders o where o.agent_id = users.id and o.status in ('confirmed','preparing','out_for_delivery'))`,
        deliveredToday: sql<number>`(select count(*)::int from orders o where o.agent_id = users.id and o.status = 'delivered' and o.updated_at > ${dayAgo})`,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(roles.key, "delivery_agent"), eq(users.isActive, true)))
      .orderBy(asc(users.name));
    return {
      agents: rows.map((r) => ({ id: r.u.id, name: r.u.name, phone: r.u.phone, vehicle: r.u.vehicle, onDuty: r.u.onDuty, activeOrders: r.active, deliveredToday: r.deliveredToday })),
    };
  });

  const UserBody = z.object({
    name: z.string().min(2),
    email: z.string().email().transform((e) => e.toLowerCase()),
    phone: z.string().nullable().default(null),
    password: z.string().min(8, "Use at least 8 characters"),
    roleId: z.number().int().positive(),
    vehicle: z.string().nullable().default(null),
    telegramChatId: z.string().regex(/^-?\d+$/).nullable().default(null),
    grantPermissions: permissionList.default([]),
    denyPermissions: permissionList.default([]),
  });

  app.post("/api/users", { preHandler: requireAny("users.manage") }, async (req) => {
    const me = currentUser(req);
    const { password, ...body } = parse(UserBody, req.body);
    const [exists] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (exists) throw badRequest("Someone already uses that email");
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, body.roleId));
    if (!role) throw badRequest("Unknown role");
    const [u] = await ctx.db.insert(users).values({ ...body, passwordHash: await hashPassword(password) }).returning();
    await audit(ctx.db, { action: "user_created", userId: me.id, entity: "user", entityId: String(u!.id), data: { email: body.email, role: role.key } });
    return { user: publicUser(u!, role) };
  });

  app.patch("/api/users/:id", { preHandler: requireAny("users.manage") }, async (req) => {
    const me = currentUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(UserBody.omit({ password: true }).partial().extend({ isActive: z.boolean().optional(), onDuty: z.boolean().optional() }), req.body);
    if (id === me.id && (body.isActive === false || body.roleId !== undefined)) {
      throw badRequest("You can't deactivate yourself or change your own role");
    }
    if (body.email) {
      const [exists] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.email, body.email), ne(users.id, id)));
      if (exists) throw badRequest("Someone already uses that email");
    }
    const [u] = await ctx.db.update(users).set(body).where(eq(users.id, id)).returning();
    if (!u) throw notFound("User not found");
    if (body.isActive === false) await ctx.db.delete(authSessions).where(eq(authSessions.userId, id));
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, u.roleId));
    await audit(ctx.db, { action: "user_updated", userId: me.id, entity: "user", entityId: String(id), data: body });
    return { user: publicUser(u, role) };
  });

  app.post("/api/users/:id/password", { preHandler: requireAny("users.manage") }, async (req) => {
    const me = currentUser(req);
    const { id } = parse(idParam, req.params);
    const { password } = parse(z.object({ password: z.string().min(8, "Use at least 8 characters") }), req.body);
    const [u] = await ctx.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, id)).returning();
    if (!u) throw notFound("User not found");
    await ctx.db.delete(authSessions).where(eq(authSessions.userId, id));
    await audit(ctx.db, { action: "user_password_reset", userId: me.id, entity: "user", entityId: String(id) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- roles and permissions

  app.get("/api/permissions", { preHandler: requireAny() }, async () => ({
    permissions: ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSIONS[key] })),
  }));

  app.get("/api/roles", { preHandler: requireAny("roles.manage", "users.manage") }, async () => {
    const rows = await ctx.db
      .select({ r: roles, users: sql<number>`(select count(*)::int from users u where u.role_id = roles.id)` })
      .from(roles)
      .orderBy(asc(roles.id));
    return { roles: rows.map((x) => ({ ...x.r, userCount: x.users })) };
  });

  const RoleBody = z.object({
    name: z.string().min(2),
    description: z.string().default(""),
    permissions: permissionList,
  });

  app.post("/api/roles", { preHandler: requireAny("roles.manage") }, async (req) => {
    const me = currentUser(req);
    const body = parse(RoleBody, req.body);
    const key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const [exists] = await ctx.db.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
    if (exists) throw badRequest("A role with that name already exists");
    const [role] = await ctx.db.insert(roles).values({ ...body, key }).returning();
    await audit(ctx.db, { action: "role_created", userId: me.id, entity: "role", entityId: String(role!.id), data: body });
    return { role };
  });

  app.patch("/api/roles/:id", { preHandler: requireAny("roles.manage") }, async (req) => {
    const me = currentUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(RoleBody.partial(), req.body);
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw notFound("Role not found");
    // Never let the admin role lose the power to manage roles, or nobody could fix it.
    if (role.key === "admin" && body.permissions && !(["roles.manage", "users.manage"] as const).every((p) => body.permissions!.includes(p))) {
      throw badRequest("The Admin role must keep 'users.manage' and 'roles.manage'");
    }
    const [updated] = await ctx.db.update(roles).set(body).where(eq(roles.id, id)).returning();
    await audit(ctx.db, { action: "role_updated", userId: me.id, entity: "role", entityId: String(id), data: body });
    return { role: updated };
  });

  app.delete("/api/roles/:id", { preHandler: requireAny("roles.manage") }, async (req) => {
    const me = currentUser(req);
    const { id } = parse(idParam, req.params);
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw notFound("Role not found");
    if (role.isSystem) throw badRequest("Built-in roles can't be deleted");
    const [inUse] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.roleId, id)).limit(1);
    if (inUse) throw badRequest("Move this role's users to another role first");
    await ctx.db.delete(roles).where(eq(roles.id, id));
    await audit(ctx.db, { action: "role_deleted", userId: me.id, entity: "role", entityId: String(id) });
    return { ok: true };
  });

  // ---------------------------------------------------------------- my deliveries (agents)

  app.get("/api/me/deliveries", { preHandler: requireAny("deliveries.own") }, async (req) => {
    const me = currentUser(req);
    if (!can(req, "deliveries.own")) throw forbidden();
    const rows = await ctx.db
      .select({ order: orders, customerName: customers.name, customerPhone: customers.phone })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(and(eq(orders.agentId, me.id), inArray(orders.status, ["confirmed", "preparing", "out_for_delivery", "delivered"])))
      .orderBy(desc(orders.updatedAt))
      .limit(50);
    return {
      deliveries: rows.map((r) => ({
        id: r.order.id,
        status: r.order.status,
        totalPaise: r.order.totalPaise,
        paymentMethod: r.order.paymentMethod,
        paymentStatus: r.order.paymentStatus,
        delivery: r.order.delivery,
        lines: r.order.lines.map((l) => ({ brand: l.brand, packLabel: l.packLabel, qty: l.qty })),
        etaText: r.order.etaText,
        scheduledFor: r.order.scheduledFor,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        updatedAt: r.order.updatedAt,
      })),
    };
  });
}

function stripBotState(c: typeof customers.$inferSelect) {
  const { botState: _s, ...rest } = c;
  return rest;
}
