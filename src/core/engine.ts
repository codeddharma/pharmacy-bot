import { and, desc, eq } from "drizzle-orm";
import { effectivePermissions, type Permission } from "../auth/permissions.ts";
import type { DB } from "../db/client.ts";
import { consultations, customers as customersTable, interactionRules, orders, roles, users, waitlist, type OrderStatus } from "../db/schema.ts";
import { ExtractorBusyError, type Extraction, type ExtractedItem, type Extractor } from "../extract/types.ts";
import type { PaymentEvent, PaymentProvider } from "../payments/types.ts";
import { substitutesFor, type CatalogueCache } from "../services/catalogue.ts";
import { createConsultation, escalateOverdue } from "../services/consultations.ts";
import {
  audit,
  findOrCreateCustomer,
  getCustomer,
  logMessage,
  sessionOf,
  setSession,
  updateCustomer,
  type Customer,
} from "../services/customers.ts";
import type { EventBus } from "../services/events.ts";
import { distanceFromPharmacy, etaBand } from "../services/geo.ts";
import { formatWhen, hoursText, planDelivery, shopStatus, zonedParts } from "../services/hours.ts";
import {
  availableMap,
  commitOrderIn,
  expireReservations,
  extendOrder,
  hasReservations,
  releaseOrder,
  restockIn,
  type StockPolicy,
} from "../services/inventory.ts";
import {
  ACTIVE_STATUSES,
  createReservedOrder,
  getOrder,
  OPEN_STATUSES,
  recentSameOrder,
  STAFF_TRANSITIONS,
  updateOrder,
  type CartRequest,
  type Order,
} from "../services/orders.ts";
import type { Settings, SettingsService } from "../services/settings.ts";
import type { Button, Channel, DraftItem, InboundMessage, OutboundMessage, Product, Session, SessionState } from "../types.ts";
import { formatPhone, money, normalizeIndianMobile, shortLabel } from "./format.ts";
import { checkInteractions } from "./interactions.ts";
import { detectIntents } from "./intents.ts";
import { Matcher } from "./matcher.ts";
import { isNo, isYes, parseTypedList } from "./parse.ts";
import { decide } from "./rules.ts";
import { EMERGENCY_MESSAGE, isRedFlag } from "./safety.ts";

/** Sends messages to a customer outside a reply (payment confirmations, staff answers, alerts). */
export interface ChannelSender {
  send(channelUserId: string, messages: OutboundMessage[]): Promise<void>;
  /** WhatsApp only: an approved template, for messages after the 24-hour window. */
  sendTemplate?(channelUserId: string, template: string, language: string, params: string[]): Promise<void>;
}

export interface EngineDeps {
  db: DB;
  catalogue: CatalogueCache;
  settings: SettingsService;
  bus: EventBus;
  extractor: Extractor | null;
  payments: PaymentProvider | null;
  senders: Partial<Record<Channel, ChannelSender>>;
  saveUpload(customerKey: string, data: Buffer, ext: string): Promise<string>;
  now?: () => Date;
}

/** Thrown when a WhatsApp customer can't be messaged because the 24-hour window closed and no template is set. */
export class WindowClosedError extends Error {}

const LOW_CONFIDENCE = 0.6;
const MAX_PACKS_PER_LINE = 10;
const UPI_LINK_MINUTES = 20;

/** What typing "yes" means in each state. Payment is left out on purpose: that needs a tap. */
const YES_ACTION: Partial<Record<SessionState, string>> = {
  confirm_items: "items:ok",
  cart_review: "cart:order",
  confirm_address: "addr:yes",
};

const ACTION_LABELS: Record<string, string> = {
  "consent:yes": "I agree",
  "items:ok": "Yes, continue",
  "items:edit": "Edit list",
  "cart:order": "Yes, place order",
  cancel: "Cancel",
  "addr:yes": "Yes (address)",
  "addr:change": "Change address",
  "pay:upi": "Pay by UPI",
  "pay:cod": "Cash on delivery",
  "ask:pharmacist": "Ask our pharmacist",
  "ask:no": "No thanks",
  "rx:review": "Send to pharmacist",
  "loc:skip": "Skip location",
};

const STALE = "That button is from an earlier step. Send your medicine list to start again, or /help.";

const STATUS_LABEL: Record<OrderStatus, string> = {
  reserved: "in cart",
  awaiting_payment: "awaiting payment",
  confirmed: "confirmed",
  preparing: "being prepared",
  out_for_delivery: "out for delivery",
  delivered: "delivered",
  cancelled: "cancelled",
  expired: "expired",
};

/**
 * The conversation and the order lifecycle, independent of Telegram or WhatsApp.
 * Channel adapters turn updates into InboundMessages and send back what `handle` returns;
 * the dashboard API calls the staff methods (answer, assign, status, cancel).
 */
export class Engine {
  private matcher: Matcher;
  private queues = new Map<string, Promise<unknown>>();
  private seenIds: string[] = [];
  private seen = new Set<string>();

  constructor(private readonly d: EngineDeps) {
    this.matcher = new Matcher(d.catalogue.products);
    d.catalogue.onChange(() => {
      this.matcher = new Matcher(d.catalogue.products);
    });
  }

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  private async stockPolicy(s?: Settings): Promise<StockPolicy> {
    s ??= await this.d.settings.get();
    return { now: this.now(), nearExpiryDays: s.inventory.nearExpiryDays, timezone: s.hours.timezone };
  }

  /** Runs `fn` after anything already running for the same customer. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  // ======================================================================= inbound

  /** Handles one customer message. Messages from the same customer run one at a time. */
  handle(msg: InboundMessage): Promise<OutboundMessage[]> {
    const dedupeKey = `${msg.channel}:${msg.messageId}`;
    if (this.seen.has(dedupeKey)) return Promise.resolve([]);
    this.seen.add(dedupeKey);
    this.seenIds.push(dedupeKey);
    if (this.seenIds.length > 5000) this.seen.delete(this.seenIds.shift()!);

    return this.serial(`${msg.channel}:${msg.channelUserId}`, async () => {
      const { db, bus } = this.d;
      const customer = await findOrCreateCustomer(db, msg.channel, msg.channelUserId, msg.profileName);
      const mediaPath = msg.media
        ? await this.d.saveUpload(`${msg.channel}-${msg.channelUserId}`, msg.media.data, msg.media.kind === "pdf" ? "pdf" : (msg.media.mimeType.split("/")[1] ?? "jpg"))
        : null;

      const inboundText = describeInbound(msg);
      await logMessage(db, { customerId: customer.id, direction: "in", sender: "customer", text: inboundText, mediaPath, at: this.now() });
      bus.emit({ type: "message.in", customerId: customer.id, preview: inboundText.slice(0, 120), handoff: !!customer.handoffUserId });

      const out = await this.process(msg, customer, mediaPath);
      for (const m of out) {
        await logMessage(db, { customerId: customer.id, direction: "out", sender: "bot", text: m.text, at: this.now() });
      }
      if (out.length) bus.emit({ type: "message.out", customerId: customer.id });
      return out;
    });
  }

