import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { orders } from "../../db/schema.ts";
import { parseRazorpayEvent, verifyRazorpaySignature } from "../../payments/razorpay.ts";
import type { AppContext } from "../context.ts";
import { HttpError } from "../http.ts";

export function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/webhooks/razorpay", async (req, reply) => {
    const signature = req.headers["x-razorpay-signature"];
    if (!ctx.razorpayWebhookSecret || typeof signature !== "string" || !req.rawBody) throw new HttpError(400, "Bad request");
    if (!verifyRazorpaySignature(req.rawBody, signature, ctx.razorpayWebhookSecret)) throw new HttpError(401, "Bad signature");
    const event = parseRazorpayEvent(req.body);
    // Answer Razorpay quickly; process in the background so slow messaging can't cause retries.
    void ctx.engine.onPaymentEvent(event).catch((e) => console.error("[razorpay webhook]", e));
    return reply.send({ ok: true });
  });

  // Development only: the mock provider's "payment page". Paying here confirms the order.
  if (ctx.payments?.name === "mock") {
    app.get("/api/dev/pay/:linkId", async (req, reply) => {
      const { linkId } = req.params as { linkId: string };
      const [order] = await ctx.db.select().from(orders).where(eq(orders.paymentLinkId, linkId));
      if (!order) throw new HttpError(404, "Unknown payment link");
      await ctx.engine.onPaymentEvent({ type: "paid", linkId, paymentId: `pay_mock_${Date.now()}`, amountPaise: order.totalPaise });
      reply.type("text/html").send(
        `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;padding:2rem">` +
          `<h2>Demo payment received</h2><p>Order ${order.id}: ₹${(order.totalPaise / 100).toFixed(2)}. No money was taken. You can go back to the chat.</p>`,
      );
    });
  }
}
