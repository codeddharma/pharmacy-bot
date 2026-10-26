import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { WindowClosedError } from "../../core/engine.ts";
import { consultations, customers, messages, users } from "../../db/schema.ts";
import { audit } from "../../services/customers.ts";
import type { AppContext } from "../context.ts";
import { badRequest, currentUser, HttpError, idParam, notFound, parse, requireAny } from "../http.ts";

/** Turns a failed send into a message staff can act on (the reply was not delivered). */
function deliveryError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof WindowClosedError) return new HttpError(409, err.message);
  console.error("[inbox] send failed:", err);
  return new HttpError(502, `Couldn't deliver the message: ${(err as Error).message}`);
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };

export function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  /** Serves an uploaded prescription, only from inside the uploads folder. */
  const sendFile = (reply: FastifyReply, file: string | null) => {
    if (!file) throw notFound("No file");
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(ctx.uploadsDir) + path.sep) || !existsSync(resolved)) throw notFound("File not found");
    reply.header("content-type", MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream");
    reply.header("cache-control", "private, max-age=300");
    return reply.send(createReadStream(resolved));
  };

  // ---------------------------------------------------------------- inbox

  app.get("/api/inbox", { preHandler: requireAny("inbox.view") }, async (req) => {
    const q = parse(z.object({ filter: z.enum(["all", "unread", "handoff"]).default("all"), q: z.string().optional() }), req.query);
    const rows = await ctx.db
      .select({
        customer: customers,
        handoffName: users.name,
        lastText: sql<string>`(select ${messages.text} from ${messages} where ${messages.customerId} = ${customers.id} order by ${messages.createdAt} desc, ${messages.id} desc limit 1)`,
        lastAt: sql<Date>`(select max(${messages.createdAt}) from ${messages} where ${messages.customerId} = ${customers.id})`,
      })
      .from(customers)
      .leftJoin(users, eq(customers.handoffUserId, users.id))
      .where(
        and(
          isNotNull(customers.lastMessageAt),
          q.filter === "unread" ? sql`${customers.unread} > 0` : undefined,
          q.filter === "handoff" ? isNotNull(customers.handoffUserId) : undefined,
          q.q ? sql`(${customers.name} ilike ${"%" + q.q + "%"} or ${customers.phone} ilike ${"%" + q.q + "%"})` : undefined,
        ),
      )
      .orderBy(desc(customers.lastMessageAt))
      .limit(100);
    return {
      conversations: rows.map((r) => ({
        customerId: r.customer.id,
        name: r.customer.name,
        phone: r.customer.phone,
        channel: r.customer.channel,
        unread: r.customer.unread,
        handoffUserId: r.customer.handoffUserId,
        handoffName: r.handoffName,
        blocked: r.customer.blocked,
        lastText: r.lastText,
        lastAt: r.lastAt,
        lastMessageAt: r.customer.lastMessageAt,
      })),
    };
  });

  app.get("/api/inbox/:id/messages", { preHandler: requireAny("inbox.view") }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.coerce.number().int().optional() }), req.query);
    const [customer] = await ctx.db.select().from(customers).where(eq(customers.id, id));
    if (!customer) throw notFound("Customer not found");
    const rows = await ctx.db
      .select({ m: messages, staffName: users.name })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(and(eq(messages.customerId, id), q.before ? lt(messages.id, q.before) : undefined))
      .orderBy(desc(messages.id))
      .limit(100);
    const windowOpen =
      customer.channel !== "whatsapp" ||
      (!!customer.lastMessageAt && Date.now() - customer.lastMessageAt.getTime() < 24 * 3600_000);
    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone, channel: customer.channel, handoffUserId: customer.handoffUserId, blocked: customer.blocked },
      windowOpen,
      messages: rows.reverse().map((r) => ({ ...r.m, mediaPath: undefined, hasMedia: !!r.m.mediaPath, staffName: r.staffName })),
    };
  });

  app.post("/api/inbox/:id/messages", { preHandler: requireAny("inbox.reply") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(3000) }), req.body);
    try {
      await ctx.engine.sendStaffMessage(id, text, user.id);
    } catch (err) {
      throw deliveryError(err);
    }
    return { ok: true };
  });

  app.post("/api/inbox/:id/read", { preHandler: requireAny("inbox.view") }, async (req) => {
    const { id } = parse(idParam, req.params);
    await ctx.db.update(customers).set({ unread: 0 }).where(eq(customers.id, id));
    return { ok: true };
  });

  app.post("/api/inbox/:id/takeover", { preHandler: requireAny("inbox.reply") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    await ctx.engine.setHandoff(id, user.id, user.id);
    return { ok: true };
  });

  app.post("/api/inbox/:id/release", { preHandler: requireAny("inbox.reply") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    await ctx.engine.setHandoff(id, null, user.id);
    return { ok: true };
  });

  app.get("/api/messages/:id/media", { preHandler: requireAny("inbox.view", "consultations.view") }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [m] = await ctx.db.select({ mediaPath: messages.mediaPath }).from(messages).where(eq(messages.id, id));
    return sendFile(reply, m?.mediaPath ?? null);
  });

  // ---------------------------------------------------------------- pharmacist questions and complaints

  app.get("/api/consultations", { preHandler: requireAny("consultations.view") }, async (req) => {
    const q = parse(z.object({ status: z.enum(["open", "answered", "closed", "all"]).default("open"), kind: z.string().optional() }), req.query);
    const assignee = sql<string | null>`(select ${users.name} from ${users} where ${users.id} = ${consultations.assignedUserId})`;
    const answeredByName = sql<string | null>`(select ${users.name} from ${users} where ${users.id} = ${consultations.answeredBy})`;
    const rows = await ctx.db
      .select({ c: consultations, customerName: customers.name, customerPhone: customers.phone, channel: customers.channel, assignee, answeredByName })
      .from(consultations)
      .innerJoin(customers, eq(consultations.customerId, customers.id))
      .where(
        and(
          q.status === "all" ? undefined : eq(consultations.status, q.status),
          q.kind ? inArray(consultations.kind, q.kind.split(",") as ("question" | "complaint" | "prescription")[]) : undefined,
        ),
      )
      .orderBy(q.status === "open" ? asc(consultations.createdAt) : desc(consultations.createdAt))
      .limit(200);
    return {
      consultations: rows.map((r) => ({
        ...r.c,
        mediaPath: undefined,
        hasMedia: !!r.c.mediaPath,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        channel: r.channel,
        assigneeName: r.assignee,
        answeredByName: r.answeredByName,
      })),
    };
  });

  app.get("/api/consultations/:id/media", { preHandler: requireAny("consultations.view") }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [c] = await ctx.db.select({ mediaPath: consultations.mediaPath }).from(consultations).where(eq(consultations.id, id));
    return sendFile(reply, c?.mediaPath ?? null);
  });

  app.post("/api/consultations/:id/claim", { preHandler: requireAny("consultations.answer") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const [c] = await ctx.db.update(consultations).set({ assignedUserId: user.id }).where(eq(consultations.id, id)).returning();
    if (!c) throw notFound("Question not found");
    ctx.bus.emit({ type: "consultation.updated", id, kind: c.kind });
    return { ok: true };
  });

  app.post("/api/consultations/:id/answer", { preHandler: requireAny("consultations.answer") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const { answer } = parse(z.object({ answer: z.string().trim().min(2).max(3000) }), req.body);
    const [c] = await ctx.db.select().from(consultations).where(eq(consultations.id, id));
    if (!c) throw notFound("Question not found");
    if (c.status === "closed") throw badRequest("This question is closed");
    try {
      await ctx.engine.answerConsultation(id, answer, user.id);
    } catch (err) {
      throw deliveryError(err);
    }
    return { ok: true };
  });

  app.post("/api/consultations/:id/close", { preHandler: requireAny("consultations.answer") }, async (req) => {
    const user = currentUser(req);
    const { id } = parse(idParam, req.params);
    const [c] = await ctx.db.update(consultations).set({ status: "closed" }).where(eq(consultations.id, id)).returning();
    if (!c) throw notFound("Question not found");
    await audit(ctx.db, { action: "consultation_closed", userId: user.id, customerId: c.customerId, entity: "consultation", entityId: String(id) });
    ctx.bus.emit({ type: "consultation.updated", id, kind: c.kind });
    return { ok: true };
  });
}
