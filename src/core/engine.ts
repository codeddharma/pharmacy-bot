import type { Config } from "../config.ts";
import { ExtractorBusyError, type Extraction, type ExtractedItem, type Extractor } from "../extract/types.ts";
import type { CatalogueStore } from "../store/catalogue.ts";
import type { Store } from "../store/db.ts";
import type {
  Button,
  Customer,
  DraftItem,
  InboundMessage,
  Order,
  OutboundMessage,
  Product,
  Session,
  SessionState,
} from "../types.ts";
import { adminCommand, isAdmin } from "./admin.ts";
import { rupees, shortLabel } from "./format.ts";
import { commitOrder, expireReservations, extendOrder, releaseOrder } from "./inventory.ts";
import { Matcher } from "./matcher.ts";
import { createReservedOrder, getOrder, OPEN_STATUSES, updateOrder, type CartRequest } from "./orders.ts";
import { isNo, isYes, parseTypedList } from "./parse.ts";
import type { PaymentProvider } from "./payment.ts";
import { decide } from "./rules.ts";
import { EMERGENCY_MESSAGE, isRedFlag } from "./safety.ts";

export interface Notifier {
  toUser(userId: string, messages: OutboundMessage[]): Promise<void>;
  toAdmins(text: string): Promise<void>;
}

export interface EngineDeps {
  store: Store;
  catalogue: CatalogueStore;
  extractor: Extractor | null;
  payment: PaymentProvider;
  notifier: Notifier;
  config: Config;
  now?: () => Date;
}

const LOW_CONFIDENCE = 0.6;
const MAX_PACKS_PER_LINE = 10;

/** What typing "yes" means in each state. Payment is left out on purpose: that needs a tap. */
const YES_ACTION: Partial<Record<SessionState, string>> = {
  confirm_items: "items:ok",
  cart_review: "cart:order",
  confirm_address: "addr:yes",
};

const STALE = "That button is from an earlier step. Send your medicine list to start again, or /help.";

/**
 * The conversation, independent of Telegram or WhatsApp: a channel adapter turns
 * updates into InboundMessages and renders the OutboundMessages this returns.
 */
export class Engine {
  private matcher: Matcher;
  private userQueues = new Map<string, Promise<unknown>>();
  private seenIds: string[] = [];
  private seen = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.matcher = new Matcher(deps.catalogue.products);
    deps.catalogue.onChange(() => {
      this.matcher = new Matcher(deps.catalogue.products);
    });
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Handles one message. Messages from the same user run one at a time, in order. */
  handle(msg: InboundMessage): Promise<OutboundMessage[]> {
    if (this.seen.has(msg.messageId)) return Promise.resolve([]);
    this.seen.add(msg.messageId);
    this.seenIds.push(msg.messageId);
    if (this.seenIds.length > 2000) this.seen.delete(this.seenIds.shift()!);
    return this.withUser(msg.userId, () => this.process(msg));
  }