  private async process(msg: InboundMessage, initial: Customer, mediaPath: string | null): Promise<OutboundMessage[]> {
    const { db } = this.d;
    const s = await this.d.settings.get();
    let customer = initial;
    if (customer.blocked) return [];

    let session = sessionOf(customer);
    const idleMinutes = customer.botStateUpdatedAt ? (this.now().getTime() - customer.botStateUpdatedAt.getTime()) / 60_000 : 0;
    if (session.state !== "idle" && session.state !== "awaiting_consent" && idleMinutes > s.bot.sessionTimeoutMinutes) {
      await this.abandon(customer, session, "expired");
      session = { state: "idle" };
    }

    // A staff member has taken over this chat: the bot stays quiet.
    if (customer.handoffUserId) return [];

    const text = msg.text?.trim() ?? "";
    if (text.startsWith("/") && !msg.media) return this.command(customer, session, text, s);

    if (!customer.consentAt) {
      if (msg.action === "consent:yes") {
        customer = await updateCustomer(db, customer.id, { consentAt: this.now() });
        await this.save(customer, { state: "idle" });
        await audit(db, { action: "consent_given", customerId: customer.id });
        return [{ text: readyText() }];
      }
      await this.save(customer, { state: "awaiting_consent" });
      return [this.consentMessage(s)];
    }

    if (msg.action) return this.onAction(msg, customer, session, msg.action, s);

    if (text && isRedFlag(text)) {
      await audit(db, { action: "red_flag", customerId: customer.id, data: { text } });
      return [{ text: EMERGENCY_MESSAGE }];
    }

    switch (session.state) {
      case "collect_name":
        if (!msg.media) return this.onName(customer, session, text);
        break;
      case "collect_phone":
        if (!msg.media) return this.onPhone(customer, session, msg.contactPhone ?? text);
        break;
      case "collect_address":
        if (!msg.media) return this.onAddress(customer, session, text);
        break;
      case "collect_pincode":
        if (!msg.media) return this.onPincode(customer, session, text, s);
        break;
      case "collect_location":
        if (msg.location) return this.onLocation(customer, session, msg.location, s);
        if (/^skip$/i.test(text)) return this.onAction(msg, customer, session, "loc:skip", s);
        if (!msg.media) return [this.locationPrompt(s)];
        break;
      case "awaiting_question":
        return this.submitQuestion(customer, session.questionKind ?? "question", text || "(photo)", mediaPath, s);
    }

    if (!msg.media && text) {
      const yes = YES_ACTION[session.state];
      if (yes && isYes(text)) return this.onAction(msg, customer, session, yes, s);
      if (session.state !== "idle" && isNo(text)) return this.onAction(msg, customer, session, "cancel", s);
      if (session.state === "awaiting_payment" && isYes(text)) return [{ text: "Please tap one of the payment buttons above." }];
    }

    if (!text && !msg.media) {
      return [{ text: "Please send a photo or PDF of your prescription, or type the medicine names." }];
    }
    return this.newRequest(msg, customer, session, mediaPath, s);
  }

  private async command(customer: Customer, session: Session, text: string, s: Settings): Promise<OutboundMessage[]> {
    const cmd = text.split(/\s+/)[0]!.toLowerCase().replace(/@.*$/, "");
    switch (cmd) {
      case "/start":
        if (!customer.consentAt) {
          await this.save(customer, { state: "awaiting_consent" });
          return [this.consentMessage(s)];
        }
        return [{ text: readyText() }];
      case "/help":
        return [{ text: helpText(s) }];
      case "/cancel":
        await this.abandon(customer, session, "cancelled");
        return [{ text: "Cancelled. Send a new list whenever you're ready.", removeKeyboard: true }];
      case "/status": {
        const mine = await this.d.db
          .select()
          .from(orders)
          .where(eq(orders.customerId, customer.id))
          .orderBy(desc(orders.createdAt))
          .limit(3);
        if (mine.length === 0) return [{ text: "You don't have any orders yet." }];
        return [{ text: "Your recent orders:\n\n" + mine.map((o) => orderSummaryLine(o, s)).join("\n") }];
      }
      case "/pharmacist":
      case "/ask":
        if (!customer.consentAt) return [this.consentMessage(s)];
        await this.save(customer, { state: "awaiting_question", questionKind: "question" });
        return [{ text: `Type your question for our pharmacist. You can attach a photo. ${this.answerTiming(s)}` }];
      case "/hours":
        return [{ text: this.hoursReply(s) }];
    }
    return [{ text: "I don't know that command. Try /help." }];
  }

  private async onAction(
    msg: InboundMessage,
    customer: Customer,
    session: Session,
    action: string,
    s: Settings,
  ): Promise<OutboundMessage[]> {
    const [verb, a, b] = action.split(":");
    switch (verb) {
      case "consent":
        return [{ text: readyText() }];

      case "notify":
        return this.joinWaitlist(customer, a ?? "");

      case "cancel":
        await this.abandon(customer, session, "cancelled");
        return [{ text: "Cancelled. Send a new list whenever you're ready.", removeKeyboard: true }];

      case "ask":
        if (a === "no") {
          await this.save(customer, { state: "idle" });
          return [{ text: "No problem. Send a medicine name or a prescription whenever you're ready." }];
        }
        if (session.pendingQuestion) {
          return this.submitQuestion(customer, "question", session.pendingQuestion, null, s);
        }
        await this.save(customer, { state: "awaiting_question", questionKind: "question" });
        return [{ text: `Type your question for our pharmacist. ${this.answerTiming(s)}` }];

      case "rx": {
        if (!session.rxItems?.length) return [{ text: STALE }];
        const question = `Please review this prescription. Prescription-only items requested: ${session.rxItems.join(", ")}.`;
        return this.submitQuestion(customer, "prescription", question, session.mediaPath ?? null, s);
      }

      case "add": {
        const p = this.d.catalogue.get(a ?? "");
        if (!p) return [{ text: STALE }];
        const draft: DraftItem[] = [{ asWritten: p.brand, quantity: 1, confidence: 1, candidates: [p.sku], chosenSku: p.sku }];
        await this.save(customer, { state: "confirm_items", draft });
        return [this.renderConfirm(draft)];
      }

      case "items":
        if (session.state !== "confirm_items" && session.state !== "edit_items") return [{ text: STALE }];
        if (a === "edit") {
          await this.save(customer, { ...session, state: "edit_items" });
          return [{ text: "Type the correct list, one medicine per line. For example:\n2 Dolo 650\nCrocin Advance\nEno" }];
        }
        return this.buildCart(customer, session, msg.channel, s);

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
          await this.save(customer, { state: "idle" });
          return [{ text: "Nothing left in the list. Send your medicines again whenever you're ready." }];
        }
        await this.save(customer, { ...session, state: "confirm_items", draft });
        return [this.renderConfirm(draft)];
      }

      case "alt": {
        // Swap an out-of-stock item for a same-composition product, then rebuild the cart.
        const draft = session.draft;
        const replacement = this.d.catalogue.get(b ?? "");
        if (!draft || !replacement) return [{ text: STALE }];
        const next = draft.map((d) => (d.chosenSku === a ? { ...d, chosenSku: replacement.sku, candidates: [replacement.sku] } : d));
        if (!next.some((d) => d.chosenSku === replacement.sku)) return [{ text: STALE }];
        await this.dropReservedOrder(session);
        return this.buildCart(customer, { ...session, draft: next, orderId: undefined }, msg.channel, s);
      }

      case "cart":
        if (session.state !== "cart_review" || !session.orderId) return [{ text: STALE }];
        await this.touchOrder(session, s);
        return this.askNextDetail(customer, session, s);

      case "loc":
        if (session.state !== "collect_location") return [{ text: STALE }];
        if (s.delivery.requireLocation) {
          return [{ ...this.locationPrompt(s), text: "We need your location to check the delivery distance. Please tap the button below." }];
        }
        return this.askNextDetail(customer, { ...session, locationSkipped: true }, s);

      case "addr":
        if (session.state !== "confirm_address" || !session.orderId) return [{ text: STALE }];
        if (a === "change") {
          await updateCustomer(this.d.db, customer.id, { address: null, pincode: null, lat: null, lng: null });
          await this.save(customer, { ...session, state: "collect_address", locationSkipped: false });
          return [{ text: "Please type the delivery address: house or flat, street, area and city." }];
        }
        return this.toPayment(customer, session, s);

