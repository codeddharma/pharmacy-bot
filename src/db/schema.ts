import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Column names are snake_case in the database (see `casing` in db/client.ts).
// Money is stored as whole paise (₹32.28 -> 3228) so it never suffers float rounding.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const textArray = () => text().array().notNull().default(sql`'{}'::text[]`);

// ---------------------------------------------------------------- staff

export const roles = pgTable("roles", {
  id: serial().primaryKey(),
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text().notNull().default(""),
  permissions: textArray(),
  isSystem: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: serial().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  phone: text(),
  passwordHash: text().notNull(),
  roleId: integer()
    .notNull()
    .references(() => roles.id),
  /** Per-user changes on top of the role's permissions. */
  grantPermissions: textArray(),
  denyPermissions: textArray(),
  /** Delivery agents: bike, scooter, cycle. */
  vehicle: text(),
  /** Telegram chat for staff alerts (optional). */
  telegramChatId: text(),
  onDuty: boolean().notNull().default(true),
  isActive: boolean().notNull().default(true),
  lastLoginAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

export const authSessions = pgTable("auth_sessions", {
  tokenHash: text().primaryKey(),
  userId: integer()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- catalogue and stock

export type Composition = { name: string; strength: string | null }[];
export type Pack = { size: number; unit: string; label: string };

export const products = pgTable("products", {
  sku: text().primaryKey(),
  brand: text().notNull(),
  generic: text().notNull(),
  composition: jsonb().$type<Composition>().notNull(),
  form: text().notNull(),
  pack: jsonb().$type<Pack>().notNull(),
  manufacturer: text().notNull(),
  category: text().notNull(),
  system: text().notNull(),
  schedule: text().$type<"OTC" | "G" | "H" | "H1" | "X">().notNull(),
  rxRequired: boolean().notNull(),
  maxPacksPerOrder: integer().notNull(),
  mrpPaise: integer().notNull(),
  aliases: textArray(),
  warnings: textArray(),
  verifiedPrice: boolean().notNull().default(false),
  verifiedSchedule: boolean().notNull().default(false),
  notes: text(),
  replacedBy: text(),
  source: text(),
  active: boolean().notNull().default(true),
  reorderLevel: integer().notNull().default(0),
  rack: text(),
  /** Packs held outside the bot (e.g. kept aside for a walk-in customer). */
  manualHold: integer().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const batches = pgTable(
  "batches",
  {
    id: serial().primaryKey(),
    sku: text()
      .notNull()
      .references(() => products.sku, { onDelete: "cascade", onUpdate: "cascade" }),
    batchNo: text().notNull(),
    mfg: date({ mode: "string" }).notNull(),
    /** Last day of the expiry month. */
    exp: date({ mode: "string" }).notNull(),
    qty: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.sku, t.batchNo), index().on(t.sku)],
);

// ---------------------------------------------------------------- customers and conversations

export const customers = pgTable(
  "customers",
  {
    id: serial().primaryKey(),
    channel: text().$type<"telegram" | "whatsapp">().notNull(),
    channelUserId: text().notNull(),
    name: text(),
    phone: text(),
    address: text(),
    pincode: text(),
    lat: doublePrecision(),
    lng: doublePrecision(),
    consentAt: timestamp({ withTimezone: true }),
    language: text(),
    blocked: boolean().notNull().default(false),
    /** Staff member who has taken over the chat; the bot stays quiet while set. */
    handoffUserId: integer().references(() => users.id, { onDelete: "set null" }),
    botState: jsonb().$type<Record<string, unknown>>(),
    botStateUpdatedAt: timestamp({ withTimezone: true }),
    lastMessageAt: timestamp({ withTimezone: true }),
    unread: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.channel, t.channelUserId)],
);

export const messages = pgTable(
  "messages",
  {
    id: serial().primaryKey(),
    customerId: integer()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    direction: text().$type<"in" | "out">().notNull(),
    sender: text().$type<"customer" | "bot" | "staff">().notNull(),
    userId: integer().references(() => users.id, { onDelete: "set null" }),
    text: text().notNull().default(""),
    mediaPath: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.customerId, t.createdAt)],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: serial().primaryKey(),
    customerId: integer()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    sku: text()
      .notNull()
      .references(() => products.sku, { onDelete: "cascade", onUpdate: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.customerId, t.sku)],
);

export const consultations = pgTable(
  "consultations",
  {
    id: serial().primaryKey(),
    customerId: integer()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    kind: text().$type<"question" | "complaint" | "prescription">().notNull(),
    question: text().notNull(),
    mediaPath: text(),
    orderId: text(),
    status: text().$type<"open" | "answered" | "closed">().notNull().default("open"),
    assignedUserId: integer().references(() => users.id, { onDelete: "set null" }),
    answer: text(),
    answeredBy: integer().references(() => users.id, { onDelete: "set null" }),
    answeredAt: timestamp({ withTimezone: true }),
    escalatedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.status, t.createdAt)],
);

// ---------------------------------------------------------------- orders

export type OrderLine = {
  sku: string;
  brand: string;
  packLabel: string;
  qty: number;
  mrpPaise: number;
  lineTotalPaise: number;
  note?: string;
  batches?: { batch: string; exp: string; qty: number }[];
};

export type OrderStatus =
  | "reserved" // cart shown, stock held
  | "awaiting_payment"
  | "confirmed" // paid by UPI, or cash on delivery
  | "preparing"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "expired";

export type PaymentStatus = "none" | "pending" | "paid" | "cod" | "failed" | "refund_pending" | "refunded";

export type Delivery = {
  name: string;
  phone: string;
  address: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
};

export const orders = pgTable(
  "orders",
  {
    id: text().primaryKey(),
    customerId: integer()
      .notNull()
      .references(() => customers.id),
    channel: text().notNull(),
    status: text().$type<OrderStatus>().notNull(),
    lines: jsonb().$type<OrderLine[]>().notNull(),
    excluded: jsonb().$type<{ name: string; reason: string }[]>().notNull(),
    subtotalPaise: integer().notNull(),
    deliveryFeePaise: integer().notNull(),
    totalPaise: integer().notNull(),
    delivery: jsonb().$type<Delivery>(),
    /** Set when the order will be prepared at the next opening time. */
    scheduledFor: timestamp({ withTimezone: true }),
    etaText: text(),
    paymentMethod: text().$type<"upi" | "cod">(),
    paymentStatus: text().$type<PaymentStatus>().notNull().default("none"),
    paymentLinkId: text(),
    paymentLinkUrl: text(),
    paymentId: text(),
    refundId: text(),
    agentId: integer().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.customerId), index().on(t.status), index().on(t.createdAt), index().on(t.paymentLinkId)],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: serial().primaryKey(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text().notNull(),
    note: text(),
    userId: integer().references(() => users.id, { onDelete: "set null" }),
    at: createdAt(),
  },
  (t) => [index().on(t.orderId)],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sku: text()
      .notNull()
      .references(() => products.sku, { onDelete: "cascade", onUpdate: "cascade" }),
    qty: integer().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.sku), index().on(t.orderId)],
);

// ---------------------------------------------------------------- configuration and history

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedBy: integer().references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const interactionRules = pgTable("interaction_rules", {
  id: serial().primaryKey(),
  /** Lower-case ingredient names, e.g. "paracetamol". */
  ingredientA: text().notNull(),
  ingredientB: text().notNull(),
  message: text().notNull(),
  severity: text().$type<"warn" | "block">().notNull().default("warn"),
  active: boolean().notNull().default(true),
  createdBy: integer().references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial().primaryKey(),
    userId: integer().references(() => users.id, { onDelete: "set null" }),
    customerId: integer().references(() => customers.id, { onDelete: "set null" }),
    action: text().notNull(),
    entity: text(),
    entityId: text(),
    data: jsonb().$type<Record<string, unknown>>(),
    at: createdAt(),
  },
  (t) => [index().on(t.at)],
);
