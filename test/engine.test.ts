import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { WindowClosedError } from "../src/core/engine.ts";
import { createUser } from "../src/db/seed.ts";
import { batches, consultations, customers, interactionRules, orders, products, waitlist } from "../src/db/schema.ts";
import { available } from "../src/services/inventory.ts";
import { actionsOf, consented, FakeExtractor, setup, textOf } from "./helpers.ts";

const policy = (now: Date) => ({ now, nearExpiryDays: 90, timezone: "Asia/Kolkata" });
const lastOrder = async (t: Awaited<ReturnType<typeof setup>>) => (await t.db.select().from(orders)).sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
const batchQty = async (t: Awaited<ReturnType<typeof setup>>, no: string) =>
  (await t.db.select().from(batches).where(eq(batches.batchNo, no)))[0]!.qty;

async function checkout(t: Awaited<ReturnType<typeof setup>>) {
  await t.tap("cart:order");
  await t.say("Asha Patel");
  await t.say("+91 98765 43210");
  await t.say("12 Shanti Nagar, CG Road, Ahmedabad");
  return t.say("380009");
}

test("asks for consent before anything else", async () => {
  const t = await setup();
  const out = await t.say("dolo");
  assert.match(textOf(out), /Do you agree\?/);
  assert.deepEqual(actionsOf(out), ["consent:yes"]);
  assert.match(textOf(await t.tap("consent:yes")), /You're all set/);
  await t.close();
});

test("UPI order: payment link, webhook confirms, FEFO stock deduction", async () => {
  const t = await consented();
  const confirm = await t.say("2 strips dolo 650, crocin");
  assert.match(textOf(confirm), /1\. Dolo 650 .* × 2/);

  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /Total: ₹124\.09/);
  assert.match(cart, /More than one of these contains paracetamol/);
  assert.equal(await available(t.db, "DOLO650-15", policy(t.clock.now)), 198);

  const addr = textOf(await checkout(t));
  assert.match(addr, /Deliver to:\nAsha Patel\n\+91 98765 43210/);
  assert.match(addr, /Delivery within 45–60 minutes/); // no location shared, so the widest band

  const pay = await t.tap("addr:yes");
  assert.deepEqual(actionsOf(pay), ["pay:upi", "pay:cod", "cancel"]);
  const link = textOf(await t.tap("pay:upi"));
  assert.match(link, /http:\/\/localhost:3000\/api\/dev\/pay\/plink_mock_/);

  const order = await lastOrder(t);
  assert.equal(order.id, "PB-261022-0001");
  assert.equal(order.paymentStatus, "pending");

  await t.engine.onPaymentEvent({ type: "paid", linkId: order.paymentLinkId!, paymentId: "pay_123", amountPaise: order.totalPaise });
  const paid = await lastOrder(t);
  assert.equal(paid.status, "confirmed");
  assert.equal(paid.paymentStatus, "paid");
  assert.deepEqual(paid.lines.find((l) => l.sku === "DOLO650-15")!.batches, [{ batch: "DOL6A114", exp: "2028-08", qty: 2 }]);
  assert.equal(await batchQty(t, "DOL6A114"), 78);
  assert.match(t.telegram.lastText(), /Payment received\. Order PB-261022-0001 is confirmed/);

  // The same webhook twice changes nothing.
  await t.engine.onPaymentEvent({ type: "paid", linkId: order.paymentLinkId!, paymentId: "pay_123", amountPaise: order.totalPaise });
  assert.equal(await batchQty(t, "DOL6A114"), 78);
  await t.close();
});

test("cash on delivery confirms immediately", async () => {
  const t = await consented();
  await t.say("eno");
  await t.tap("items:ok");
  await checkout(t);
  await t.say("yes");
  const done = textOf(await t.tap("pay:cod"));
  assert.match(done, /keep ₹50\.00 ready/);
  const o = await lastOrder(t);
  assert.equal(o.status, "confirmed");
  assert.equal(o.paymentStatus, "cod");
  await t.close();
});

