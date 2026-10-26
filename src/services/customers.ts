import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { auditLog, customers, messages } from "../db/schema.ts";
import type { Channel, Session } from "../types.ts";

export type Customer = typeof customers.$inferSelect;

export async function findOrCreateCustomer(
  db: DbOrTx,
  channel: Channel,
  channelUserId: string,
  profileName?: string,
): Promise<Customer> {
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.channel, channel), eq(customers.channelUserId, channelUserId)));
  if (existing) return existing;
  const [created] = await db
    .insert(customers)
    .values({ channel, channelUserId, name: null, phone: channel === "whatsapp" ? `+${channelUserId}` : null })
    .onConflictDoNothing()
    .returning();
  if (created) {
    if (profileName) await db.insert(auditLog).values({ action: "customer_created", customerId: created.id, data: { profileName } });
    return created;
  }
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.channel, channel), eq(customers.channelUserId, channelUserId)));
  return row!;
}

export async function getCustomer(db: DbOrTx, id: number): Promise<Customer | undefined> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  return row;
}

export async function updateCustomer(db: DbOrTx, id: number, patch: Partial<Omit<Customer, "id">>): Promise<Customer> {
  const [row] = await db.update(customers).set(patch).where(eq(customers.id, id)).returning();
  return row!;
}

export function sessionOf(c: Customer): Session {
  return (c.botState as Session | null) ?? { state: "idle" };
}

export async function setSession(db: DbOrTx, customerId: number, session: Session, at: Date): Promise<void> {
  await db.update(customers).set({ botState: session as unknown as Record<string, unknown>, botStateUpdatedAt: at }).where(eq(customers.id, customerId));
}

/** Stores a message for the dashboard inbox. Inbound messages bump the unread count. */
export async function logMessage(
  db: DbOrTx,
  m: { customerId: number; direction: "in" | "out"; sender: "customer" | "bot" | "staff"; text: string; userId?: number | null; mediaPath?: string | null; at: Date },
): Promise<void> {
  await db.insert(messages).values({
    customerId: m.customerId,
    direction: m.direction,
    sender: m.sender,
    text: m.text,
    userId: m.userId ?? null,
    mediaPath: m.mediaPath ?? null,
    createdAt: m.at,
  });
  if (m.direction === "in") {
    await db
      .update(customers)
      .set({ lastMessageAt: m.at, unread: sql`${customers.unread} + 1` })
      .where(eq(customers.id, m.customerId));
  }
}

export async function audit(
  db: DbOrTx,
  e: { action: string; userId?: number | null; customerId?: number | null; entity?: string; entityId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    action: e.action,
    userId: e.userId ?? null,
    customerId: e.customerId ?? null,
    entity: e.entity ?? null,
    entityId: e.entityId ?? null,
    data: e.data ?? null,
  });
}
