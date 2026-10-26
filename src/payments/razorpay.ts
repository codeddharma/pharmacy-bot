import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateLinkInput, PaymentEvent, PaymentLink, PaymentProvider } from "./types.ts";

const API = "https://api.razorpay.com/v1";

/**
 * Razorpay Payment Links (UPI and other methods on Razorpay's page) and refunds.
 * Use test-mode keys (rzp_test_...) until the whole flow has been tried end to end.
 * Webhook events to enable in the Razorpay dashboard: payment_link.paid,
 * payment_link.expired, payment_link.cancelled, refund.processed.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay" as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(`Razorpay ${path} failed (${res.status}): ${json.error?.description ?? "unknown error"}`);
    return json;
  }

  async createLink(input: CreateLinkInput): Promise<PaymentLink> {
    // Razorpay requires expire_by to be at least 15 minutes ahead.
    const minExpiry = Date.now() + 16 * 60_000;
    const link = await this.call<{ id: string; short_url: string }>("/payment_links", {
      amount: input.amountPaise,
      currency: "INR",
      reference_id: input.orderId,
      description: input.description.slice(0, 2048),
      customer: { name: input.customerName, contact: input.customerPhone },
      notify: { sms: false, email: false },
      reminder_enable: false,
      expire_by: Math.floor(Math.max(input.expiresAt.getTime(), minExpiry) / 1000),
      notes: { order_id: input.orderId },
    });
    return { linkId: link.id, url: link.short_url };
  }

  async refund(paymentId: string, amountPaise: number, note: string): Promise<{ refundId: string }> {
    const r = await this.call<{ id: string }>(`/payments/${paymentId}/refund`, {
      amount: amountPaise,
      speed: "normal",
      notes: { reason: note.slice(0, 250) },
    });
    return { refundId: r.id };
  }
}

/** Checks the X-Razorpay-Signature header: HMAC-SHA256 of the raw body with the webhook secret. */
export function verifyRazorpaySignature(rawBody: Buffer | string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reduces a Razorpay webhook body to the events the bot cares about. */
export function parseRazorpayEvent(body: any): PaymentEvent {
  switch (body?.event) {
    case "payment_link.paid": {
      const link = body.payload?.payment_link?.entity;
      const payment = body.payload?.payment?.entity;
      if (!link?.id || !payment?.id) return { type: "ignored" };
      return { type: "paid", linkId: link.id, paymentId: payment.id, amountPaise: Number(payment.amount) };
    }
    case "payment_link.expired":
    case "payment_link.cancelled": {
      const link = body.payload?.payment_link?.entity;
      return link?.id ? { type: "expired", linkId: link.id } : { type: "ignored" };
    }
    case "refund.processed": {
      const refund = body.payload?.refund?.entity;
      return refund?.id && refund?.payment_id
        ? { type: "refunded", paymentId: refund.payment_id, refundId: refund.id }
        : { type: "ignored" };
    }
  }
  return { type: "ignored" };
}