test("prescription and Schedule X refused; a prescription photo can go to the pharmacist", async () => {
  const extractor = new FakeExtractor();
  extractor.next = {
    document_type: "prescription",
    language: "en",
    items: [
      { as_written: "Tab Augmentin 625", name: "Augmentin 625", strength: null, quantity: 10, quantity_unit: "unit", confidence: 0.9 },
      { as_written: "Limcee", name: "Limcee", strength: "500 mg", quantity: null, quantity_unit: null, confidence: 0.95 },
    ],
  };
  const t = await consented({ extractor });
  await t.send({ media: { kind: "image", mimeType: "image/jpeg", data: Buffer.from("x") } });
  const cart = await t.tap("items:ok");
  assert.match(textOf(cart), /Augmentin 625 Duo: Needs a doctor's prescription/);
  assert.ok(actionsOf(cart).includes("rx:review"));

  assert.match(textOf(await t.tap("rx:review")), /sent this to our pharmacist/);
  const [c] = await t.db.select().from(consultations);
  assert.equal(c!.kind, "prescription");
  assert.equal(c!.mediaPath, t.uploads[0]);
  assert.match(c!.question, /Augmentin 625 Duo/);

  await t.say("addwize");
  assert.match(textOf(await t.tap("items:ok")), /Schedule X medicine\. It can't be sold online\./);
  await t.close();
});

test("out of stock: offers a same-composition product, and the waitlist", async () => {
  const t = await consented();
  await t.db.update(batches).set({ qty: 0 }).where(eq(batches.sku, "CROCINADV500-20"));
  await t.say("crocin");
  const out = await t.tap("items:ok");
  assert.match(textOf(out), /Out of stock right now/);
  assert.ok(actionsOf(out).includes("alt:CROCINADV500-20:CALPOL500-15"));
  assert.ok(actionsOf(out).includes("notify:CROCINADV500-20"));

  const alt = textOf(await t.tap("alt:CROCINADV500-20:CALPOL500-15"));
  assert.match(alt, /Calpol 500 \(strip of 15 tablets\) × 1/);

  await t.tap("cancel");
  await t.say("otrivin");
  await t.tap("items:ok");
  await t.tap("notify:OTRIVIN-OXY-10ML");
  assert.equal((await t.db.select().from(waitlist)).length, 1);
  await t.db.insert(batches).values({ sku: "OTRIVIN-OXY-10ML", batchNo: "OTX1", mfg: "2026-09-01", exp: "2028-09-30", qty: 20 });
  assert.equal(await t.engine.notifyBackInStock("OTRIVIN-OXY-10ML"), 1);
  assert.match(t.telegram.lastText(), /back in stock/);
  await t.close();
});

test("near-expiry stock isn't sold; limits, discontinued swaps and brand picking still work", async () => {
  const t = await consented();
  assert.equal(await available(t.db, "SHELCAL500-15", policy(t.clock.now)), 6);
  assert.equal(await available(t.db, "HEXIDINE-160ML", policy(t.clock.now)), 0);
  assert.equal(await available(t.db, "ZANDU-BALM-10ML", policy(t.clock.now)), 4);

  await t.say("8 strips shelcal");
  assert.match(textOf(await t.tap("items:ok")), /Shelcal 500 .* × 4[\s\S]*Limited to 4 per order/);
  await t.tap("cancel");

  await t.say("dulcolax");
  assert.match(textOf(await t.tap("items:ok")), /Replaces Dulcolax 5mg Tablet, which is discontinued/);
  await t.tap("cancel");

  const pick = await t.say("paracetamol 500");
  assert.ok(actionsOf(pick).includes("pick:0:CALPOL500-15"));
  assert.match(textOf(await t.tap("pick:0:CALPOL500-15")), /1\. Calpol 500/);
  await t.close();
});

test("symptoms: offers the pharmacist; the answer reaches the customer", async () => {
  const t = await consented();
  const out = await t.say("I have fever since 2 days, what should I take?");
  assert.match(textOf(out), /can't suggest medicines myself/);
  assert.ok(actionsOf(out).includes("ask:pharmacist"));
  await t.tap("ask:pharmacist");

  const [c] = await t.db.select().from(consultations);
  assert.equal(c!.kind, "question");
  assert.match(c!.question, /fever since 2 days/);
  assert.ok(t.events.some((e) => e.type === "consultation.created"));

  const pharmacist = await createUser(t.db, { name: "Dr. Mehta", email: "p@x.in", password: "secret123", roleKey: "pharmacist" });
  await t.engine.answerConsultation(c!.id, "Please share your prescription or visit us for a check.", pharmacist);
  assert.match(t.telegram.lastText(), /Reply from our pharmacist \(Dr\. Mehta\)/);
  const [after] = await t.db.select().from(consultations);
  assert.equal(after!.status, "answered");
  await t.close();
});

test("complaints, price questions, credit and hours get specific answers", async () => {
  const t = await consented();
  assert.match(textOf(await t.say("The medicine arrived damaged")), /passed this to our manager/);
  assert.equal((await t.db.select().from(consultations))[0]!.kind, "complaint");

  const price = await t.say("what is the price of dolo 650 and crocin");
  assert.match(textOf(price), /Dolo 650, strip of 15 tablets: MRP ₹32\.28 \(₹2\.15 per tablet\)/);
  assert.match(textOf(price), /Crocin Advance, strip of 20 tablets: MRP ₹19\.53/);
  assert.ok(actionsOf(price).includes("add:DOLO650-15"));

  assert.match(textOf(await t.say("can I pay later on credit?")), /can't offer credit/);
  assert.match(textOf(await t.say("what are your timings")), /We're open now until 9:00 PM/);
  await t.close();
});

test("closed hours: the order is scheduled for the next opening", async () => {
  const t = await consented();
  t.clock.now = new Date("2026-10-22T22:30:00+05:30");
  await t.say("eno");
  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /We're closed now\. Your order will be prepared after we open at 9:00 AM tomorrow/);
  await checkout(t);
  const pay = textOf(await t.tap("addr:yes"));
  assert.match(pay, /Delivery after we open at 9:00 AM tomorrow, within 45–60 minutes/);
  const o = await lastOrder(t);
  assert.equal(o.scheduledFor?.toISOString(), new Date("2026-10-23T09:00:00+05:30").toISOString());
  await t.close();
});

test("delivery radius: location is checked against the pharmacy", async () => {
  const t = await consented({
    settings: (s) => {
      s.pharmacy.lat = 23.0225;
      s.pharmacy.lng = 72.5714;
    },
  });
  await t.say("eno");
  await t.tap("items:ok");
  const ask = await checkout(t);
  assert.ok(ask.some((m) => m.requestLocation));

  const far = textOf(await t.send({ location: { lat: 23.25, lng: 72.65 } }));
  assert.match(far, /km away\. We deliver within 10 km/);

  const near = textOf(await t.send({ location: { lat: 23.03, lng: 72.58 } }));
  assert.match(near, /📍 1\.2 km from the pharmacy/);
  assert.match(near, /Delivery within 20–30 minutes/);
  await t.close();
});

test("staff take over a chat, assign an agent, update status, cancel with refund", async () => {
  const t = await consented();
  const manager = await createUser(t.db, { name: "Manager", email: "m@x.in", password: "secret123", roleKey: "manager" });
  const agent = await createUser(t.db, { name: "Ravi", email: "r@x.in", password: "secret123", roleKey: "delivery_agent", phone: "+919812345678" });
  const [cust] = await t.db.select().from(customers);

  await t.engine.setHandoff(cust!.id, manager, manager);
  assert.deepEqual(await t.say("hello, is anyone there?"), []);
  await t.engine.sendStaffMessage(cust!.id, "Hi, this is the manager. How can I help?", manager);
  assert.match(t.telegram.lastText(), /this is the manager/);
  await t.engine.setHandoff(cust!.id, null, manager);

  await t.say("eno");
  await t.tap("items:ok");
  await checkout(t);
  await t.tap("addr:yes");
  await t.tap("pay:upi");
  const o = await lastOrder(t);
  await t.engine.onPaymentEvent({ type: "paid", linkId: o.paymentLinkId!, paymentId: "pay_9", amountPaise: o.totalPaise });
  const enoBefore = await available(t.db, "ENO-LEMON-5G", policy(t.clock.now));

  await t.engine.assignAgent(o.id, agent, manager);
  assert.match(t.telegram.lastText(), /Ravi will deliver your order/);
  await t.engine.setOrderStatus(o.id, "out_for_delivery", agent);
  assert.match(t.telegram.lastText(), /on its way with Ravi \(\+91 98123 45678\)/);
  await assert.rejects(t.engine.setOrderStatus(o.id, "reserved", agent));

  const cancel = await t.engine.cancelOrder(o.id, manager, "Customer asked to cancel");
  assert.equal(cancel.notifyError, null);
  const result = await t.engine.cancelOrder(o.id, manager, "again").catch((e: Error) => e);
  assert.ok(result instanceof Error); // already cancelled
  const cancelled = await lastOrder(t);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.paymentStatus, "refund_pending");
  assert.match(t.telegram.lastText(), /refund of ₹50\.00 has been started/);
  assert.equal(await available(t.db, "ENO-LEMON-5G", policy(t.clock.now)), enoBefore + 1);
  await t.close();
});

test("holds expire; payment link expiry and late payments are handled", async () => {
  const t = await consented();
  await t.say("3 dolo");
  await t.tap("items:ok");
  assert.equal(await available(t.db, "DOLO650-15", policy(t.clock.now)), 197);
  t.advance(16);
  await t.engine.runJobs();
  assert.equal(await available(t.db, "DOLO650-15", policy(t.clock.now)), 200);
  assert.equal((await lastOrder(t)).status, "expired");
  assert.match(textOf(await t.tap("cart:order")), /earlier step/);

  await t.say("eno");
  await t.tap("items:ok");
  await checkout(t);
  await t.tap("addr:yes");
  await t.tap("pay:upi");
  const o = await lastOrder(t);
  await t.engine.onPaymentEvent({ type: "expired", linkId: o.paymentLinkId! });
  assert.equal((await lastOrder(t)).status, "expired");
  await t.engine.onPaymentEvent({ type: "paid", linkId: o.paymentLinkId!, paymentId: "pay_late", amountPaise: o.totalPaise });
  assert.equal((await lastOrder(t)).paymentStatus, "refund_pending");
  assert.match(t.telegram.lastText(), /already closed, so I've started a refund/);
  await t.close();
});

test("interaction rules warn or block; duplicate orders are flagged", async () => {
  const t = await consented();
  await t.db.insert(interactionRules).values({ ingredientA: "aspirin", ingredientB: "paracetamol", message: "TEST RULE: check with the pharmacist.", severity: "block" });
  await t.say("disprin, dolo");
  const blocked = await t.tap("items:ok");
  assert.match(textOf(blocked), /TEST RULE/);
  assert.ok(!actionsOf(blocked).includes("cart:order"));
  assert.ok(actionsOf(blocked).includes("ask:pharmacist"));
  await t.tap("cancel");
  await t.db.delete(interactionRules);

  await t.say("eno");
  await t.tap("items:ok");
  await checkout(t);
  await t.tap("addr:yes");
  await t.tap("pay:cod");
  t.advance(20);
  await t.say("eno");
  assert.match(textOf(await t.tap("items:ok")), /You ordered these same items 20 minutes ago/);
  await t.close();
});

test("WhatsApp: after 24 hours staff replies go out as the approved template", async () => {
  const t = await consented();
  await t.engine.handle({ channel: "whatsapp", channelUserId: "919876543210", messageId: "w1", text: "/start" });
  const [wa] = await t.db.select().from(customers).where(eq(customers.channel, "whatsapp"));
  const staff = await createUser(t.db, { name: "Staff", email: "s@x.in", password: "secret123", roleKey: "manager" });

  await t.engine.sendStaffMessage(wa!.id, "Your medicine is ready.", staff);
  assert.equal(t.whatsapp.sent.at(-1)!.messages[0]!.text, "Your medicine is ready.");

  t.advance(25 * 60);
  await assert.rejects(t.engine.sendStaffMessage(wa!.id, "Hello again", staff), WindowClosedError);
  const s = structuredClone(await t.settings.get());
  s.whatsapp.followUpTemplate = "staff_reply";
  await t.settings.save(s, null);
  await t.engine.sendStaffMessage(wa!.id, "Hello again", staff);
  assert.deepEqual(t.whatsapp.templates.at(-1), { to: "919876543210", template: "staff_reply", params: [s.pharmacy.name, "Hello again"] });
  await t.close();
});

test("emergencies and unanswered questions", async () => {
  const t = await consented();
  assert.match(textOf(await t.say("I took too many pills, overdose")), /Call 112/);
  await t.say("/ask");
  await t.say("Is Dolo safe in pregnancy?");
  t.advance(16);
  await t.engine.runJobs();
  assert.ok(t.events.some((e) => e.type === "consultation.escalated"));
  const [c] = await t.db.select().from(consultations).where(and(eq(consultations.status, "open")));
  assert.ok(c!.escalatedAt);
  await t.close();
});

test("typed lists that match the catalogue don't call the AI", async () => {
  const extractor = new FakeExtractor();
  const t = await consented({ extractor });
  await t.say("eno and vicks");
  assert.equal(extractor.calls, 0);
  extractor.next = { document_type: "text_request", language: "hi", items: [] };
  await t.say("mujhe bukhar hai kuch do");
  assert.equal(extractor.calls, 1);
  void products;
  await t.close();
});
