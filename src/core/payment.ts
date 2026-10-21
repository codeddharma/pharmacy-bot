import { randomBytes } from "node:crypto";
import type { Order } from "../types.ts";

export interface PaymentResult {
  status: "paid" | "pending";
  reference: string;
  /** Payment page for the customer (real providers only). */
  url?: string;
}

/**
 * A real provider (Razorpay, Cashfree, PhonePe) creates a UPI payment link here, returns
 * status "pending", and confirms the payment later through a webhook. Never mark an order
 * paid because the customer says so.
 */
export interface PaymentProvider {
  readonly name: string;
  start(order: Order): Promise<PaymentResult>;
}

/** POC provider: every payment succeeds immediately and no money moves. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock_upi";

  async start(_order: Order): Promise<PaymentResult> {
    return { status: "paid", reference: `MOCKUPI-${randomBytes(4).toString("hex").toUpperCase()}` };
  }
}