  private withUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userQueues.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.userQueues.set(userId, tail);
    void tail.then(() => {
      if (this.userQueues.get(userId) === tail) this.userQueues.delete(userId);
    });
    return run;
  }

  // ---------- state helpers ----------

  private getSession(userId: string): Session {
    return this.deps.store.sessions.data[userId] ?? { state: "idle", updatedAt: this.now().toISOString() };
  }

  private async setSession(userId: string, session: Omit<Session, "updatedAt">): Promise<void> {
    const { store } = this.deps;
    await store.withLock(async () => {
      store.sessions.data[userId] = { ...session, updatedAt: this.now().toISOString() };
      await store.sessions.write();
    });
  }

  private getCustomer(userId: string): Customer {
    return this.deps.store.customers.data[userId] ?? {};
  }

  private async updateCustomer(userId: string, patch: Partial<Customer>): Promise<Customer> {
    const { store } = this.deps;
    return store.withLock(async () => {
      const next = { ...store.customers.data[userId], ...patch };
      store.customers.data[userId] = next;
      await store.customers.write();
      return next;
    });
  }

  /** Drops the customer's open cart (if any) and returns them to idle. */
  private async abandon(userId: string, session: Session, status: "cancelled" | "expired"): Promise<void> {
    const order = getOrder(this.deps.store, session.orderId);
    if (order && OPEN_STATUSES.includes(order.status)) {
      await releaseOrder(this.deps.store, order.id);
      await updateOrder(this.deps.store, order.id, { status }, this.now());
      await this.deps.store.audit(`order_${status}`, userId, { orderId: order.id });
    }
    await this.setSession(userId, { state: "idle" });
  }

  // ---------- main dispatch ----------

  private async process(msg: InboundMessage): Promise<OutboundMessage[]> {
    const { config } = this.deps;
    const userId = msg.userId;
    let session = this.getSession(userId);

    const idleMinutes = (this.now().getTime() - new Date(session.updatedAt).getTime()) / 60_000;
    if (session.state !== "idle" && session.state !== "awaiting_consent" && idleMinutes > config.sessionTimeoutMinutes) {
      await this.abandon(userId, session, "expired");
      session = this.getSession(userId);
    }

    const text = msg.text?.trim() ?? "";
    if (text.startsWith("/") && !msg.media) return this.command(msg, session, text);

    const customer = this.getCustomer(userId);
    if (!customer.consentAt) {
      if (msg.action === "consent:yes") {
        await this.updateCustomer(userId, { consentAt: this.now().toISOString() });
        await this.setSession(userId, { state: "idle" });
        await this.deps.store.audit("consent_given", userId);
        return [{ text: READY_TEXT }];
      }
      await this.setSession(userId, { state: "awaiting_consent" });
      return [this.consentMessage()];
    }

    if (msg.action) return this.onAction(msg, session, msg.action);

    if (text && isRedFlag(text)) {
      await this.deps.store.audit("red_flag", userId, { text });
      return [{ text: EMERGENCY_MESSAGE }];
    }

    if (!msg.media) {
      switch (session.state) {
        case "collect_name":
          return this.onName(userId, session, text);
        case "collect_phone":
          return this.onPhone(userId, session, msg.contactPhone ?? text);
        case "collect_address":
          return this.onAddress(userId, session, text);
        case "collect_pincode":
          return this.onPincode(userId, session, text);
      }
      const yes = YES_ACTION[session.state];
      if (yes && isYes(text)) return this.onAction(msg, session, yes);
      if (session.state !== "idle" && isNo(text)) return this.onAction(msg, session, "cancel");
      if (session.state === "awaiting_payment" && isYes(text)) {
        return [{ text: "Please tap one of the payment buttons above." }];
      }
    }

    if (!text && !msg.media) {
      return [{ text: "Please send a photo or PDF of your prescription, or type the medicine names." }];
    }
    return this.newRequest(msg, session);
  }

  private async command(msg: InboundMessage, session: Session, text: string): Promise<OutboundMessage[]> {
    const { config, store } = this.deps;
    const cmd = text.split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, "");
    const customer = this.getCustomer(msg.userId);

    switch (cmd) {
      case "/start":
        if (!customer.consentAt) {
          await this.setSession(msg.userId, { state: "awaiting_consent" });
          return [this.consentMessage()];
        }
        return [{ text: READY_TEXT }];
      case "/help":
        return [{ text: helpText(config.pharmacyPhone) }];
      case "/cancel":
        await this.abandon(msg.userId, session, "cancelled");
        return [{ text: "Cancelled. Send a new list whenever you're ready.", removeKeyboard: true }];
      case "/status": {
        const mine = store.orders.data.filter((o) => o.userId === msg.userId).slice(-3).reverse();
        if (mine.length === 0) return [{ text: "You don't have any orders yet." }];
        return [{ text: "Your recent orders:\n\n" + mine.map(orderSummaryLine).join("\n") }];
      }
      case "/pharmacist":
        return [{ text: `You can reach our pharmacist on ${config.pharmacyPhone}.` }];
    }

    if (isAdmin(msg.userId, config)) {
      const reply = await adminCommand(
        { store, catalogue: this.deps.catalogue, matcher: this.matcher, notifier: this.deps.notifier, now: this.now() },
        text,
      );
      if (reply) return reply;
    }
    return [{ text: "I don't know that command. Try /help." }];
  }

  private async onAction(msg: InboundMessage, session: Session, action: string): Promise<OutboundMessage[]> {
    const userId = msg.userId;
    const [verb, a, b] = action.split(":");

    switch (verb) {
      case "consent":
        return [{ text: READY_TEXT }];

      case "notify":
        return this.joinWaitlist(userId, a ?? "");

      case "cancel":
        await this.abandon(userId, session, "cancelled");
        return [{ text: "Cancelled. Send a new list whenever you're ready.", removeKeyboard: true }];

      case "items":
        if (session.state !== "confirm_items" && session.state !== "edit_items") return [{ text: STALE }];
        if (a === "edit") {
          await this.setSession(userId, { ...session, state: "edit_items" });
          return [{ text: 'Type the correct list, one medicine per line. For example:\n2 Dolo 650\nCrocin Advance\nEno' }];
        }
        return this.buildCart(userId, session, msg.channel);

      case "pick":
      case "drop": {
        if (session.state !== "confirm_items" || !session.draft) return [{ text: STALE }];
        const idx = Number(a);
        const item = session.draft[idx];
        if (!item) return [{ text: STALE }];
        let draft = session.draft;
        if (verb === "pick") {
          if (!b || !item.candidates.includes(b)) return [{ text: STALE }];
          draft = draft.map((d, i) => (i === idx ? { ...d, chosenSku: b, candidates: [b] } : d));
        } else {
          draft = draft.filter((_, i) => i !== idx);
        }
        if (draft.length === 0) {
          await this.setSession(userId, { state: "idle" });
          return [{ text: "Nothing left in the list. Send your medicines again whenever you're ready." }];
        }
        await this.setSession(userId, { state: "confirm_items", draft });
        return [this.renderConfirm(draft)];
      }

      case "cart":
        if (session.state !== "cart_review" || !session.orderId) return [{ text: STALE }];
        await extendOrder(this.deps.store, session.orderId, this.now(), this.deps.config.reservationMinutes);
        return this.askNextDetail(userId, session);

      case "addr":
        if (session.state !== "confirm_address" || !session.orderId) return [{ text: STALE }];
        if (a === "change") {
          await this.setSession(userId, { ...session, state: "collect_address" });
          return [{ text: "Please type the delivery address: house or flat, street, area and city." }];
        }
        return this.toPayment(userId, session);

      case "pay":
        if (session.state !== "awaiting_payment" || !session.orderId) return [{ text: STALE }];
        return this.pay(userId, session, a === "cod" ? "cod" : "upi_mock");
    }
    return [{ text: STALE }];
  }

  // ---------- step 1-2: read the request and confirm the list ----------

  private async newRequest(msg: InboundMessage, session: Session): Promise<OutboundMessage[]> {
    const { store, extractor, notifier, catalogue } = this.deps;
    const userId = msg.userId;
    if (session.orderId) await this.abandon(userId, session, "cancelled");

    const knownNames = catalogue.products.filter((p) => p.active).map((p) => p.brand);
    let draft: DraftItem[] = [];
    let extraction: Extraction | null = null;

    try {
      if (msg.media) {
        const ext = msg.media.kind === "pdf" ? "pdf" : (msg.media.mimeType.split("/")[1] ?? "jpg");
        const file = await store.saveUpload(userId, msg.media.data, ext);
        await store.audit("upload", userId, { file, mimeType: msg.media.mimeType, bytes: msg.media.data.length });
        if (!extractor) {
          return [{ text: "Reading photos and PDFs isn't switched on yet. Please type the medicine names, one per line." }];
        }
        await notifier.toUser(userId, [{ text: msg.media.kind === "pdf" ? "Reading your PDF…" : "Reading your prescription…" }]);
        extraction = await extractor.extract({ media: msg.media, text: msg.text, knownNames });
      } else {
        const typed = parseTypedList(msg.text ?? "");
        const matched = typed.map((t) => ({ t, m: this.matcher.match(t.name) }));
        const allFound = matched.length > 0 && matched.every((x) => x.m.candidates.length > 0);
        if (allFound || !extractor) {
          draft = matched.map(({ t, m }) => ({
            asWritten: t.raw,
            quantity: Math.min(t.quantity, MAX_PACKS_PER_LINE),
            confidence: 1,
            candidates: m.candidates,
            chosenSku: m.chosen,
          }));
          await store.audit("parsed_typed", userId, { text: msg.text, items: draft });
        } else {
          extraction = await extractor.extract({ text: msg.text, knownNames });
        }
      }
    } catch (err) {
      if (err instanceof ExtractorBusyError) {
        console.warn(`[extract] ${err.message}`);
        return [{ text: "I'm getting a lot of requests right now. Please send that again in a minute." }];
      }
      throw err;
    }

    if (extraction) {
      await store.audit("extraction", userId, { extractor: extractor?.name, ...extraction });
      if (extraction.language) await this.updateCustomer(userId, { language: extraction.language });
      draft = extraction.items.map((item) => this.draftFromExtraction(item));
      if (draft.length === 0) return [{ text: this.nothingFoundText(extraction) }];
    }
    if (draft.length === 0) return [{ text: this.nothingFoundText(null) }];

    draft = mergeDuplicates(draft);
    await this.setSession(userId, { state: "confirm_items", draft });
    return [this.renderConfirm(draft)];
  }

  private draftFromExtraction(item: ExtractedItem): DraftItem {
    const query = item.strength && !/\d/.test(item.name) ? `${item.name} ${item.strength}` : item.name;
    const m = this.matcher.match(query);
    const product = m.chosen ? this.deps.catalogue.get(m.chosen) : undefined;
    let packs = 1;
    if (item.quantity && item.quantity > 0) {
      packs = item.quantity_unit === "unit" && product ? Math.ceil(item.quantity / product.pack.size) : Math.round(item.quantity);
    }
    return {
      asWritten: item.as_written || item.name,
      quantity: Math.min(Math.max(packs, 1), MAX_PACKS_PER_LINE),
      confidence: item.confidence,
      candidates: m.candidates,
      chosenSku: m.chosen,
    };
  }

  private nothingFoundText(extraction: Extraction | null): string {
    const phone = this.deps.config.pharmacyPhone;
    if (extraction?.document_type === "unreadable") {
      return "I couldn't read that. Please send a clearer photo in good light, or type the medicine names.";
    }
    if (extraction?.document_type === "other") {
      return "That doesn't look like a prescription or a medicine. Please send a prescription, a photo of the strip, or type the names.";
    }
    return (
      "I couldn't find a medicine name in that. Please type the name as it's written on the strip or prescription.\n\n" +
      `I can't suggest medicines for symptoms. For advice, please talk to our pharmacist on ${phone}.`
    );
  }

  private renderConfirm(draft: DraftItem[]): OutboundMessage {
    const { catalogue } = this.deps;
    const lines: string[] = [];
    const buttons: Button[][] = [];
    let anyLow = false;

    draft.forEach((d, i) => {
      const n = i + 1;
      if (d.chosenSku) {
        const p = catalogue.get(d.chosenSku)!;
        const low = d.confidence < LOW_CONFIDENCE;
        anyLow ||= low;
        lines.push(`${n}. ${p.brand} (${compositionText(p)}), ${p.pack.label.toLowerCase()} × ${d.quantity}${low ? "  ⚠️ please check" : ""}`);
      } else if (d.candidates.length > 0) {
        lines.push(`${n}. "${d.asWritten}": which one did you mean?`);
        for (const sku of d.candidates) {
          const p = catalogue.get(sku)!;
          buttons.push([{ label: `${n}: ${shortLabel(p.brand, 28)} (${p.pack.label.toLowerCase()})`, action: `pick:${i}:${sku}` }]);
        }
        buttons.push([{ label: `${n}: None of these`, action: `drop:${i}` }]);
      } else {
        lines.push(`${n}. "${d.asWritten}": not in our catalogue`);
      }
    });

    buttons.push([
      { label: "✅ Yes, continue", action: "items:ok" },
      { label: "✏️ Edit list", action: "items:edit" },
    ]);
    buttons.push([{ label: "✖ Cancel", action: "cancel" }]);

    const text =
      "Here's what I found:\n\n" +
      lines.join("\n") +
      (anyLow ? "\n\n⚠️ I wasn't sure I read some of these correctly. Please check them." : "") +
      "\n\nIs this correct?";
    return { text, buttons };
  }

  // ---------- step 3-4: rules, stock and the cart ----------

  private async buildCart(userId: string, session: Session, channel: string): Promise<OutboundMessage[]> {
    const { store, catalogue, config } = this.deps;
    const draft = session.draft ?? [];

    const pending = draft.findIndex((d) => !d.chosenSku && d.candidates.length > 0);
    if (pending >= 0) {
      return [{ text: `Please choose an option for item ${pending + 1} first, or tap "None of these".` }, this.renderConfirm(draft)];
    }

    const requests = new Map<string, CartRequest>();
    const excluded: { name: string; reason: string }[] = [];
    for (const d of draft) {
      const decision = decide(catalogue, d.chosenSku, d.asWritten, d.quantity, config.pharmacyPhone);
      if (decision.kind === "refuse") {
        excluded.push({ name: decision.name, reason: decision.reason });
        await store.audit("item_refused", userId, { sku: decision.product?.sku, asWritten: d.asWritten, code: decision.code });
        continue;
      }
      if (decision.qty <= 0) continue;
      const existing = requests.get(decision.product.sku);
      if (existing) {
        existing.qty = Math.min(existing.qty + decision.qty, decision.product.max_packs_per_order);
      } else {
        requests.set(decision.product.sku, { product: decision.product, qty: decision.qty, notes: decision.notes });
      }
    }

    const { order, outOfStock } =
      requests.size > 0
        ? await createReservedOrder(store, {
            userId,
            channel,
            requests: [...requests.values()],
            excluded,
            pricing: { deliveryFee: config.deliveryFee, freeDeliveryAbove: config.freeDeliveryAbove },
            now: this.now(),
            ttlMinutes: config.reservationMinutes,
          })
        : { order: null, outOfStock: [] as Product[] };

    const notifyButtons: Button[][] = outOfStock.map((p) => [
      { label: `🔔 Tell me when ${shortLabel(p.brand, 22)} is back`, action: `notify:${p.sku}` },
    ]);

    if (!order) {
      await this.setSession(userId, { state: "idle" });
      const all = [...excluded, ...outOfStock.map((p) => ({ name: p.brand, reason: "Out of stock right now." }))];
      return [
        {
          text: "I can't add any of these to an order:\n\n" + all.map((e) => `• ${e.name}: ${e.reason}`).join("\n") +
            "\n\nSend another list whenever you like.",
          buttons: notifyButtons,
        },
      ];
    }

    await store.audit("order_reserved", userId, { orderId: order.id, total: order.total, lines: order.lines.length });
    await this.setSession(userId, { state: "cart_review", orderId: order.id });
    return [this.renderCart(order, notifyButtons)];
  }

  private renderCart(order: Order, extraButtons: Button[][]): OutboundMessage {
    const { catalogue, config } = this.deps;
    const out: string[] = ["Your order:"];
    let paracetamolLines = 0;

    for (const l of order.lines) {
      const p = catalogue.get(l.sku);
      if (p?.composition.some((c) => /paracetamol/i.test(c.name))) paracetamolLines++;
      out.push(`• ${l.brand} (${l.packLabel.toLowerCase()}) × ${l.qty}: ${rupees(l.lineTotal)}`);
      if (l.note) out.push(`   ${l.note}`);
      for (const w of p?.warnings ?? []) if (!w.startsWith("Contains paracetamol")) out.push(`   ⚠️ ${w}`);
    }
    if (paracetamolLines >= 2) out.push("\n⚠️ More than one of these contains paracetamol. Don't take them together.");

    out.push("");
    out.push(`Subtotal: ${rupees(order.subtotal)}`);
    out.push(
      order.deliveryFee > 0
        ? `Delivery: ${rupees(order.deliveryFee)} (free on orders of ${rupees(config.freeDeliveryAbove)} or more)`
        : "Delivery: free",
    );
    out.push(`Total: ${rupees(order.total)}`);

    if (order.excluded.length > 0) {
      out.push("", "Not included:");
      for (const e of order.excluded) out.push(`• ${e.name}: ${e.reason}`);
    }

    out.push("", `Prices are MRP, GST included. I'm holding this stock for ${config.reservationMinutes} minutes.`);
    out.push("", "Would you like to place the order?");

    return {
      text: out.join("\n"),
      buttons: [
        [{ label: "✅ Yes, place order", action: "cart:order" }],
        [{ label: "✖ No, cancel", action: "cancel" }],
        ...extraButtons,
      ],
    };
  }

  private async joinWaitlist(userId: string, sku: string): Promise<OutboundMessage[]> {
    const { store, catalogue } = this.deps;
    const product = catalogue.get(sku);
    if (!product) return [{ text: STALE }];
    await store.withLock(async () => {
      if (!store.waitlist.data.some((w) => w.userId === userId && w.sku === sku)) {
        store.waitlist.data.push({ userId, sku, createdAt: this.now().toISOString() });
        await store.waitlist.write();
      }
    });
    return [{ text: `Done. I'll message you when ${product.brand} is back in stock.` }];
  }

  // ---------- step 5: delivery details ----------

  private async askNextDetail(userId: string, session: Session): Promise<OutboundMessage[]> {
    const c = this.getCustomer(userId);
    if (!c.name) {
      await this.setSession(userId, { ...session, state: "collect_name" });
      return [{ text: "What name should we put on the delivery?" }];
    }
    if (!c.phone) {
      await this.setSession(userId, { ...session, state: "collect_phone" });
      return [
        {
          text: "What's your mobile number? Type it, or tap the button below to share it.",
          requestContact: true,
        },
      ];
    }
    if (!c.address) {
      await this.setSession(userId, { ...session, state: "collect_address" });
      return [{ text: "Please type the delivery address: house or flat, street, area and city.", removeKeyboard: true }];
    }
    if (!c.pincode) {
      await this.setSession(userId, { ...session, state: "collect_pincode" });
      return [{ text: "What's the 6-digit PIN code?" }];
    }
    await this.setSession(userId, { ...session, state: "confirm_address" });
    return [
      {
        text: `Deliver to:\n${c.name}\n${formatPhone(c.phone)}\n${c.address}\nPIN ${c.pincode}\n\nIs this right?`,
        buttons: [
          [
            { label: "✅ Yes", action: "addr:yes" },
            { label: "✏️ Change address", action: "addr:change" },
          ],
          [{ label: "✖ Cancel", action: "cancel" }],
        ],
        removeKeyboard: true,
      },
    ];
  }

  private async onName(userId: string, session: Session, text: string): Promise<OutboundMessage[]> {
    const name = text.replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name)) return [{ text: "Please type your full name." }];
    await this.updateCustomer(userId, { name });
    await this.touchOrder(session);
    return this.askNextDetail(userId, session);
  }

  private async onPhone(userId: string, session: Session, text: string): Promise<OutboundMessage[]> {
    const phone = normalizeIndianMobile(text);
    if (!phone) {
      return [
        {
          text: "Please send a 10-digit Indian mobile number, like 98765 43210, or tap the button to share it.",
          requestContact: true,
        },
      ];
    }
    await this.updateCustomer(userId, { phone });
    await this.touchOrder(session);
    return this.askNextDetail(userId, session);
  }

  private async onAddress(userId: string, session: Session, text: string): Promise<OutboundMessage[]> {
    const address = text.replace(/\s+/g, " ").trim();
    if (address.length < 10) return [{ text: "Please type the full address: house or flat, street, area and city." }];
    await this.updateCustomer(userId, { address, pincode: undefined });
    await this.touchOrder(session);
    return this.askNextDetail(userId, session);
  }

  private async onPincode(userId: string, session: Session, text: string): Promise<OutboundMessage[]> {
    const pincode = text.replace(/\s+/g, "");
    if (!/^[1-9]\d{5}$/.test(pincode)) return [{ text: "Please type a valid 6-digit PIN code, like 380015." }];
    const prefixes = this.deps.config.serviceablePincodePrefixes;
    if (prefixes.length > 0 && !prefixes.some((p) => pincode.startsWith(p))) {
      return [
        {
          text: `Sorry, we don't deliver to ${pincode} yet. Type a different PIN code, or cancel.`,
          buttons: [[{ label: "✖ Cancel", action: "cancel" }]],
        },
      ];
    }
    await this.updateCustomer(userId, { pincode });
    await this.touchOrder(session);
    return this.askNextDetail(userId, session);
  }

  private async touchOrder(session: Session) {
    if (session.orderId) {
      await extendOrder(this.deps.store, session.orderId, this.now(), this.deps.config.reservationMinutes);
    }
  }

  // ---------- step 6-7: payment and confirmation ----------

  private async toPayment(userId: string, session: Session): Promise<OutboundMessage[]> {
    const { store } = this.deps;
    const order = getOrder(store, session.orderId);
    if (!order || !OPEN_STATUSES.includes(order.status)) return [{ text: STALE }];
    const c = this.getCustomer(userId);
    await this.touchOrder(session);
    const updated = await updateOrder(
      store,
      order.id,
      {
        status: "awaiting_payment",
        delivery: { name: c.name!, phone: c.phone!, address: c.address!, pincode: c.pincode! },
      },
      this.now(),
    );
    await this.setSession(userId, { ...session, state: "awaiting_payment" });
    return [
      {
        text: `Total to pay: ${rupees(updated.total)}\n\nHow would you like to pay?`,
        buttons: [
          [{ label: `💳 Pay ${rupees(updated.total)} by UPI (demo)`, action: "pay:upi" }],
          [{ label: "💵 Cash on delivery", action: "pay:cod" }],
          [{ label: "✖ Cancel", action: "cancel" }],
        ],
      },
    ];
  }

  private async pay(userId: string, session: Session, method: "upi_mock" | "cod"): Promise<OutboundMessage[]> {
    const { store, payment, notifier, config } = this.deps;
    const order = getOrder(store, session.orderId);
    if (!order || order.status !== "awaiting_payment") return [{ text: STALE }];

    let reference = `COD-${order.id}`;
    if (method === "upi_mock") {
      const result = await payment.start(order);
      if (result.status !== "paid") {
        // Real providers land here: send the link and wait for their webhook.
        return [{ text: `Pay here: ${result.url ?? "(no link)"}\nI'll confirm as soon as the payment comes through.` }];
      }
      reference = result.reference;
    }

    let allocations: Awaited<ReturnType<typeof commitOrder>>;
    try {
      allocations = await commitOrder(store, order.id, this.now());
    } catch (err) {
      console.error(`[order] commit failed for ${order.id}:`, err);
      await this.abandon(userId, session, "cancelled");
      await notifier.toAdmins(`⚠️ Order ${order.id} could not be filled: ${(err as Error).message}`);
      return [{ text: `Sorry, some of this stock is no longer available, so I cancelled order ${order.id}. Please call us on ${config.pharmacyPhone}.` }];
    }

    const lines = order.lines.map((l) => ({ ...l, batches: allocations.get(l.sku) }));
    const status = method === "cod" ? "cod_confirmed" : "paid";
    const done = await updateOrder(
      store,
      order.id,
      { status, lines, payment: { method, reference, at: this.now().toISOString() } },
      this.now(),
    );
    await this.setSession(userId, { state: "idle" });
    await store.audit(`order_${status}`, userId, { orderId: order.id, total: order.total, reference });

    const d = done.delivery!;
    await notifier.toAdmins(
      `🧾 New order ${done.id} (${method === "cod" ? "cash on delivery" : "paid, UPI demo"})\n` +
        done.lines.map((l) => `• ${l.brand} × ${l.qty} [${(l.batches ?? []).map((b) => b.batch).join(", ")}]`).join("\n") +
        `\nTotal ${rupees(done.total)}\n${d.name}, ${formatPhone(d.phone)}\n${d.address}, ${d.pincode}`,
    );

    const head =
      method === "cod"
        ? `✅ Order ${done.id} is confirmed. Please keep ${rupees(done.total)} ready to pay on delivery.`
        : `✅ Payment accepted (demo, no money was taken).\nOrder ${done.id} is confirmed. Reference: ${reference}`;
    return [{ text: `${head}\n\nWe'll message you when it's out for delivery. Use /status to check your orders.` }];
  }

  // ---------- background jobs ----------

  /** Releases expired stock holds and resets stale sessions. Run every minute. */
  async runJobs(): Promise<void> {
    const { store, notifier, config } = this.deps;
    const now = this.now();

    for (const orderId of await expireReservations(store, now)) {
      const order = getOrder(store, orderId);
      if (!order || !OPEN_STATUSES.includes(order.status)) continue;
      await this.withUser(order.userId, async () => {
        await updateOrder(store, orderId, { status: "expired" }, now);
        const s = this.getSession(order.userId);
        if (s.orderId === orderId) await this.setSession(order.userId, { state: "idle" });
        await store.audit("order_expired", order.userId, { orderId });
      });
      await notifier.toUser(order.userId, [
        {
          text: `Your cart (${orderId}) expired after ${config.reservationMinutes} minutes, so I released the stock. Send your list again whenever you're ready.`,
          removeKeyboard: true,
        },
      ]);
    }

    for (const [userId, s] of Object.entries(store.sessions.data)) {
      if (s.state === "idle" || s.state === "awaiting_consent" || s.orderId) continue;
      const idleMinutes = (now.getTime() - new Date(s.updatedAt).getTime()) / 60_000;
      if (idleMinutes > config.sessionTimeoutMinutes) {
        await this.withUser(userId, () => this.setSession(userId, { state: "idle" }));
      }
    }
  }

  private consentMessage(): OutboundMessage {
    const { config } = this.deps;
    return {
      text:
        `Welcome to ${config.pharmacyName} 👋\n\n` +
        "Send me a photo or PDF of your prescription, or type the medicine names, and I'll check what we can deliver.\n\n" +
        "Before we start:\n" +
        `• Your messages and prescription images are stored to process your order and deleted after ${config.uploadRetentionDays} days.\n` +
        "• Images and some messages are read by an AI service (Google Gemini).\n" +
        "• Prescription-only medicines need a pharmacist's check and can't be ordered here yet.\n\n" +
        "Do you agree?",
      buttons: [[{ label: "✅ I agree", action: "consent:yes" }]],
    };
  }
}

