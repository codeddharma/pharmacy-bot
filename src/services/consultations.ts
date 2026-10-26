import { and, eq, isNull, lte } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { consultations } from "../db/schema.ts";

export type Consultation = typeof consultations.$inferSelect;

export async function createConsultation(
  db: DbOrTx,
  c: { customerId: number; kind: Consultation["kind"]; question: string; mediaPath?: string | null; orderId?: string | null; at: Date },
): Promise<Consultation> {
  const [row] = await db
    .insert(consultations)
    .values({
      customerId: c.customerId,
      kind: c.kind,
      question: c.question,
      mediaPath: c.mediaPath ?? null,
      orderId: c.orderId ?? null,
      createdAt: c.at,
    })
    .returning();
  return row!;
}

/** Open questions older than the limit that haven't been escalated yet; marks them escalated. */
export async function escalateOverdue(db: DbOrTx, now: Date, afterMinutes: number): Promise<Consultation[]> {
  return db
    .update(consultations)
    .set({ escalatedAt: now })
    .where(
      and(
        eq(consultations.status, "open"),
        isNull(consultations.escalatedAt),
        lte(consultations.createdAt, new Date(now.getTime() - afterMinutes * 60_000)),
      ),
    )
    .returning();
}