      case "pay":
        if (session.state !== "awaiting_payment" || !session.orderId) return [{ text: STALE }];
        return a === "cod" ? this.payCod(customer, session, s) : this.payUpi(customer, session, s);
    }
    return [{ text: STALE }];
  }

  // ======================================================================= reading the request

  private async newRequest(
    msg: InboundMessage,
    customer: Customer,
    session: Session,
    mediaPath: string | null,
    s: Settings,
  ): Promise<OutboundMessage[]> {
    const { extractor, catalogue } = this.d;
    if (session.orderId) await this.abandon(customer, session, "cancelled");

    const text = msg.text?.trim() ?? "";
    const intents = text ? detectIntents(text) : new Set();

    if (intents.has("complaint") && !msg.media) {
      return this.submitQuestion(customer, "complaint", text, null, s);
    }
    if (intents.has("credit") && !msg.media) {
      return [{ text: `We take ${this.paymentMethodsText(s)}. We can't offer credit, sorry.` }];
    }

    const knownNames = catalogue.products.filter((p) => p.active).map((p) => p.brand);
    let draft: DraftItem[] = [];
    let extraction: Extraction | null = null;

    try {
      if (msg.media) {
        if (!extractor) {
          return [{ text: "Reading photos and PDFs isn't switched on yet. Please type the medicine names, one per line." }];
        }
        await this.sendTo(customer, [{ text: msg.media.kind === "pdf" ? "Reading your PDF…" : "Reading your prescription…" }]);
        extraction = await extractor.extract({ media: msg.media, text: msg.text, knownNames });
      } else {
        const typed = parseTypedList(text);
        const matched = typed.map((t) => ({ t, m: this.matcher.match(t.name) }));
        const chosen = matched.map((x) => x.m.chosen).filter((x): x is string => !!x);

        if (intents.has("price") && chosen.length > 0) return [await this.priceReply(chosen, s)];
        if (intents.has("hours") && chosen.length === 0) return [{ text: this.hoursReply(s) }];

        const allFound = matched.length > 0 && matched.every((x) => x.m.candidates.length > 0);
        if (allFound || !extractor) {
          draft = matched.map(({ t, m }) => ({
            asWritten: t.raw,
            quantity: Math.min(t.quantity, MAX_PACKS_PER_LINE),
            confidence: 1,
            candidates: m.candidates,
            chosenSku: m.chosen,
          }));
          if (!extractor && draft.every((d) => d.candidates.length === 0) && intents.has("advice")) {
            return this.offerPharmacist(customer, text, s);
          }
        } else {
          extraction = await extractor.extract({ text, knownNames });
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
      await audit(this.d.db, { action: "extraction", customerId: customer.id, data: { extractor: extractor?.name, ...extraction } });
      if (extraction.language) await updateCustomer(this.d.db, customer.id, { language: extraction.language });
      draft = extraction.items.map((item) => this.draftFromExtraction(item));
      if (draft.length === 0) {
        if (extraction.document_type === "unreadable") {
          return [{ text: "I couldn't read that. Please send a clearer photo in good light, or type the medicine names." }];
        }
        if (extraction.document_type === "other") {
          return [{ text: "That doesn't look like a prescription or a medicine. Please send a prescription, a photo of the strip, or type the names." }];
        }
        return this.offerPharmacist(customer, text, s);
      }
    }
    if (draft.length === 0) return this.offerPharmacist(customer, text, s);

    draft = mergeDuplicates(draft);
    await this.save(customer, { state: "confirm_items", draft, mediaPath: mediaPath ?? undefined });
    const confirm = this.renderConfirm(draft);
    if (intents.has("urgent")) confirm.text += `\n\n⏱️ ${await this.urgentNote(customer, s)}`;
    return [confirm];
  }

  private draftFromExtraction(item: ExtractedItem): DraftItem {
    const query = item.strength && !/\d/.test(item.name) ? `${item.name} ${item.strength}` : item.name;
    const m = this.matcher.match(query);
    const product = m.chosen ? this.d.catalogue.get(m.chosen) : undefined;
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

  private async offerPharmacist(customer: Customer, text: string, s: Settings): Promise<OutboundMessage[]> {
    const question = text.trim();
    await this.save(customer, { state: "idle", pendingQuestion: question || undefined });
    return [
      {
        text:
          "I couldn't find a medicine name in that, and I can't suggest medicines myself.\n\n" +
          `Our pharmacist can answer here in this chat. ${this.answerTiming(s)}\n\n` +
          "Or type the medicine name as it's written on the strip or prescription.",
        buttons: [
          [
            { label: "💬 Ask our pharmacist", action: "ask:pharmacist" },
            { label: "No thanks", action: "ask:no" },
          ],
        ],
      },
    ];
  }

  private renderConfirm(draft: DraftItem[]): OutboundMessage {
    const { catalogue } = this.d;
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

    return {
      text:
        "Here's what I found:\n\n" +
        lines.join("\n") +
        (anyLow ? "\n\n⚠️ I wasn't sure I read some of these correctly. Please check them." : "") +
        "\n\nIs this correct?",
      buttons,
    };
  }

  private async priceReply(skus: string[], s: Settings): Promise<OutboundMessage> {
    const stock = await availableMap(this.d.db, await this.stockPolicy(s), skus);
    const lines: string[] = [];
    const buttons: Button[][] = [];
    for (const sku of [...new Set(skus)]) {
      const p = this.d.catalogue.get(sku);
      if (!p) continue;
      const perUnit = p.pack.size > 1 && ["tablet", "capsule", "lozenge", "pearl"].includes(p.pack.unit)
        ? ` (${money(Math.round(p.mrpPaise / p.pack.size))} per ${p.pack.unit})`
        : "";
      const rx = p.schedule === "OTC" ? "" : " · needs a prescription";
      const inStock = (stock.get(sku) ?? 0) > 0 ? "in stock" : "out of stock";
      lines.push(`• ${p.brand}, ${p.pack.label.toLowerCase()}: MRP ${money(p.mrpPaise)}${perUnit} · ${inStock}${rx}`);
      if (p.schedule === "OTC" && p.active && (stock.get(sku) ?? 0) > 0) {
        buttons.push([{ label: `🛒 Add ${shortLabel(p.brand, 24)}`, action: `add:${sku}` }]);
      }
    }
    return {
      text: `${lines.join("\n")}\n\nPrices are printed MRP, GST included. Delivery is ${this.deliveryFeeText(s)}.`,
      buttons,
    };
  }

  private hoursReply(s: Settings): string {
    const now = this.now();
    const status = shopStatus(now, s.hours);
    const today = zonedParts(now, s.hours.timezone).weekday;
    const head = status.open
      ? `We're open now${status.closesAt ? ` until ${formatWhen(status.closesAt, now, s.hours.timezone).replace(/ today$/, "")}` : ""}.`
      : `We're closed now.${status.nextOpenAt ? ` We open at ${formatWhen(status.nextOpenAt, now, s.hours.timezone)}.` : ""}`;
    return `${head}\nToday's hours: ${hoursText(s.hours, today)}.\n\nYou can still send your order at any time; orders placed while we're closed are delivered after we open.`;
  }

  private async urgentNote(customer: Customer, s: Settings): Promise<string> {
    const distance = distanceFromPharmacy(s, customer.lat, customer.lng);
    const plan = planDelivery(this.now(), s, etaBand(distance, s.delivery));
    return plan.sameDay
      ? `If you order now, we can deliver ${plan.etaText}.`
      : `We can't deliver right now: we'll deliver ${plan.etaText}.`;
  }

  // ======================================================================= cart

  private async buildCart(customer: Customer, session: Session, channel: string, s: Settings): Promise<OutboundMessage[]> {
    const { db, catalogue } = this.d;
    const draft = session.draft ?? [];

    const pending = draft.findIndex((d) => !d.chosenSku && d.candidates.length > 0);
    if (pending >= 0) {
      return [{ text: `Please choose an option for item ${pending + 1} first, or tap "None of these".` }, this.renderConfirm(draft)];
    }

    const requests = new Map<string, CartRequest>();
    const excluded: { name: string; reason: string }[] = [];
    const rxItems: string[] = [];
    for (const d of draft) {
      const decision = decide(catalogue, d.chosenSku, d.asWritten, d.quantity, s.pharmacy.phone);
      if (decision.kind === "refuse") {
        excluded.push({ name: decision.name, reason: decision.reason });
        if (decision.code === "prescription") rxItems.push(decision.name);
        await audit(db, { action: "item_refused", customerId: customer.id, data: { sku: decision.product?.sku, asWritten: d.asWritten, code: decision.code } });
        continue;
      }
      if (decision.qty <= 0) continue;
      const existing = requests.get(decision.product.sku);
      if (existing) existing.qty = Math.min(existing.qty + decision.qty, decision.product.maxPacksPerOrder);
      else requests.set(decision.product.sku, { product: decision.product, qty: decision.qty, notes: decision.notes });
    }

    const stock = await this.stockPolicy(s);
    const { order, outOfStock } =
      requests.size > 0
        ? await createReservedOrder(db, {
            customerId: customer.id,
            channel,
            requests: [...requests.values()],
            excluded,
            pricing: s.delivery,
            stock,
            ttlMinutes: s.orders.reservationMinutes,
          })
        : { order: null, outOfStock: [] as Product[] };

    // Out of stock: offer a same-composition product that is in stock, then a waitlist.
    const extraButtons: Button[][] = [];
    const altStock = await availableMap(db, stock);
    for (const p of outOfStock) {
      const alt = substitutesFor(p, catalogue.products).find((x) => (altStock.get(x.sku) ?? 0) > 0);
      if (alt) {
        extraButtons.push([{ label: `🔁 ${shortLabel(alt.brand, 22)} instead (${money(alt.mrpPaise)})`, action: `alt:${p.sku}:${alt.sku}` }]);
      }
      extraButtons.push([{ label: `🔔 Tell me when ${shortLabel(p.brand, 22)} is back`, action: `notify:${p.sku}` }]);
    }
    if (rxItems.length > 0 && session.mediaPath) {
      extraButtons.push([{ label: "📋 Send prescription to pharmacist", action: "rx:review" }]);
    }

    if (!order) {
      await this.save(customer, { state: "idle", draft, mediaPath: session.mediaPath, rxItems });
      const all = [...excluded, ...outOfStock.map((p) => ({ name: p.brand, reason: "Out of stock right now." }))];
      return [
        {
          text:
            "I can't add any of these to an order:\n\n" +
            all.map((e) => `• ${e.name}: ${e.reason}`).join("\n") +
            "\n\nSend another list whenever you like.",
          buttons: extraButtons,
        },
      ];
    }

    await audit(db, { action: "order_reserved", customerId: customer.id, entity: "order", entityId: order.id, data: { totalPaise: order.totalPaise } });
    this.d.bus.emit({ type: "order.created", orderId: order.id, status: order.status, agentId: null });
    await this.save(customer, { state: "cart_review", orderId: order.id, draft, mediaPath: session.mediaPath, rxItems });
    return [await this.renderCart(customer, order, extraButtons, s)];
  }

  private async renderCart(customer: Customer, order: Order, extraButtons: Button[][], s: Settings): Promise<OutboundMessage> {
    const { catalogue, db } = this.d;
    const out: string[] = ["Your order:"];
    const products = order.lines.map((l) => catalogue.get(l.sku)).filter((p): p is Product => !!p);

    for (const l of order.lines) {
      const p = catalogue.get(l.sku);
      out.push(`• ${l.brand} (${l.packLabel.toLowerCase()}) × ${l.qty}: ${money(l.lineTotalPaise)}`);
      if (l.note) out.push(`   ${l.note}`);
      for (const w of p?.warnings ?? []) if (!w.startsWith("Contains ")) out.push(`   ⚠️ ${w}`);
    }

    const rules = await db.select().from(interactionRules).where(eq(interactionRules.active, true));
    const warnings = checkInteractions(products, rules);
    if (warnings.length) out.push("", ...warnings.map((w) => `⚠️ ${w.message}`));
    const blocked = warnings.some((w) => w.severity === "block");

    out.push("", `Subtotal: ${money(order.subtotalPaise)}`);
    out.push(order.deliveryFeePaise > 0 ? `Delivery: ${money(order.deliveryFeePaise)} (free on orders of ${money(s.delivery.freeAboveRupees * 100)} or more)` : "Delivery: free");
    out.push(`Total: ${money(order.totalPaise)}`);

    if (order.excluded.length > 0) {
      out.push("", "Not included:");
      for (const e of order.excluded) out.push(`• ${e.name}: ${e.reason}`);
    }

    if (s.orders.duplicateWindowMinutes > 0) {
      const since = new Date(this.now().getTime() - s.orders.duplicateWindowMinutes * 60_000);
      const dup = await recentSameOrder(db, customer.id, order.lines.map((l) => l.sku), since);
      if (dup) {
        const mins = Math.max(1, Math.round((this.now().getTime() - dup.createdAt.getTime()) / 60_000));
        out.push("", `ℹ️ You ordered these same items ${mins} minutes ago (${dup.id}). Only place this order if you want them again.`);
      }
    }

    const status = shopStatus(this.now(), s.hours);
    if (!status.open && status.nextOpenAt) {
      out.push("", `🕘 We're closed now. Your order will be prepared after we open at ${formatWhen(status.nextOpenAt, this.now(), s.hours.timezone)}.`);
    }

    out.push("", `Prices are MRP, GST included. I'm holding this stock for ${s.orders.reservationMinutes} minutes.`);
    if (blocked) {
      out.push("", "Because of the warning above, please check with our pharmacist before ordering.");
      return {
        text: out.join("\n"),
        buttons: [[{ label: "💬 Ask our pharmacist", action: "ask:pharmacist" }], [{ label: "✖ Cancel", action: "cancel" }], ...extraButtons],
      };
    }
    out.push("", "Would you like to place the order?");
    return {
      text: out.join("\n"),
      buttons: [[{ label: "✅ Yes, place order", action: "cart:order" }], [{ label: "✖ No, cancel", action: "cancel" }], ...extraButtons],
    };
  }

  private async joinWaitlist(customer: Customer, sku: string): Promise<OutboundMessage[]> {
    const product = this.d.catalogue.get(sku);
    if (!product) return [{ text: STALE }];
    await this.d.db.insert(waitlist).values({ customerId: customer.id, sku }).onConflictDoNothing();
    return [{ text: `Done. I'll message you when ${product.brand} is back in stock.` }];
  }

  // ======================================================================= delivery details

  private async askNextDetail(customer: Customer, session: Session, s: Settings): Promise<OutboundMessage[]> {
    const c = (await getCustomer(this.d.db, customer.id))!;
    const set = (state: SessionState, extra: Partial<Session> = {}) => this.save(c, { ...session, ...extra, state });

    if (!c.name) {
      await set("collect_name");
      return [{ text: "What name should we put on the delivery?" }];
    }
    if (!c.phone) {
      await set("collect_phone");
      return [{ text: "What's your mobile number? Type it, or tap the button below to share it.", requestContact: true }];
    }
    if (!c.address) {
      await set("collect_address");
      return [{ text: "Please type the delivery address: house or flat, street, area and city.", removeKeyboard: true }];
    }
    if (!c.pincode) {
      await set("collect_pincode");
      return [{ text: "What's the 6-digit PIN code?" }];
    }
    const needsLocation = s.pharmacy.lat !== null && s.pharmacy.lng !== null && (c.lat === null || c.lng === null);
    if (needsLocation && !session.locationSkipped) {
      await set("collect_location");
      return [this.locationPrompt(s)];
    }

    await set("confirm_address");
    const distance = distanceFromPharmacy(s, c.lat, c.lng);
    const plan = planDelivery(this.now(), s, etaBand(distance, s.delivery));
    const distanceLine = distance !== null ? `\n📍 ${distance} km from the pharmacy` : "";
    return [
      {
        text: `Deliver to:\n${c.name}\n${formatPhone(c.phone)}\n${c.address}\nPIN ${c.pincode}${distanceLine}\n🚚 Delivery ${plan.etaText}\n\nIs this right?`,
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

  private locationPrompt(s: Settings): OutboundMessage {
    return {
      text: `Please share your location so we can check you're within our ${s.delivery.radiusKm} km delivery area. Tap the button below${s.delivery.requireLocation ? "." : ", or type skip."}`,
      requestLocation: true,
      buttons: s.delivery.requireLocation ? undefined : [[{ label: "Skip", action: "loc:skip" }]],
    };
  }

  private async onName(customer: Customer, session: Session, text: string) {
    const name = text.replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name)) return [{ text: "Please type your full name." }];
    await updateCustomer(this.d.db, customer.id, { name });
    await this.touchOrder(session);
    return this.askNextDetail(customer, session, await this.d.settings.get());
  }

  private async onPhone(customer: Customer, session: Session, text: string) {
    const phone = normalizeIndianMobile(text);
    if (!phone) {
      return [{ text: "Please send a 10-digit Indian mobile number, like 98765 43210, or tap the button to share it.", requestContact: true }];
    }
    await updateCustomer(this.d.db, customer.id, { phone });
    await this.touchOrder(session);
    return this.askNextDetail(customer, session, await this.d.settings.get());
  }

  private async onAddress(customer: Customer, session: Session, text: string) {
    const address = text.replace(/\s+/g, " ").trim();
    if (address.length < 10) return [{ text: "Please type the full address: house or flat, street, area and city." }];
    await updateCustomer(this.d.db, customer.id, { address, pincode: null, lat: null, lng: null });
    await this.touchOrder(session);
    return this.askNextDetail(customer, { ...session, locationSkipped: false }, await this.d.settings.get());
  }

  private async onPincode(customer: Customer, session: Session, text: string, s: Settings) {
    const pincode = text.replace(/\s+/g, "");
    if (!/^[1-9]\d{5}$/.test(pincode)) return [{ text: "Please type a valid 6-digit PIN code, like 380015." }];
    const prefixes = s.delivery.serviceablePincodePrefixes;
    if (prefixes.length > 0 && !prefixes.some((p) => pincode.startsWith(p))) {
      return [{ text: `Sorry, we don't deliver to ${pincode} yet. Type a different PIN code, or cancel.`, buttons: [[{ label: "✖ Cancel", action: "cancel" }]] }];
    }
    await updateCustomer(this.d.db, customer.id, { pincode });
    await this.touchOrder(session, s);
    return this.askNextDetail(customer, session, s);
  }

  private async onLocation(customer: Customer, session: Session, loc: { lat: number; lng: number }, s: Settings) {
    const distance = distanceFromPharmacy(s, loc.lat, loc.lng);
    if (distance !== null && distance > s.delivery.radiusKm) {
      await audit(this.d.db, { action: "outside_delivery_area", customerId: customer.id, data: { distance } });
      return [
        {
          text: `Sorry, that location is ${distance} km away. We deliver within ${s.delivery.radiusKm} km of the pharmacy. You can share a different location, or cancel.`,
          requestLocation: true,
          buttons: [[{ label: "✖ Cancel", action: "cancel" }]],
        },
      ];
    }
    await updateCustomer(this.d.db, customer.id, { lat: loc.lat, lng: loc.lng });
    await this.touchOrder(session, s);
    return this.askNextDetail(customer, session, s);
  }

  private async touchOrder(session: Session, s?: Settings) {
    if (!session.orderId) return;
    s ??= await this.d.settings.get();
    await extendOrder(this.d.db, session.orderId, new Date(this.now().getTime() + s.orders.reservationMinutes * 60_000));
  }

  // ======================================================================= payment

  private async toPayment(customer: Customer, session: Session, s: Settings): Promise<OutboundMessage[]> {
    const { db } = this.d;
    const order = await getOrder(db, session.orderId);
    if (!order || !OPEN_STATUSES.includes(order.status)) return [{ text: STALE }];
    const c = (await getCustomer(db, customer.id))!;
    await this.touchOrder(session, s);
    const distanceKm = distanceFromPharmacy(s, c.lat, c.lng);
    const plan = planDelivery(this.now(), s, etaBand(distanceKm, s.delivery));
    const updated = await updateOrder(
      db,
      order.id,
      {
        status: "awaiting_payment",
        delivery: { name: c.name!, phone: c.phone!, address: c.address!, pincode: c.pincode!, lat: c.lat, lng: c.lng, distanceKm },
        scheduledFor: plan.scheduledFor,
        etaText: plan.etaText,
      },
      { status: "awaiting_payment", at: this.now() },
    );
    this.d.bus.emit({ type: "order.updated", orderId: order.id, status: updated.status, agentId: null });
    await this.save(c, { ...session, state: "awaiting_payment" });

    const buttons: Button[][] = [];
    if (s.orders.upiEnabled && this.d.payments) buttons.push([{ label: `💳 Pay ${money(updated.totalPaise)} by UPI`, action: "pay:upi" }]);
    if (s.orders.codEnabled) buttons.push([{ label: "💵 Cash on delivery", action: "pay:cod" }]);
    buttons.push([{ label: "✖ Cancel", action: "cancel" }]);
    return [{ text: `Total to pay: ${money(updated.totalPaise)}\n🚚 Delivery ${plan.etaText}\n\nHow would you like to pay?`, buttons }];
  }

  private async payUpi(customer: Customer, session: Session, s: Settings): Promise<OutboundMessage[]> {
    const { db, payments } = this.d;
    const order = await getOrder(db, session.orderId);
    if (!order || order.status !== "awaiting_payment") return [{ text: STALE }];
    if (!payments || !s.orders.upiEnabled) return [{ text: "UPI isn't available right now. Please choose cash on delivery." }];

    const expiresAt = new Date(this.now().getTime() + Math.max(UPI_LINK_MINUTES, s.orders.reservationMinutes) * 60_000);
    let link;
    try {
      link = await payments.createLink({
        orderId: order.id,
        amountPaise: order.totalPaise,
        customerName: order.delivery?.name ?? "Customer",
        customerPhone: (order.delivery?.phone ?? "").replace(/^\+91/, ""),
        description: `${s.pharmacy.name} order ${order.id}`,
        expiresAt,
      });
    } catch (err) {
      console.error(`[payments] link for ${order.id} failed:`, err);
      return [{ text: "Sorry, I couldn't create a payment link just now. Please try again, or choose cash on delivery." }];
    }
    await extendOrder(db, order.id, new Date(expiresAt.getTime() + 2 * 60_000));
    await updateOrder(
      db,
      order.id,
      { paymentMethod: "upi", paymentStatus: "pending", paymentLinkId: link.linkId, paymentLinkUrl: link.url },
      { note: "UPI payment link sent", at: this.now() },
    );
    const buttons: Button[][] = [];
    if (s.orders.codEnabled) buttons.push([{ label: "💵 Cash on delivery instead", action: "pay:cod" }]);
    buttons.push([{ label: "✖ Cancel", action: "cancel" }]);
    return [
      {
        text: `Pay ${money(order.totalPaise)} securely here:\n${link.url}\n\nThe link works for ${UPI_LINK_MINUTES} minutes. I'll confirm here as soon as the payment comes through.`,
        buttons,
      },
    ];
  }

  private async payCod(customer: Customer, session: Session, s: Settings): Promise<OutboundMessage[]> {
    const order = await getOrder(this.d.db, session.orderId);
    if (!order || order.status !== "awaiting_payment") return [{ text: STALE }];
    if (!s.orders.codEnabled) return [{ text: "Cash on delivery isn't available right now. Please pay by UPI." }];
    const done = await this.confirmOrder(order, { method: "cod" });
    if (!done.ok) return [{ text: done.message }];
    await this.save(customer, { state: "idle" });
    return [{ text: `✅ Order ${order.id} is confirmed. Please keep ${money(order.totalPaise)} ready to pay on delivery.\n🚚 Delivery ${order.etaText ?? ""}\n\nUse /status to check your orders.` }];
  }

  /** Commits stock and marks the order confirmed. On failure the order is cancelled (and refunded if paid). */
  private async confirmOrder(
    order: Order,
    pay: { method: "cod" } | { method: "upi"; paymentId: string },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { db, bus } = this.d;
    const s = await this.d.settings.get();
    try {
      const updated = await db.transaction(async (tx) => {
        const allocations = await commitOrderIn(tx, order.id, await this.stockPolicy(s));
        const lines = order.lines.map((l) => ({ ...l, batches: allocations.get(l.sku) }));
        return updateOrder(
          tx,
          order.id,
          pay.method === "cod"
            ? { status: "confirmed", lines, paymentMethod: "cod", paymentStatus: "cod" }
            : { status: "confirmed", lines, paymentMethod: "upi", paymentStatus: "paid", paymentId: pay.paymentId },
          { status: "confirmed", note: pay.method === "cod" ? "Cash on delivery" : `UPI payment ${pay.paymentId}`, at: this.now() },
        );
      });
      for (const l of updated.lines) bus.emit({ type: "stock.changed", sku: l.sku });
      bus.emit({ type: "order.updated", orderId: order.id, status: "confirmed", agentId: null });
      await audit(db, { action: "order_confirmed", customerId: order.customerId, entity: "order", entityId: order.id, data: { method: pay.method } });
      const d = updated.delivery;
      await this.alertStaff(
        "orders.view",
        `🧾 New order ${updated.id} (${pay.method === "cod" ? "cash on delivery" : "paid by UPI"})\n` +
          updated.lines.map((l) => `• ${l.brand} × ${l.qty}`).join("\n") +
          `\nTotal ${money(updated.totalPaise)}${d ? `\n${d.name}, ${formatPhone(d.phone)}\n${d.address}, ${d.pincode}` : ""}`,
      );
      return { ok: true };
    } catch (err) {
      console.error(`[order] confirm failed for ${order.id}:`, err);
      await releaseOrder(db, order.id);
      await updateOrder(db, order.id, { status: "cancelled" }, { status: "cancelled", note: `Stock unavailable: ${(err as Error).message}`, at: this.now() });
      bus.emit({ type: "order.updated", orderId: order.id, status: "cancelled", agentId: null });
      if (pay.method === "upi") await this.refund(order.id, null, "Stock no longer available");
      await this.alertStaff("orders.manage", `⚠️ Order ${order.id} could not be filled and was cancelled: ${(err as Error).message}`);
      return {
        ok: false,
        message: `Sorry, some of this stock is no longer available, so I cancelled order ${order.id}${pay.method === "upi" ? " and started a refund" : ""}. Please call us on ${s.pharmacy.phone}.`,
      };
    }
  }

  /** Payment provider webhook events. Safe to receive more than once. */
  async onPaymentEvent(event: PaymentEvent): Promise<void> {
    const { db } = this.d;
    if (event.type === "ignored") return;

    if (event.type === "refunded") {
      const [order] = await db.select().from(orders).where(eq(orders.paymentId, event.paymentId));
      if (!order || order.paymentStatus === "refunded") return;
      await updateOrder(db, order.id, { paymentStatus: "refunded", refundId: event.refundId }, { note: `Refund ${event.refundId} processed`, at: this.now() });
      this.d.bus.emit({ type: "order.updated", orderId: order.id, status: order.status, agentId: order.agentId });
      await this.sendToCustomerId(order.customerId, [{ text: `Your refund of ${money(order.totalPaise)} for order ${order.id} has been processed. It usually shows in your account within 5–7 working days.` }]);
      return;
    }

    const [order] = await db.select().from(orders).where(eq(orders.paymentLinkId, event.linkId));
    if (!order) return;
    const customer = await getCustomer(db, order.customerId);
    if (!customer) return;

    await this.serial(`${customer.channel}:${customer.channelUserId}`, async () => {
      const fresh = (await getOrder(db, order.id))!;
      if (event.type === "paid") {
        if (fresh.paymentStatus === "paid" || fresh.paymentId === event.paymentId) return;
        if (fresh.status === "awaiting_payment" && (await hasReservations(db, fresh.id))) {
          const done = await this.confirmOrder(fresh, { method: "upi", paymentId: event.paymentId });
          const session = sessionOf((await getCustomer(db, customer.id))!);
          if (session.orderId === fresh.id) await setSession(db, customer.id, { state: "idle" }, this.now());
          await this.sendTo(
            customer,
            [
              {
                text: done.ok
                  ? `✅ Payment received. Order ${fresh.id} is confirmed.\nReference: ${event.paymentId}\n🚚 Delivery ${fresh.etaText ?? ""}\n\nUse /status to check your orders.`
                  : done.message,
              },
            ],
          );
          return;
        }
        // Paid after the order was cancelled or expired, or after choosing cash: refund it.
        await updateOrder(db, fresh.id, { paymentId: event.paymentId, paymentStatus: "paid" }, { note: `Late UPI payment ${event.paymentId}`, at: this.now() });
        await this.refund(fresh.id, null, "Payment arrived after the order was closed");
        await this.sendTo(customer, [{ text: `We received ${money(event.amountPaise)} for order ${fresh.id}, but that order was already closed, so I've started a refund. It usually takes 5–7 working days.` }]);
        return;
      }

      // Link expired or cancelled before payment.
      if (fresh.status === "awaiting_payment" && fresh.paymentStatus === "pending") {
        await releaseOrder(db, fresh.id);
        await updateOrder(db, fresh.id, { status: "expired", paymentStatus: "failed" }, { status: "expired", note: "Payment link expired", at: this.now() });
        this.d.bus.emit({ type: "order.updated", orderId: fresh.id, status: "expired", agentId: null });
        const session = sessionOf((await getCustomer(db, customer.id))!);
        if (session.orderId === fresh.id) await setSession(db, customer.id, { state: "idle" }, this.now());
        await this.sendTo(customer, [{ text: `The payment link for order ${fresh.id} expired, so I released the stock. Send your list again whenever you're ready.` }]);
      }
    });
  }

  private async refund(orderId: string, userId: number | null, reason: string): Promise<boolean> {
    const { db, payments } = this.d;
    const order = await getOrder(db, orderId);
    if (!order?.paymentId || !payments || order.paymentStatus !== "paid") return false;
    try {
      const r = await payments.refund(order.paymentId, order.totalPaise, reason);
      await updateOrder(db, orderId, { paymentStatus: "refund_pending", refundId: r.refundId }, { note: `Refund started: ${reason}`, userId, at: this.now() });
      await audit(db, { action: "refund_started", userId, entity: "order", entityId: orderId, data: { refundId: r.refundId } });
      return true;
    } catch (err) {
      console.error(`[payments] refund for ${orderId} failed:`, err);
      await this.alertStaff("orders.refund", `⚠️ Refund for ${orderId} failed: ${(err as Error).message}. Please refund it from the Razorpay dashboard.`);
      return false;
    }
  }

  // ======================================================================= pharmacist questions

  private async submitQuestion(
    customer: Customer,
    kind: "question" | "complaint" | "prescription",
    question: string,
    mediaPath: string | null,
    s: Settings,
  ): Promise<OutboundMessage[]> {
    const c = await createConsultation(this.d.db, { customerId: customer.id, kind, question, mediaPath, at: this.now() });
    await this.save(customer, { state: "idle" });
    this.d.bus.emit({ type: "consultation.created", id: c.id, kind });
    const label = kind === "complaint" ? "complaint" : kind === "prescription" ? "prescription to review" : "question";
    await this.alertStaff("consultations.answer", `💬 New ${label} #${c.id}: ${question.slice(0, 200)}`);
    if (kind === "complaint") {
      return [{ text: `Sorry about that. I've passed this to our manager, who will reply here. For anything urgent, call ${s.pharmacy.managerPhone || s.pharmacy.phone}.` }];
    }
    return [{ text: `Thanks, I've sent this to our pharmacist. ${this.answerTiming(s)}` }];
  }

  private answerTiming(s: Settings): string {
    const now = this.now();
    const status = shopStatus(now, s.hours);
    if (status.open) return `They usually reply within ${s.consultations.escalateAfterMinutes} minutes.`;
    return status.nextOpenAt
      ? `We're closed now, so they'll reply after we open at ${formatWhen(status.nextOpenAt, now, s.hours.timezone)}.`
      : "We're closed now; they'll reply when we reopen.";
  }

  // ======================================================================= staff actions (dashboard)

  /** A staff reply from the dashboard inbox or a consultation answer. */
  async sendStaffMessage(customerId: number, text: string, userId: number): Promise<void> {
    const customer = await getCustomer(this.d.db, customerId);
    if (!customer) throw new Error("Customer not found");
    await this.sendTo(customer, [{ text }], { staffUserId: userId });
    await this.d.db.update(customersTable).set({ unread: 0 }).where(eq(customersTable.id, customerId));
  }

  async answerConsultation(id: number, answer: string, userId: number): Promise<void> {
    const { db } = this.d;
    const [c] = await db.select().from(consultations).where(eq(consultations.id, id));
    if (!c) throw new Error("Question not found");
    const [author] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
    const who = c.kind === "complaint" ? "our manager" : "our pharmacist";
    await this.sendStaffMessage(c.customerId, `💬 Reply from ${who}${author ? ` (${author.name})` : ""}:\n\n${answer}`, userId);
    await db
      .update(consultations)
      .set({ status: "answered", answer, answeredBy: userId, answeredAt: this.now() })
      .where(eq(consultations.id, id));
    await audit(db, { action: "consultation_answered", userId, customerId: c.customerId, entity: "consultation", entityId: String(id) });
    this.d.bus.emit({ type: "consultation.updated", id, kind: c.kind });
  }

  /** Staff take over a chat (bot goes quiet) or hand it back (userId = null). */
  async setHandoff(customerId: number, userId: number | null, byUserId: number): Promise<void> {
    const { db } = this.d;
    const customer = await getCustomer(db, customerId);
    if (!customer) throw new Error("Customer not found");
    await updateCustomer(db, customerId, { handoffUserId: userId });
    if (userId === null) await setSession(db, customerId, { state: "idle" }, this.now());
    await audit(db, { action: userId ? "chat_taken_over" : "chat_released", userId: byUserId, customerId });
    if (userId === null) await this.sendTo(customer, [{ text: "You're back with our assistant. Send a medicine list or a prescription any time." }], { staffUserId: byUserId });
  }

  async assignAgent(orderId: string, agentId: number, byUserId: number): Promise<Order> {
    const { db } = this.d;
    const order = await getOrder(db, orderId);
    if (!order) throw new Error("Order not found");
    if (!ACTIVE_STATUSES.includes(order.status)) throw new Error(`Can't assign an agent to a ${STATUS_LABEL[order.status]} order`);
    const [agent] = await db.select().from(users).where(eq(users.id, agentId));
    if (!agent?.isActive) throw new Error("Agent not found");
    const updated = await updateOrder(db, orderId, { agentId }, { note: `Assigned to ${agent.name}`, userId: byUserId, at: this.now() });
    this.d.bus.emit({ type: "order.updated", orderId, status: updated.status, agentId });
    await audit(db, { action: "agent_assigned", userId: byUserId, entity: "order", entityId: orderId, data: { agentId } });
    await this.sendToCustomerId(order.customerId, [
      { text: `🚚 ${agent.name} will deliver your order ${orderId}.${agent.phone ? `\n📞 ${formatPhone(agent.phone)}` : ""}` },
    ]);
    return updated;
  }

  async setOrderStatus(orderId: string, to: OrderStatus, byUserId: number, note?: string): Promise<Order> {
    const { db } = this.d;
    const order = await getOrder(db, orderId);
    if (!order) throw new Error("Order not found");
    if (to === "cancelled") return this.cancelOrder(orderId, byUserId, note ?? "Cancelled by the pharmacy");
    if (!STAFF_TRANSITIONS[order.status]?.includes(to)) {
      throw new Error(`Can't change a ${STATUS_LABEL[order.status]} order to ${STATUS_LABEL[to]}`);
    }
    const updated = await updateOrder(db, orderId, { status: to }, { status: to, note, userId: byUserId, at: this.now() });
    this.d.bus.emit({ type: "order.updated", orderId, status: to, agentId: updated.agentId });
    await audit(db, { action: "order_status", userId: byUserId, entity: "order", entityId: orderId, data: { to } });

    const [agent] = updated.agentId ? await db.select().from(users).where(eq(users.id, updated.agentId)) : [];
    const messages: Partial<Record<OrderStatus, string>> = {
      preparing: `📦 Your order ${orderId} is being prepared.`,
      out_for_delivery: `🛵 Your order ${orderId} is on its way${agent ? ` with ${agent.name}${agent.phone ? ` (${formatPhone(agent.phone)})` : ""}` : ""}.`,
      delivered: `✅ Your order ${orderId} has been delivered. Thank you for ordering with us!`,
    };
    if (to === "delivered" && updated.paymentMethod === "cod") {
      await updateOrder(db, orderId, { paymentStatus: "paid" }, { note: "Cash collected", userId: byUserId, at: this.now() });
    }
    const text = messages[to];
    if (text) await this.sendToCustomerId(order.customerId, [{ text }]);
    return updated;
  }

  /** Cancels an order: releases held stock or puts sold stock back, refunds UPI payments, tells the customer. */
  async cancelOrder(orderId: string, byUserId: number | null, reason: string): Promise<Order> {
    const { db, bus } = this.d;
    const order = await getOrder(db, orderId);
    if (!order) throw new Error("Order not found");
    if (["cancelled", "expired", "delivered"].includes(order.status)) {
      throw new Error(`This order is already ${STATUS_LABEL[order.status]}`);
    }
    const committed = ACTIVE_STATUSES.includes(order.status);
    const updated = await db.transaction(async (tx) => {
      if (committed) {
        for (const l of order.lines) await restockIn(tx, l.sku, l.batches ?? []);
      } else {
        await releaseOrder(tx, orderId);
      }
      return updateOrder(tx, orderId, { status: "cancelled" }, { status: "cancelled", note: reason, userId: byUserId, at: this.now() });
    });
    for (const l of order.lines) bus.emit({ type: "stock.changed", sku: l.sku });
    bus.emit({ type: "order.updated", orderId, status: "cancelled", agentId: order.agentId });
    await audit(db, { action: "order_cancelled", userId: byUserId, entity: "order", entityId: orderId, data: { reason } });

    const refunded = order.paymentStatus === "paid" ? await this.refund(orderId, byUserId, reason) : false;
    const customer = await getCustomer(db, order.customerId);
    if (customer && byUserId !== null) {
      const session = sessionOf(customer);
      if (session.orderId === orderId) await setSession(db, customer.id, { state: "idle" }, this.now());
      await this.sendTo(customer, [
        {
          text: `Your order ${orderId} was cancelled by the pharmacy.${reason ? ` Reason: ${reason}.` : ""}${refunded ? ` A refund of ${money(order.totalPaise)} has been started; it usually reaches your account in 5–7 working days.` : ""}`,
        },
      ]);
    }
    return (await getOrder(db, orderId)) ?? updated;
  }

  /** Tells waiting customers a product is back. Called after stock is added from the dashboard. */
  async notifyBackInStock(sku: string): Promise<number> {
    const { db, catalogue } = this.d;
    const product = catalogue.get(sku);
    if (!product) return 0;
    const s = await this.d.settings.get();
    const avail = (await availableMap(db, await this.stockPolicy(s), [sku])).get(sku) ?? 0;
    if (avail <= 0) return 0;
    const waiting = await db.select().from(waitlist).where(eq(waitlist.sku, sku));
    for (const w of waiting) {
      await this.sendToCustomerId(w.customerId, [
        { text: `Good news: ${product.brand} is back in stock.`, buttons: [[{ label: `🛒 Order ${shortLabel(product.brand, 24)}`, action: `add:${sku}` }]] },
      ]).catch((e) => console.error("[waitlist]", e));
    }
    if (waiting.length) await db.delete(waitlist).where(eq(waitlist.sku, sku));
    return waiting.length;
  }

  // ======================================================================= jobs

  /** Releases expired stock holds, resets stale chats and escalates unanswered questions. Run every minute. */
  async runJobs(): Promise<void> {
    const { db } = this.d;
    const s = await this.d.settings.get();
    const now = this.now();

    for (const orderId of await expireReservations(db, now)) {
      const order = await getOrder(db, orderId);
      if (!order || !OPEN_STATUSES.includes(order.status)) continue;
      const customer = await getCustomer(db, order.customerId);
      if (!customer) continue;
      await this.serial(`${customer.channel}:${customer.channelUserId}`, async () => {
        await updateOrder(db, orderId, { status: "expired", paymentStatus: order.paymentStatus === "pending" ? "failed" : order.paymentStatus }, { status: "expired", note: "Stock hold expired", at: now });
        this.d.bus.emit({ type: "order.updated", orderId, status: "expired", agentId: null });
        const session = sessionOf((await getCustomer(db, customer.id))!);
        if (session.orderId === orderId) await setSession(db, customer.id, { state: "idle" }, now);
        await this.sendTo(customer, [
          { text: `Your cart (${orderId}) expired, so I released the stock. Send your list again whenever you're ready.`, removeKeyboard: true },
        ]).catch((e) => console.error("[jobs] expiry message:", e));
      });
    }

    for (const c of await escalateOverdue(db, now, s.consultations.escalateAfterMinutes)) {
      this.d.bus.emit({ type: "consultation.escalated", id: c.id, kind: c.kind });
      await this.alertStaff("consultations.answer", `⏰ ${c.kind === "complaint" ? "Complaint" : "Question"} #${c.id} has waited over ${s.consultations.escalateAfterMinutes} minutes: ${c.question.slice(0, 150)}`, ["manager", "admin"]);
    }
  }

  // ======================================================================= helpers

  private async save(customer: Customer, session: Session) {
    await setSession(this.d.db, customer.id, session, this.now());
  }

  /** Drops a cart that was only held (never confirmed), e.g. before rebuilding it with a substitute. */
  private async dropReservedOrder(session: Session) {
    if (!session.orderId) return;
    const order = await getOrder(this.d.db, session.orderId);
    if (order?.status === "reserved") {
      await releaseOrder(this.d.db, order.id);
      await this.d.db.delete(orders).where(eq(orders.id, order.id));
    }
  }

  private async abandon(customer: Customer, session: Session, status: "cancelled" | "expired") {
    const { db } = this.d;
    const order = await getOrder(db, session.orderId);
    if (order && OPEN_STATUSES.includes(order.status)) {
      await releaseOrder(db, order.id);
      await updateOrder(db, order.id, { status }, { status, note: status === "cancelled" ? "Cancelled by customer" : "Chat timed out", at: this.now() });
      this.d.bus.emit({ type: "order.updated", orderId: order.id, status, agentId: null });
      await audit(db, { action: `order_${status}`, customerId: customer.id, entity: "order", entityId: order.id });
    }
    await this.save(customer, { state: "idle" });
  }

  private async sendToCustomerId(customerId: number, messages: OutboundMessage[]) {
    const customer = await getCustomer(this.d.db, customerId);
    if (customer) await this.sendTo(customer, messages);
  }

  /**
   * Sends outside a reply. On WhatsApp, after 24 hours without a customer message only an
   * approved template can be sent, so the first message goes out as that template.
   */
  async sendTo(customer: Customer, messages: OutboundMessage[], opts: { staffUserId?: number } = {}) {
    const sender = this.d.senders[customer.channel];
    if (!sender) throw new Error(`No ${customer.channel} connection configured`);
    const s = await this.d.settings.get();
    const windowClosed =
      customer.channel === "whatsapp" &&
      (!customer.lastMessageAt || this.now().getTime() - customer.lastMessageAt.getTime() > 24 * 60 * 60 * 1000);

    if (windowClosed) {
      if (!s.whatsapp.followUpTemplate || !sender.sendTemplate) {
        throw new WindowClosedError(
          "This customer hasn't messaged in 24 hours, so WhatsApp only allows an approved template. Set one in Settings → WhatsApp.",
        );
      }
      const text = messages.map((m) => m.text).join("\n\n");
      await sender.sendTemplate(customer.channelUserId, s.whatsapp.followUpTemplate, s.whatsapp.templateLanguage, [s.pharmacy.name, text.slice(0, 900)]);
    } else {
      await sender.send(customer.channelUserId, messages);
    }
    for (const m of messages) {
      await logMessage(this.d.db, {
        customerId: customer.id,
        direction: "out",
        sender: opts.staffUserId ? "staff" : "bot",
        userId: opts.staffUserId ?? null,
        text: m.text,
        at: this.now(),
      });
    }
    this.d.bus.emit({ type: "message.out", customerId: customer.id });
  }

  /**
   * Staff alerts appear live in the dashboard (via events). Staff who linked a Telegram chat
   * and are on duty also get a Telegram message.
   */
  private async alertStaff(permission: Permission, text: string, roleKeys?: string[]) {
    const telegram = this.d.senders.telegram;
    if (!telegram) return;
    const rows = await this.d.db
      .select({ chat: users.telegramChatId, grant: users.grantPermissions, deny: users.denyPermissions, perms: roles.permissions, role: roles.key })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.isActive, true), eq(users.onDuty, true)));
    for (const r of rows) {
      if (!r.chat) continue;
      if (roleKeys && !roleKeys.includes(r.role)) continue;
      if (!effectivePermissions(r.perms, r.grant, r.deny).includes(permission)) continue;
      await telegram.send(r.chat, [{ text }]).catch((e) => console.error(`[alerts] ${r.chat}:`, e));
    }
  }

  private consentMessage(s: Settings): OutboundMessage {
    return {
      text:
        `Welcome to ${s.pharmacy.name} 👋\n\n` +
        "Send me a photo or PDF of your prescription, or type the medicine names, and I'll check what we can deliver.\n\n" +
        "Before we start:\n" +
        `• Your messages and prescription images are stored to process your order and deleted after ${s.bot.uploadRetentionDays} days.\n` +
        "• Images and some messages are read by an AI service (Google Gemini).\n" +
        "• Prescription-only medicines need a pharmacist's check.\n\n" +
        "Do you agree?",
      buttons: [[{ label: "✅ I agree", action: "consent:yes" }]],
    };
  }

  private paymentMethodsText(s: Settings): string {
    const m = [s.orders.upiEnabled && this.d.payments ? "UPI" : null, s.orders.codEnabled ? "cash on delivery" : null].filter(Boolean);
    return m.join(" or ") || "payment at the store";
  }

  private deliveryFeeText(s: Settings): string {
    return `${money(s.delivery.feeRupees * 100)}, free on orders of ${money(s.delivery.freeAboveRupees * 100)} or more`;
  }
}

