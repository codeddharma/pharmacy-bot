import assert from "node:assert/strict";
import { test } from "node:test";
import { available } from "../src/core/inventory.ts";
import { actionsOf, consented, FakeExtractor, setup, textOf } from "./helpers.ts";

test("asks for consent before anything else", async () => {
  const t = await setup();
  const out = await t.say("dolo");
  assert.match(textOf(out), /Do you agree\?/);
  assert.deepEqual(actionsOf(out), ["consent:yes"]);
  const ready = await t.tap("consent:yes");
  assert.match(textOf(ready), /You're all set/);
  assert.ok(t.store.customers.data[t.user]?.consentAt);
});

test("full OTC order: typed list, cart, details, UPI mock payment, FEFO stock deduction", async () => {
  const t = await consented();

  const confirm = await t.say("2 strips dolo 650, crocin");
  assert.match(textOf(confirm), /1\. Dolo 650 .* × 2/);
  assert.match(textOf(confirm), /2\. Crocin Advance .* × 1/);

  const cart = await t.tap("items:ok");
  const cartText = textOf(cart);
  assert.match(cartText, /Dolo 650 \(strip of 15 tablets\) × 2: ₹64\.56/);
  assert.match(cartText, /Total: ₹124\.09/); // 64.56 + 19.53 + ₹40 delivery
  assert.match(cartText, /More than one of these contains paracetamol/);
  assert.equal(t.store.inventory.data.items["DOLO650-15"]!.reserved, 2);

  assert.match(textOf(await t.tap("cart:order")), /What name/);
  assert.match(textOf(await t.say("Asha Patel")), /mobile number/);
  assert.match(textOf(await t.say("12345")), /10-digit Indian mobile/);
  assert.match(textOf(await t.say("+91 98765 43210")), /delivery address/);
  assert.match(textOf(await t.say("12 Shanti Nagar, CG Road, Ahmedabad")), /PIN code/);
  assert.match(textOf(await t.say("38001")), /valid 6-digit PIN/);
  const addr = await t.say("380009");
  assert.match(textOf(addr), /Deliver to:\nAsha Patel\n\+91 98765 43210/);

  const pay = await t.tap("addr:yes");
  assert.deepEqual(actionsOf(pay), ["pay:upi", "pay:cod", "cancel"]);

  const done = await t.tap("pay:upi");
  assert.match(textOf(done), /Payment accepted \(demo/);

  const order = t.store.orders.data.at(-1)!;
  assert.equal(order.status, "paid");
  assert.equal(order.id, "PB-261022-0001");
  // FEFO: the earlier-expiring Dolo batch (DOL6A114, 80 packs) is used first.
  const dolo = t.store.inventory.data.items["DOLO650-15"]!;
  assert.equal(dolo.reserved, 0);
  assert.equal(dolo.batches.find((b) => b.batch === "DOL6A114")!.qty, 78);
  assert.deepEqual(order.lines.find((l) => l.sku === "DOLO650-15")!.batches, [{ batch: "DOL6A114", exp: "2028-08", qty: 2 }]);
  assert.equal(t.store.reservations.data.length, 0);
  assert.equal(t.sentToAdmins.length, 1);
  assert.match(t.sentToAdmins[0]!, /New order PB-261022-0001/);

  // Second order reuses saved details and goes straight to the address check.
  await t.say("eno");
  await t.tap("items:ok");
  assert.match(textOf(await t.tap("cart:order")), /Deliver to:/);
});

test("prescription and Schedule X medicines are refused, OTC items still go through", async () => {
  const t = await consented();
  await t.say("augmentin 625\nlimcee\naddwize");
  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /Limcee/);
  assert.match(cart, /Augmentin 625 Duo: Needs a doctor's prescription checked by our pharmacist \(Schedule H\)/);
  assert.match(cart, /Addwize 10mg: Schedule X medicine\. It can't be sold online\./);
  assert.equal(t.store.orders.data.at(-1)!.lines.length, 1);
});

test("only prescription items: no order is created", async () => {
  const t = await consented();
  await t.say("taxim o 200");
  const out = textOf(await t.tap("items:ok"));
  assert.match(out, /can't add any of these/);
  assert.match(out, /Schedule H1/);
  assert.equal(t.store.orders.data.length, 0);
  assert.equal(t.store.sessions.data[t.user]!.state, "idle");
});

test("out of stock offers notify-me, and /addstock tells waiting customers", async () => {
  const t = await consented();
  await t.say("otrivin");
  const out = await t.tap("items:ok");
  assert.match(textOf(out), /Out of stock right now/);
  assert.ok(actionsOf(out).includes("notify:OTRIVIN-OXY-10ML"));

  assert.match(textOf(await t.tap("notify:OTRIVIN-OXY-10ML")), /I'll message you/);
  assert.equal(t.store.waitlist.data.length, 1);

  const admin = await t.engine.handle({ userId: "tg:999", channel: "telegram", messageId: "a1", text: "/addstock OTRIVIN-OXY-10ML 20 OTX6J001 2028-09" });
  assert.match(textOf(admin), /Now 20 available\. Told 1 waiting customer/);
  assert.match(t.sentToUsers.at(-1)!.messages[0]!.text, /Otrivin Oxy Fast Relief Nasal Spray is back in stock/);
  assert.equal(t.store.waitlist.data.length, 0);
});

test("near-expiry batches aren't sold; quantity is capped by per-order limit and stock", async () => {
  const t = await consented();
  const now = t.clock.now;
  assert.equal(available(t.store, "SHELCAL500-15", now), 6); // 10 packs expire Dec 2026
  assert.equal(available(t.store, "HEXIDINE-160ML", now), 0); // only near-expiry stock
  assert.equal(available(t.store, "ZANDU-BALM-10ML", now), 4); // 6 minus 2 held

  await t.say("8 strips shelcal, 3 volini gel");
  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /Shelcal 500 .* × 4/);
  assert.match(cart, /Limited to 4 per order/);
  assert.match(cart, /Volini Pain Relief Gel .* × 3/);
});

test("discontinued product is swapped for its replacement with a note", async () => {
  const t = await consented();
  await t.say("dulcolax");
  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /Dulcoflex 5mg Tablet/);
  assert.match(cart, /Replaces Dulcolax 5mg Tablet, which is discontinued/);
});

test("generic name asks the customer to pick a brand", async () => {
  const t = await consented();
  const out = await t.say("paracetamol 500");
  assert.match(textOf(out), /which one did you mean/);
  const actions = actionsOf(out);
  assert.ok(actions.includes("pick:0:CROCINADV500-20"));
  assert.ok(actions.includes("pick:0:CALPOL500-15"));

  assert.match(textOf(await t.tap("items:ok")), /Please choose an option for item 1/);
  const picked = await t.tap("pick:0:CALPOL500-15");
  assert.match(textOf(picked), /1\. Calpol 500/);
  assert.match(textOf(await t.tap("items:ok")), /Calpol 500 .* × 1/);
});

test("photo goes to the extractor; unit counts become packs; low confidence is flagged", async () => {
  const extractor = new FakeExtractor();
  extractor.next = {
    document_type: "prescription",
    language: "en",
    items: [
      { as_written: "Tab Limcee 500", name: "Limcee", strength: "500 mg", quantity: 20, quantity_unit: "unit", confidence: 0.9 },
      { as_written: "Cetzine", name: "Cetzine", strength: "10 mg", quantity: null, quantity_unit: null, confidence: 0.5 },
    ],
  };
  const t = await consented({ extractor });
  const out = await t.send({ media: { kind: "image", mimeType: "image/jpeg", data: Buffer.from("fake") } });
  assert.equal(extractor.calls, 1);
  assert.match(t.sentToUsers.at(-1)!.messages[0]!.text, /Reading your prescription/);
  const text = textOf(out);
  assert.match(text, /Limcee .* × 2/); // 20 tablets / strip of 15 = 2 strips
  assert.match(text, /Cetzine 10mg .*⚠️ please check/);

  const cart = textOf(await t.tap("items:ok"));
  assert.match(cart, /Cetzine 10mg: Needs a doctor's prescription/);
});

test("typed text that matches the catalogue doesn't call the LLM", async () => {
  const extractor = new FakeExtractor();
  const t = await consented({ extractor });
  await t.say("eno and vicks");
  assert.equal(extractor.calls, 0);
  await t.say("mujhe bukhar hai kuch do");
  assert.equal(extractor.calls, 1);
});

test("emergency phrases get emergency guidance instead of an order", async () => {
  const t = await consented();
  const out = textOf(await t.say("I want to overdose on sleeping pills"));
  assert.match(out, /Call 112/);
  assert.match(out, /14416/);
});

test("reservations expire after 15 minutes and release the stock", async () => {
  const t = await consented();
  await t.say("3 dolo");
  await t.tap("items:ok");
  assert.equal(t.store.inventory.data.items["DOLO650-15"]!.reserved, 3);

  t.advance(16);
  await t.engine.runJobs();
  assert.equal(t.store.inventory.data.items["DOLO650-15"]!.reserved, 0);
  assert.equal(t.store.orders.data.at(-1)!.status, "expired");
  assert.equal(t.store.sessions.data[t.user]!.state, "idle");
  assert.match(t.sentToUsers.at(-1)!.messages[0]!.text, /expired after 15 minutes/);
  assert.match(textOf(await t.tap("cart:order")), /earlier step/);
});

test("cash on delivery confirms the order without payment", async () => {
  const t = await consented();
  await t.say("eno");
  await t.tap("items:ok");
  await t.tap("cart:order");
  await t.say("Ravi Kumar");
  await t.send({ contactPhone: "919876543210" });
  await t.say("Flat 4B, Lake View Apartments, Navrangpura, Ahmedabad");
  await t.say("380009");
  await t.say("yes");
  const done = textOf(await t.tap("pay:cod"));
  assert.match(done, /keep ₹50\.00 ready/); // ₹10 + ₹40 delivery
  assert.equal(t.store.orders.data.at(-1)!.status, "cod_confirmed");
});

test("cancel releases held stock", async () => {
  const t = await consented();
  await t.say("2 betadine");
  await t.tap("items:ok");
  assert.equal(t.store.inventory.data.items["BETADINE-OINT-20G"]!.reserved, 2);
  await t.say("no");
  assert.equal(t.store.inventory.data.items["BETADINE-OINT-20G"]!.reserved, 0);
  assert.equal(t.store.orders.data.at(-1)!.status, "cancelled");
});
