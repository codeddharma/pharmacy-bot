import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/api/server.ts";
import { createUser } from "../src/db/seed.ts";
import { orders, roles } from "../src/db/schema.ts";
import { consented, setup } from "./helpers.ts";

const WEBHOOK_SECRET = "whsec_test";

async function api(opts?: Parameters<typeof setup>[0]) {
  const t = await consented(opts);
  const app = await buildServer({
    db: t.db,
    engine: t.engine,
    catalogue: t.catalogue,
    settings: t.settings,
    bus: t.bus,
    payments: null,
    uploadsDir: "/tmp/none",
    dashboardDir: null,
    publicUrl: "http://localhost:3000",
    cookieSecure: false,
    razorpayWebhookSecret: WEBHOOK_SECRET,
    now: () => t.clock.now,
  });
  const ids = {
    admin: await createUser(t.db, { name: "Admin", email: "admin@x.in", password: "password1", roleKey: "admin" }),
    manager: await createUser(t.db, { name: "Manager", email: "manager@x.in", password: "password1", roleKey: "manager" }),
    pharmacist: await createUser(t.db, { name: "Dr. Shah", email: "pharma@x.in", password: "password1", roleKey: "pharmacist" }),
    agent: await createUser(t.db, { name: "Ravi", email: "agent@x.in", password: "password1", roleKey: "delivery_agent", phone: "+919812345678" }),
  };
  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "password1" } });
    assert.equal(res.statusCode, 200, res.body);
    return String(res.headers["set-cookie"]).split(";")[0]!;
  };
  const call = async (cookie: string | null, method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { ...t, app, ids, login, call };
}

test("login, sessions and permissions per role", async () => {
  const a = await api();
  assert.equal((await a.call(null, "GET", "/api/products")).status, 401);

  const agent = await a.login("agent@x.in");
  assert.equal((await a.call(agent, "GET", "/api/products")).status, 403);
  assert.equal((await a.call(agent, "GET", "/api/me/deliveries")).status, 200);
  const me = await a.call(agent, "GET", "/api/auth/me");
  assert.deepEqual(me.body.user.permissions, ["deliveries.own"]);

  const pharmacist = await a.login("pharma@x.in");
  assert.equal((await a.call(pharmacist, "GET", "/api/products")).status, 200);
  assert.equal((await a.call(pharmacist, "GET", "/api/users")).status, 403);
  assert.equal((await a.call(pharmacist, "PUT", "/api/settings", await a.settings.get())).status, 403);

  // Wrong passwords lock the account for a while.
  for (let i = 0; i < 5; i++) {
    await a.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "manager@x.in", password: "nope" } });
  }
  const locked = await a.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "manager@x.in", password: "password1" } });
  assert.equal(locked.statusCode, 429);

  // Logging out ends the session.
  await a.call(agent, "POST", "/api/auth/logout");
  assert.equal((await a.call(agent, "GET", "/api/auth/me")).status, 401);
  await a.close();
});

