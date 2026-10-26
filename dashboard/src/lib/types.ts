// Shapes returned by the DawaDesk API (see src/api on the server).

export type Permission =
  | "stats.view"
  | "orders.view"
  | "orders.manage"
  | "orders.refund"
  | "deliveries.own"
  | "inventory.view"
  | "inventory.manage"
  | "customers.view"
  | "customers.manage"
  | "inbox.view"
  | "inbox.reply"
  | "consultations.view"
  | "consultations.answer"
  | "hours.toggle"
  | "settings.manage"
  | "users.manage"
  | "roles.manage"
  | "audit.view";

export interface Me {
  id: number;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  permissions: Permission[];
  onDuty: boolean;
  phone: string | null;
  telegramChatId: string | null;
}

export type Schedule = "OTC" | "G" | "H" | "H1" | "X";

export interface Product {
  sku: string;
  brand: string;
  generic: string;
  composition: { name: string; strength: string | null }[];
  form: string;
  pack: { size: number; unit: string; label: string };
  manufacturer: string;
  category: string;
  system: string;
  schedule: Schedule;
  maxPacksPerOrder: number;
  mrpPaise: number;
  mrp: number;
  aliases: string[];
  warnings: string[];
  verifiedPrice: boolean;
  verifiedSchedule: boolean;
  notes: string | null;
  replacedBy: string | null;
  source: string | null;
  active: boolean;
  reorderLevel: number;
  rack: string | null;
  manualHold: number;
  available?: number;
  nearExpiryPacks?: number;
  stockStatus?: "ok" | "low" | "out";
}

export interface Batch {
  id: number;
  sku: string;
  batchNo: string;
  mfg: string;
  exp: string;
  qty: number;
  sellable: boolean;
}

export type OrderStatus =
  | "reserved"
  | "awaiting_payment"
  | "confirmed"
  | "preparing"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "expired";

export type PaymentStatus = "none" | "pending" | "paid" | "cod" | "failed" | "refund_pending" | "refunded";

export interface OrderLine {
  sku: string;
  brand: string;
  packLabel: string;
  qty: number;
  mrpPaise: number;
  lineTotalPaise: number;
  note?: string;
  batches?: { batch: string; exp: string; qty: number }[];
}

export interface Delivery {
  name: string;
  phone: string;
  address: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
  distanceKm: number | null;
}

