import type { ReactNode } from "react";
import type { OrderStatus, PaymentStatus, Schedule } from "@/lib/types";
import { cn } from "@/lib/utils";

type Tone = "green" | "amber" | "orange" | "red" | "blue" | "violet" | "grey" | "teal";

const TONES: Record<Tone, string> = {
  green: "bg-success-soft text-success",
  amber: "bg-warning-soft text-warning",
  orange: "bg-orange-soft text-orange",
  red: "bg-danger-soft text-danger",
  blue: "bg-info-soft text-info",
  violet: "bg-violet-soft text-violet",
  grey: "bg-surface-muted text-muted",
  teal: "bg-primary-soft text-primary",
};

/** Every badge carries text as well as colour, so it reads without relying on colour. */
export function Badge({ tone = "grey", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>{children}</span>;
}

const SCHEDULE: Record<Schedule, [Tone, string]> = {
  OTC: ["green", "OTC"],
  G: ["amber", "Sch. G"],
  H: ["amber", "Sch. H"],
  H1: ["orange", "Sch. H1"],
  X: ["red", "Sch. X"],
};

export function ScheduleBadge({ schedule }: { schedule: Schedule }) {
  const [tone, label] = SCHEDULE[schedule];
  return <Badge tone={tone}>{label}</Badge>;
}

export const ORDER_STATUS: Record<OrderStatus, [Tone, string]> = {
  reserved: ["grey", "In cart"],
  awaiting_payment: ["grey", "Awaiting payment"],
  confirmed: ["blue", "New"],
  preparing: ["amber", "Preparing"],
  out_for_delivery: ["violet", "Out for delivery"],
  delivered: ["green", "Delivered"],
  cancelled: ["grey", "Cancelled"],
  expired: ["grey", "Expired"],
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const [tone, label] = ORDER_STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const PAYMENT: Record<PaymentStatus, [Tone, string]> = {
  none: ["grey", "Unpaid"],
  pending: ["amber", "UPI pending"],
  paid: ["green", "Paid"],
  cod: ["teal", "Cash on delivery"],
  failed: ["red", "Payment failed"],
  refund_pending: ["orange", "Refund pending"],
  refunded: ["grey", "Refunded"],
};

export function PaymentBadge({ status, method }: { status: PaymentStatus; method?: "upi" | "cod" | null }) {
  const [tone, label] = PAYMENT[status];
  return <Badge tone={tone}>{status === "paid" && method ? `Paid · ${method === "upi" ? "UPI" : "Cash"}` : label}</Badge>;
}

export function StockBadge({ status, available }: { status?: "ok" | "low" | "out"; available?: number }) {
  if (status === "out") return <Badge tone="red">Out of stock</Badge>;
  if (status === "low") return <Badge tone="amber">Low · {available}</Badge>;
  return <Badge tone="green">In stock · {available}</Badge>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  return <Badge tone={channel === "whatsapp" ? "green" : "blue"}>{channel === "whatsapp" ? "WhatsApp" : "Telegram"}</Badge>;
}

const KIND: Record<string, [Tone, string]> = {
  question: ["teal", "Question"],
  complaint: ["red", "Complaint"],
  prescription: ["violet", "Prescription review"],
};

export function KindBadge({ kind }: { kind: string }) {
  const [tone, label] = KIND[kind] ?? ["grey", kind];
  return <Badge tone={tone}>{label}</Badge>;
}
