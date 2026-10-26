import { z } from "zod";
import type { products } from "./db/schema.ts";

export type Channel = "telegram" | "whatsapp";
export type Schedule = "OTC" | "G" | "H" | "H1" | "X";

/** A catalogue product as the bot sees it: the database row plus the MRP in rupees. */
export type Product = typeof products.$inferSelect & { mrp: number };

export function toProduct(row: typeof products.$inferSelect): Product {
  return { ...row, mrp: row.mrpPaise / 100 };
}

export const rupeesToPaise = (r: number) => Math.round(r * 100);
export const paiseToRupees = (p: number) => p / 100;

// ---- Seed files (data/catalogue.json, data/inventory.json) ----

export const SeedProductSchema = z.object({
  sku: z.string(),
  brand: z.string(),
  generic: z.string(),
  composition: z.array(z.object({ name: z.string(), strength: z.string().nullable() })),
  form: z.string(),
  pack: z.object({ size: z.number(), unit: z.string(), label: z.string() }),
  manufacturer: z.string(),
  category: z.string(),
  system: z.string(),
  schedule: z.enum(["OTC", "G", "H", "H1", "X"]),
  rx_required: z.boolean(),
  max_packs_per_order: z.number().int().min(0),
  mrp: z.number().nonnegative(),
  aliases: z.array(z.string()),
  warnings: z.array(z.string()),
  verified: z.object({ price: z.boolean(), schedule: z.boolean() }),
  notes: z.string().optional(),
  replaced_by: z.string().optional(),
  source: z.string().nullable(),
  active: z.boolean(),
});

export const SeedInventorySchema = z.object({
  meta: z.looseObject({}),
  items: z.record(
    z.string(),
    z.object({
      reserved: z.number().int().min(0),
      reorder_level: z.number().int().min(0),
      rack: z.string().nullable(),
      batches: z.array(
        z.object({
          batch: z.string(),
          mfg: z.string().regex(/^\d{4}-\d{2}$/),
          exp: z.string().regex(/^\d{4}-\d{2}$/),
          qty: z.number().int().min(0),
        }),
      ),
    }),
  ),
});

// ---- Bot conversation state (stored on the customer row) ----

/** One medicine the customer asked for, after matching against the catalogue. */
export interface DraftItem {
  asWritten: string;
  quantity: number; // packs
  confidence: number; // 0-1, from extraction
  candidates: string[]; // SKUs, best first
  chosenSku: string | null; // null = not found, or still ambiguous
}

export type SessionState =
  | "idle"
  | "awaiting_consent"
  | "confirm_items"
  | "edit_items"
  | "cart_review"
  | "collect_name"
  | "collect_phone"
  | "collect_address"
  | "collect_pincode"
  | "collect_location"
  | "confirm_address"
  | "awaiting_payment"
  | "awaiting_question";

export interface Session {
  state: SessionState;
  draft?: DraftItem[];
  orderId?: string;
  /** Kind of question being collected in "awaiting_question". */
  questionKind?: "question" | "complaint";
  /** A question the bot offered to pass to the pharmacist. */
  pendingQuestion?: string;
  /** The prescription file behind the current list, if it came from an upload. */
  mediaPath?: string;
  /** Prescription-only items refused from that upload (offered for pharmacist review). */
  rxItems?: string[];
  /** The customer chose not to share a location for this checkout. */
  locationSkipped?: boolean;
}

// ---- Channel-agnostic messages ----

export interface InboundMessage {
  channel: Channel;
  /** Telegram chat id or WhatsApp phone number. */
  channelUserId: string;
  /** Unique per channel; used to drop duplicate deliveries. */
  messageId: string;
  text?: string;
  media?: { kind: "image" | "pdf"; mimeType: string; data: Buffer };
  action?: string; // button press
  contactPhone?: string; // shared phone number
  location?: { lat: number; lng: number };
  /** Name from the channel profile, if known. */
  profileName?: string;
}

export interface Button {
  label: string;
  action: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: Button[][]; // rows of inline buttons
  requestContact?: boolean; // show a "share phone number" button
  requestLocation?: boolean; // show a "share location" button
  removeKeyboard?: boolean;
}
