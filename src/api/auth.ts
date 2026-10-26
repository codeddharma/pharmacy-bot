import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { effectivePermissions } from "../auth/permissions.ts";
import { hashPassword, hashToken, newSessionToken, verifyPassword } from "../auth/password.ts";
import { authSessions, roles, users } from "../db/schema.ts";
import { audit } from "../services/customers.ts";
import type { AppContext } from "./context.ts";
import { currentUser, HttpError, parse, type AuthUser } from "./http.ts";

export const SESSION_COOKIE = "dd_session";
const SESSION_DAYS = 7;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export async function loadUser(ctx: AppContext, token: string | undefined): Promise<AuthUser | undefined> {
  if (!token) return undefined;
  const now = ctx.now?.() ?? new Date();
  const [row] = await ctx.db
    .select({ user: users, role: roles })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, now)));
  if (!row || !row.user.isActive) return undefined;
  return {
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    roleKey: row.role.key,
    roleName: row.role.name,
    permissions: effectivePermissions(row.role.permissions, row.user.grantPermissions, row.user.denyPermissions),
  };
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  /** Failed logins per email+IP; blocks password guessing. In memory: one server process. */
  const attempts = new Map<string, { count: number; until: number }>();

  // Attach the logged-in user (if any) to every API request.
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.user = await loadUser(ctx, req.cookies[SESSION_COOKIE]);
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const key = `${body.email.toLowerCase()}|${req.ip}`;
    const a = attempts.get(key);
    if (a && a.count >= MAX_ATTEMPTS && a.until > Date.now()) {
      throw new HttpError(429, `Too many attempts. Try again in ${LOCK_MINUTES} minutes.`);
    }

    const [user] = await ctx.db.select().from(users).where(eq(users.email, body.email.toLowerCase()));
    const ok = !!user && user.isActive && (await verifyPassword(body.password, user.passwordHash));
    if (!ok) {
      attempts.set(key, { count: (a?.count ?? 0) + 1, until: Date.now() + LOCK_MINUTES * 60_000 });
      throw new HttpError(401, "Wrong email or password");
    }
    attempts.delete(key);

    const token = newSessionToken();
    const now = ctx.now?.() ?? new Date();
    await ctx.db.insert(authSessions).values({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
    });
    await ctx.db.delete(authSessions).where(lt(authSessions.expiresAt, now));
    await ctx.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
    await audit(ctx.db, { action: "login", userId: user.id });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.cookieSecure,
      path: "/",
      maxAge: SESSION_DAYS * 86_400,
    });
    return { user: await loadUser(ctx, token) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await ctx.db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const u = currentUser(req);
    const [row] = await ctx.db
      .select({ onDuty: users.onDuty, phone: users.phone, telegramChatId: users.telegramChatId, vehicle: users.vehicle })
      .from(users)
      .where(eq(users.id, u.id));
    return { user: { ...u, ...row } };
  });

  app.patch("/api/auth/me", async (req) => {
    const u = currentUser(req);
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        phone: z.string().nullable().optional(),
        onDuty: z.boolean().optional(),
        telegramChatId: z.string().regex(/^-?\d+$/).nullable().optional(),
      }),
      req.body,
    );
    await ctx.db.update(users).set(body).where(eq(users.id, u.id));
    return { ok: true };
  });

  app.post("/api/auth/password", async (req: FastifyRequest) => {
    const u = currentUser(req);
    const body = parse(z.object({ current: z.string(), next: z.string().min(8, "Use at least 8 characters") }), req.body);
    const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
    if (!row || !(await verifyPassword(body.current, row.passwordHash))) throw new HttpError(400, "Current password is wrong");
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.next) }).where(eq(users.id, u.id));
    // Log out other devices.
    const token = req.cookies[SESSION_COOKIE];
    await ctx.db.delete(authSessions).where(eq(authSessions.userId, u.id));
    if (token) {
      await ctx.db.insert(authSessions).values({
        tokenHash: hashToken(token),
        userId: u.id,
        expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      });
    }
    await audit(ctx.db, { action: "password_changed", userId: u.id });
    return { ok: true };
  });
}