test("admins manage staff and roles, with per-user permission overrides", async () => {
  const a = await api();
  const admin = await a.login("admin@x.in");
  const [agentRole] = await a.db.select().from(roles).where(eq(roles.key, "delivery_agent"));

  const created = await a.call(admin, "POST", "/api/users", {
    name: "Suresh",
    email: "suresh@x.in",
    password: "password1",
    roleId: agentRole!.id,
    phone: "+919800000000",
    vehicle: "Scooter",
    grantPermissions: ["inventory.view"],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.user.permissions.sort(), ["deliveries.own", "inventory.view"]);
  const suresh = await a.login("suresh@x.in");
  assert.equal((await a.call(suresh, "GET", "/api/products")).status, 200);

  const role = await a.call(admin, "POST", "/api/roles", { name: "Store keeper", permissions: ["inventory.view", "inventory.manage"] });
  assert.equal(role.body.role.key, "store_keeper");
  const [adminRole] = await a.db.select().from(roles).where(eq(roles.key, "admin"));
  assert.equal((await a.call(admin, "PATCH", `/api/roles/${adminRole!.id}`, { permissions: ["stats.view"] })).status, 400);
  assert.equal((await a.call(admin, "PATCH", `/api/users/${a.ids.admin}`, { isActive: false })).status, 400);

  // Deactivating someone logs them out.
  await a.call(admin, "PATCH", `/api/users/${created.body.user.id}`, { isActive: false });
  assert.equal((await a.call(suresh, "GET", "/api/auth/me")).status, 401);
  await a.close();
});

test("inventory: add a medicine and a batch, see availability, delete", async () => {
  const a = await api();
  const manager = await a.login("manager@x.in");
  const product = {
    sku: "TESTCAL-10",
    brand: "Testcal",
    generic: "calcium",
    composition: [{ name: "Calcium carbonate", strength: "500 mg" }],
    form: "tablet",
    pack: { size: 10, unit: "tablet", label: "Strip of 10 tablets" },
    manufacturer: "Test Labs",
    category: "vitamins_supplements",
    system: "allopathy",
    schedule: "OTC",
    maxPacksPerOrder: 3,
    mrp: 45.5,
    reorderLevel: 5,
  };
  assert.equal((await a.call(manager, "POST", "/api/products", product)).status, 200);
  assert.equal(a.catalogue.get("TESTCAL-10")?.mrpPaise, 4550);
  assert.equal((await a.call(manager, "POST", "/api/products/TESTCAL-10/batches", { batchNo: "TC1", mfg: "2026-08", exp: "2028-07", qty: 12 })).status, 200);

  const detail = await a.call(manager, "GET", "/api/products/TESTCAL-10");
  assert.equal(detail.body.available, 12);
  assert.equal(detail.body.batches[0].exp, "2028-07-31");

  const low = await a.call(manager, "GET", "/api/products?stock=low");
  assert.ok(low.body.products.some((p: { sku: string }) => p.sku === "OTRIVIN-OXY-10ML"));

  // The bot sees the new medicine straight away.
  await a.say("testcal");
  assert.match((await a.tap("items:ok")).map((m) => m.text).join(), /Testcal \(strip of 10 tablets\) × 1: ₹45\.50/);
  await a.tap("cancel");

  // It has been in a cart, so it's kept for order history and marked discontinued.
  const del = await a.call(manager, "DELETE", "/api/products/TESTCAL-10");
  assert.deepEqual(del.body, { deleted: false, discontinued: true });
  assert.equal(a.catalogue.get("TESTCAL-10")?.active, false);

  // A medicine that was never ordered is deleted outright.
  await a.call(manager, "POST", "/api/products", { ...product, sku: "TESTCAL-20", brand: "Testcal 20" });
  assert.deepEqual((await a.call(manager, "DELETE", "/api/products/TESTCAL-20")).body, { deleted: true, discontinued: false });
  await a.close();
});

test("orders: managers assign agents; agents update only their own deliveries", async () => {
  const a = await api();
  await a.say("eno");
  await a.tap("items:ok");
  await a.tap("cart:order");
  await a.say("Asha");
  await a.say("9876543210");
  await a.say("12 Shanti Nagar, CG Road, Ahmedabad");
  await a.say("380009");
  await a.tap("addr:yes");
  await a.tap("pay:cod");
  const [order] = await a.db.select().from(orders);

  const manager = await a.login("manager@x.in");
  const agent = await a.login("agent@x.in");
  const list = await a.call(manager, "GET", "/api/orders?view=active");
  assert.equal(list.body.orders[0].id, order!.id);
  assert.equal(list.body.orders[0].customerName, "Asha");

  assert.equal((await a.call(agent, "POST", `/api/orders/${order!.id}/status`, { status: "out_for_delivery" })).status, 403);
  assert.equal((await a.call(manager, "POST", `/api/orders/${order!.id}/assign`, { agentId: a.ids.agent })).status, 200);
  assert.equal((await a.call(agent, "GET", "/api/me/deliveries")).body.deliveries.length, 1);
  assert.equal((await a.call(agent, "POST", `/api/orders/${order!.id}/status`, { status: "preparing" })).status, 403);
  assert.equal((await a.call(agent, "POST", `/api/orders/${order!.id}/status`, { status: "out_for_delivery" })).status, 200);
  assert.equal((await a.call(agent, "POST", `/api/orders/${order!.id}/status`, { status: "delivered" })).status, 200);
  assert.match(a.telegram.lastText(), /has been delivered/);

  const detail = await a.call(agent, "GET", `/api/orders/${order!.id}`);
  assert.deepEqual(Object.keys(detail.body.customer).sort(), ["name", "phone"]);
  assert.deepEqual(detail.body.events.map((e: { status: string }) => e.status), ["reserved", "awaiting_payment", "confirmed", "confirmed", "out_for_delivery", "delivered", "delivered"]);

  // Counts per customer, agent and role must belong to the right rows.
  const customersList = await a.call(manager, "GET", "/api/customers");
  assert.equal(customersList.status, 200, JSON.stringify(customersList.body));
  const asha = customersList.body.customers.find((c: { name: string }) => c.name === "Asha");
  assert.equal(asha.orderCount, 1);
  assert.equal(asha.spentPaise, 5000);
  const agentsList = await a.call(manager, "GET", "/api/agents");
  assert.equal(agentsList.body.agents.find((x: { name: string }) => x.name === "Ravi").deliveredToday, 1);
  const admin = await a.login("admin@x.in");
  const rolesList = await a.call(admin, "GET", "/api/roles");
  assert.equal(rolesList.body.roles.find((r: { key: string }) => r.key === "delivery_agent").userCount, 1);
  const inbox = await a.call(manager, "GET", "/api/inbox");
  assert.match(inbox.body.conversations[0].lastText, /has been delivered/);

  const stats = await a.call(manager, "GET", "/api/stats?days=7");
  assert.equal(stats.status, 200);
  assert.equal(stats.body.kpis.ordersToday, 1);
  assert.equal(stats.body.kpis.revenueTodayPaise, 5000);
  assert.equal(stats.body.agents[0].name, "Ravi");
  await a.close();
});

test("pharmacist answers questions; staff reply from the inbox and take over chats", async () => {
  const a = await api();
  await a.say("I have a bad cough, which syrup should I take?");
  await a.tap("ask:pharmacist");
  const pharmacist = await a.login("pharma@x.in");

  const open = await a.call(pharmacist, "GET", "/api/consultations?status=open");
  assert.equal(open.body.consultations.length, 1);
  const id = open.body.consultations[0].id;
  assert.equal((await a.call(pharmacist, "POST", `/api/consultations/${id}/answer`, { answer: "Cough syrups need a prescription. Please share yours." })).status, 200);
  assert.match(a.telegram.lastText(), /Reply from our pharmacist \(Dr\. Shah\)/);

  const inbox = await a.call(pharmacist, "GET", "/api/inbox");
  const customerId = inbox.body.conversations[0].customerId;
  assert.equal((await a.call(pharmacist, "POST", `/api/inbox/${customerId}/takeover`)).status, 200);
  assert.deepEqual(await a.say("ok thanks"), []);
  await a.call(pharmacist, "POST", `/api/inbox/${customerId}/messages`, { text: "You're welcome!" });
  const thread = await a.call(pharmacist, "GET", `/api/inbox/${customerId}/messages`);
  const last = thread.body.messages.at(-1);
  assert.equal(last.sender, "staff");
  assert.equal(last.staffName, "Dr. Shah");
  await a.call(pharmacist, "POST", `/api/inbox/${customerId}/release`);
  await a.close();
});

test("settings and the open/closed switch", async () => {
  const a = await api();
  const manager = await a.login("manager@x.in");
  const s = structuredClone(await a.settings.get());
  s.hours.weekly[4] = { open: "10:00", close: "19:00", closed: false };
  s.delivery.radiusKm = 7;
  assert.equal((await a.call(manager, "PUT", "/api/settings", s)).status, 200);
  assert.equal((await a.settings.get()).delivery.radiusKm, 7);

  const bad = structuredClone(s);
  bad.hours.weekly[0]!.open = "9am";
  assert.equal((await a.call(manager, "PUT", "/api/settings", bad)).status, 400);

  const closed = await a.call(manager, "POST", "/api/shop-status", { override: "closed" });
  assert.equal(closed.body.open, false);
  assert.match(closed.body.nextOpenText, /tomorrow/);
  await a.close();
});

test("Razorpay webhook: signature checked, payment confirms the order", async () => {
  const a = await api();
  const body = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1" } }, payment: { entity: { id: "pay_1", amount: 5000 } } } });
  const bad = await a.app.inject({ method: "POST", url: "/webhooks/razorpay", payload: body, headers: { "content-type": "application/json", "x-razorpay-signature": "nope" } });
  assert.equal(bad.statusCode, 401);
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const ok = await a.app.inject({ method: "POST", url: "/webhooks/razorpay", payload: body, headers: { "content-type": "application/json", "x-razorpay-signature": sig } });
  assert.equal(ok.statusCode, 200);
  await a.close();
});

test("live events reach only staff allowed to see them", async () => {
  const a = await api();
  await a.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (a.app.server.address() as { port: number }).port;
  const read = async (cookie: string) => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read(); // "retry:" preamble
    return { reader, stop: () => ctrl.abort() };
  };
  const pharmacist = await read(await a.login("pharma@x.in"));
  const agent = await read(await a.login("agent@x.in"));

  a.bus.emit({ type: "consultation.created", id: 7, kind: "question" });
  a.bus.emit({ type: "settings.changed" });
  const chunk = new TextDecoder().decode((await pharmacist.reader.read()).value);
  assert.match(chunk, /"consultation.created"/);
  const agentChunk = new TextDecoder().decode((await agent.reader.read()).value);
  assert.match(agentChunk, /"settings.changed"/);
  assert.doesNotMatch(agentChunk, /consultation/);
  pharmacist.stop();
  agent.stop();
  await a.app.close();
  await a.close();
});
