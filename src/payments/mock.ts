import { randomBytes } from "node:crypto";
import type { CreateLinkInput, PaymentLink, PaymentProvider } from "./types.ts";

/**
 * Development provider. The "payment page" is a URL on our own API that marks the
 * order paid when opened (see /api/dev/pay). Never enable in production.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  constructor(private readonly publicUrl: string) {}

  async createLink(input: CreateLinkInput): Promise<PaymentLink> {
    const linkId = `plink_mock_${randomBytes(6).toString("hex")}`;
    return { linkId, url: `${this.publicUrl}/api/dev/pay/${linkId}?order=${encodeURIComponent(input.orderId)}` };
  }

  async refund(_paymentId: string, _amountPaise: number): Promise<{ refundId: string }> {
    return { refundId: `rfnd_mock_${randomBytes(6).toString("hex")}` };
  }
}