export interface Order {
  id: string;
  customerId: number;
  channel: string;
  status: OrderStatus;
  lines: OrderLine[];
  excluded: { name: string; reason: string }[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  delivery: Delivery | null;
  scheduledFor: string | null;
  etaText: string | null;
  paymentMethod: "upi" | "cod" | null;
  paymentStatus: PaymentStatus;
  paymentLinkUrl: string | null;
  paymentId: string | null;
  refundId: string | null;
  agentId: number | null;
  createdAt: string;
  updatedAt: string;
  customerName?: string | null;
  customerPhone?: string | null;
  agentName?: string | null;
}

export interface OrderEvent {
  id: number;
  status: string;
  note: string | null;
  userName: string | null;
  at: string;
}

export interface Agent {
  id: number;
  name: string;
  phone: string | null;
  vehicle: string | null;
  onDuty: boolean;
  activeOrders: number;
  deliveredToday: number;
}

export interface Customer {
  id: number;
  channel: "telegram" | "whatsapp";
  channelUserId: string;
  name: string | null;
  phone: string | null;
  address: string | null;
  pincode: string | null;
  lat: number | null;
  lng: number | null;
  consentAt: string | null;
  language: string | null;
  blocked: boolean;
  handoffUserId: number | null;
  lastMessageAt: string | null;
  unread: number;
  createdAt: string;
  orderCount?: number;
  spentPaise?: number;
}

export interface Conversation {
  customerId: number;
  name: string | null;
  phone: string | null;
  channel: "telegram" | "whatsapp";
  unread: number;
  handoffUserId: number | null;
  handoffName: string | null;
  blocked: boolean;
  lastText: string | null;
  lastAt: string | null;
}

export interface Message {
  id: number;
  customerId: number;
  direction: "in" | "out";
  sender: "customer" | "bot" | "staff";
  text: string;
  hasMedia: boolean;
  staffName: string | null;
  createdAt: string;
}

export interface Consultation {
  id: number;
  customerId: number;
  kind: "question" | "complaint" | "prescription";
  question: string;
  hasMedia: boolean;
  orderId: string | null;
  status: "open" | "answered" | "closed";
  assignedUserId: number | null;
  assigneeName: string | null;
  answer: string | null;
  answeredByName: string | null;
  answeredAt: string | null;
  escalatedAt: string | null;
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  channel: string;
}

export interface StaffUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  roleId: number;
  roleKey?: string;
  roleName?: string;
  grantPermissions: Permission[];
  denyPermissions: Permission[];
  permissions: Permission[];
  vehicle: string | null;
  telegramChatId: string | null;
  onDuty: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface Role {
  id: number;
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  userCount: number;
}

export interface InteractionRule {
  id: number;
  ingredientA: string;
  ingredientB: string;
  message: string;
  severity: "warn" | "block";
  active: boolean;
}

export interface Settings {
  pharmacy: { name: string; phone: string; pharmacistPhone: string; managerPhone: string; address: string; lat: number | null; lng: number | null };
  hours: {
    timezone: string;
    weekly: { open: string; close: string; closed: boolean }[];
    holidays: string[];
    sameDayCutoffMinutes: number;
    override: "auto" | "open" | "closed";
  };
  delivery: {
    radiusKm: number;
    feeRupees: number;
    freeAboveRupees: number;
    etaBands: { maxKm: number; text: string }[];
    serviceablePincodePrefixes: string[];
    requireLocation: boolean;
  };
  inventory: { nearExpiryDays: number };
  orders: { reservationMinutes: number; duplicateWindowMinutes: number; codEnabled: boolean; upiEnabled: boolean };
  consultations: { escalateAfterMinutes: number };
  bot: { sessionTimeoutMinutes: number; uploadRetentionDays: number };
  whatsapp: { followUpTemplate: string; templateLanguage: string };
}

export interface ShopStatus {
  open: boolean;
  reason: string;
  override: "auto" | "open" | "closed";
  todayHours: string;
  closesAt: string | null;
  nextOpenAt: string | null;
  nextOpenText: string | null;
}

export interface Stats {
  days: number;
  kpis: {
    ordersToday: number;
    revenueTodayPaise: number;
    orders: number;
    revenuePaise: number;
    avgOrderPaise: number;
    activeOrders: number;
    openQuestions: number;
    newCustomers: number;
    refusedPrescriptionItems: number;
    avgAnswerMinutes: number | null;
    avgDeliveryMinutes: number | null;
    lowStock: number;
    outOfStock: number;
    nearExpiry: number;
  };
  series: { day: string; orders: number; revenuePaise: number }[];
  byStatus: { status: string; count: number }[];
  topProducts: { sku: string; brand: string; qty: number; revenuePaise: number }[];
  payment: { method: string; count: number }[];
  waitlistDemand: { sku: string; brand: string; waiting: number }[];
  agents: { name: string; delivered: number }[];
}

export interface AuditEntry {
  id: number;
  action: string;
  entity: string | null;
  entityId: string | null;
  data: Record<string, unknown> | null;
  at: string;
  userName: string | null;
  customerName: string | null;
}

export type AppEvent =
  | { type: "order.created" | "order.updated"; orderId: string; status: string; agentId: number | null }
  | { type: "message.in"; customerId: number; preview: string; handoff: boolean }
  | { type: "message.out"; customerId: number }
  | { type: "consultation.created" | "consultation.updated" | "consultation.escalated"; id: number; kind: string }
  | { type: "stock.changed"; sku: string }
  | { type: "catalogue.changed" }
  | { type: "settings.changed" };