// ---------- helpers ----------

const READY_TEXT =
  "You're all set. Send a photo or PDF of your prescription, or type the medicine names, for example:\n\n2 Dolo 650\nEno\nVolini gel";

function helpText(phone: string): string {
  return (
    "How to order:\n" +
    "1. Send a photo or PDF of your prescription, or type the medicine names.\n" +
    "2. Check the list I found and tap Yes.\n" +
    "3. Review the cart, add your address and pay.\n\n" +
    "Commands:\n/status: your recent orders\n/cancel: cancel what you're doing\n/pharmacist: talk to our pharmacist\n\n" +
    `Questions? Call ${phone}.`
  );
}

function compositionText(p: Product): string {
  if (p.composition.length > 2) return p.generic;
  return p.composition.map((c) => (c.strength ? `${c.name} ${c.strength}` : c.name)).join(" + ");
}

function mergeDuplicates(draft: DraftItem[]): DraftItem[] {
  const out: DraftItem[] = [];
  for (const d of draft) {
    const same = d.chosenSku ? out.find((o) => o.chosenSku === d.chosenSku) : undefined;
    if (same) {
      same.quantity = Math.min(same.quantity + d.quantity, MAX_PACKS_PER_LINE);
      same.confidence = Math.min(same.confidence, d.confidence);
    } else {
      out.push({ ...d });
    }
  }
  return out;
}

export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

function formatPhone(phone: string): string {
  const d = phone.replace(/^\+91/, "");
  return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
}

const STATUS_LABEL: Record<Order["status"], string> = {
  reserved: "in cart",
  awaiting_payment: "awaiting payment",
  paid: "paid",
  cod_confirmed: "confirmed (cash on delivery)",
  cancelled: "cancelled",
  expired: "expired",
};

function orderSummaryLine(o: Order): string {
  const date = new Date(o.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${o.id} (${date}): ${STATUS_LABEL[o.status]}, ${rupees(o.total)}`;
}