// ======================================================================= module helpers

function describeInbound(msg: InboundMessage): string {
  if (msg.action) return `[button] ${ACTION_LABELS[msg.action] ?? msg.action}`;
  if (msg.location) return `[location] ${msg.location.lat.toFixed(5)}, ${msg.location.lng.toFixed(5)}`;
  if (msg.contactPhone) return `[contact] ${msg.contactPhone}`;
  if (msg.media) return `[${msg.media.kind === "pdf" ? "PDF" : "photo"}]${msg.text ? ` ${msg.text}` : ""}`;
  return msg.text ?? "";
}

function readyText(): string {
  return "You're all set. Send a photo or PDF of your prescription, or type the medicine names, for example:\n\n2 Dolo 650\nEno\nVolini gel";
}

function helpText(s: Settings): string {
  return (
    "How to order:\n" +
    "1. Send a photo or PDF of your prescription, or type the medicine names.\n" +
    "2. Check the list I found and tap Yes.\n" +
    "3. Review the cart, add your address and pay.\n\n" +
    "Commands:\n/status: your recent orders\n/ask: ask our pharmacist a question\n/hours: opening hours\n/cancel: cancel what you're doing\n\n" +
    `We deliver within ${s.delivery.radiusKm} km. Questions? Call ${s.pharmacy.phone}.`
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

function orderSummaryLine(o: Order, s: Settings): string {
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: s.hours.timezone, day: "numeric", month: "short" }).format(o.createdAt);
  return `${o.id} (${date}): ${STATUS_LABEL[o.status]}, ${money(o.totalPaise)}`;
}

