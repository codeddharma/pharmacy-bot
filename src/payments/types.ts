export interface PaymentLink {
  /** Provider's id for the link; the webhook refers to it. */
  linkId: string;
  url: string;
}

export interface CreateLinkInput {
  orderId: string;
  amountPaise: number;
  customerName: string;
  customerPhone: string;
  description: string;
  expiresAt: Date;
}

/**
 * UPI payments. Customers pay on the provider's page; the provider tells us by webhook.
 * An order is never marked paid because a customer says so.
 */
export interface PaymentProvider {
  readonly name: "mock" | "razorpay";
  createLink(input: CreateLinkInput): Promise<PaymentLink>;
  refund(paymentId: string, amountPaise: number, note: string): Promise<{ refundId: string }>;
}

/** What the webhook handler extracts from a provider's callback. */
export type PaymentEvent =
  | { type: "paid"; linkId: string; paymentId: string; amountPaise: number }
  | { type: "failed" | "expired"; linkId: string }
  | { type: "refunded"; paymentId: string; refundId: string }
  | { type: "ignored" };
