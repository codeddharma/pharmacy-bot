import { z } from "zod";

// ---- Catalogue (data/catalogue.json, read-only for the bot) ----

export const ScheduleSchema = z.enum(["OTC", "G", "H", "H1", "X"]);
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SaleRuleSchema = z.enum([
  "auto",
  "pharmacist_review",
  "pharmacist_review_with_register",
  "never_online",
]);
export type SaleRule = z.infer<typeof SaleRuleSchema>;

export const ProductSchema = z.object({
  sku: z.string(),
  brand: z.string(),
  generic: z.string(),
  composition: z.array(z.object({ name: z.string(), strength: z.string().nullable() })),
  form: z.string(),
  pack: z.object({ size: z.number(), unit: z.string(), label: z.string() }),
  manufacturer: z.string(),
  category: z.string(),
  system: z.string(),
  schedule: ScheduleSchema,
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
export type Product = z.infer<typeof ProductSchema>;

export const CatalogueSchema = z.object({
  meta: z.looseObject({
    currency: z.literal("INR"),
    schedule_rules: z.record(ScheduleSchema, SaleRuleSchema),
  }),
  products: z.array(ProductSchema),
});
export type Catalogue = z.infer<typeof CatalogueSchema>;

// ---- Inventory (data/inventory.json, written by the bot) ----

export const BatchSchema = z.object({
  batch: z.string(),
  mfg: z.string().regex(/^\d{4}-\d{2}$/),
  exp: z.string().regex(/^\d{4}-\d{2}$/),
  qty: z.number().int().min(0),
});
export type Batch = z.infer<typeof BatchSchema>;

export const InventoryItemSchema = z.object({
  reserved: z.number().int().min(0),
  reorder_level: z.number().int().min(0),
  rack: z.string().nullable(),
  batches: z.array(BatchSchema),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventorySchema = z.object({
  meta: z.looseObject({ near_expiry_days: z.number().int().min(0) }),
  items: z.record(z.string(), InventoryItemSchema),
});
export type Inventory = z.infer<typeof InventorySchema>;

// ---- Runtime records ----

export interface Reservation {
  id: string;
  orderId: string;
  sku: string;
  qty: number;
  expiresAt: string; // ISO
}

export interface OrderLine {
  sku: string;
  brand: string;
  packLabel: string;
  qty: number;
  mrp: number;
  lineTotal: number;
  note?: string;
  batches?: { batch: string; exp: string; qty: number }[]; // filled when stock is committed
}

export type OrderStatus =
  | "reserved" // cart shown, stock held
  | "awaiting_payment"
  | "paid"
  | "cod_confirmed"
  | "cancelled"
  | "expired";

export interface Order {
  id: string;
  userId: string;
  channel: string;
  status: OrderStatus;
  lines: OrderLine[];
  excluded: { name: string; reason: string }[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  delivery?: { name: string; phone: string; address: string; pincode: string };
  payment?: { method: "upi_mock" | "cod"; reference: string; at: string };
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  name?: string;
  phone?: string;
  address?: string;
  pincode?: string;
  consentAt?: string;
  language?: string;
}

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
  | "confirm_address"
  | "awaiting_payment";

export interface Session {
  state: SessionState;
  updatedAt: string;
  draft?: DraftItem[];
  orderId?: string;
}

export interface WaitlistEntry {
  userId: string;
  sku: string;
  createdAt: string;
}

// ---- Channel-agnostic messages ----

export interface InboundMessage {
  userId: string; // e.g. "tg:123456"
  channel: string; // "telegram"
  messageId: string;
  text?: string;
  media?: { kind: "image" | "pdf"; mimeType: string; data: Buffer };
  action?: string; // button press
  contactPhone?: string; // shared phone number
}

export interface Button {
  label: string;
  action: string;
}

export interface OutboundMessage {
  text: string;
  buttons?: Button[][]; // rows of inline buttons
  requestContact?: boolean; // show a "share phone number" keyboard
  removeKeyboard?: boolean;
}
