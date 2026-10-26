import type { CatalogueCache } from "../services/catalogue.ts";
import type { Product, Schedule } from "../types.ts";

export type SaleRule = "auto" | "pharmacist_review" | "pharmacist_review_with_register" | "never_online";

/** What the bot may do with each drug schedule. Regulatory, so not editable from the dashboard. */
export const SCHEDULE_RULES: Record<Schedule, SaleRule> = {
  OTC: "auto",
  G: "pharmacist_review",
  H: "pharmacist_review",
  H1: "pharmacist_review_with_register",
  X: "never_online",
};

export type RefusalCode = "not_stocked" | "discontinued" | "prescription" | "schedule_x";

export type RuleDecision =
  | { kind: "sell"; product: Product; qty: number; notes: string[] }
  | { kind: "refuse"; name: string; product?: Product; reason: string; code: RefusalCode };

/** Decides whether the bot may sell one requested item. Stock is checked separately. */
export function decide(
  catalogue: CatalogueCache,
  sku: string | null,
  asWritten: string,
  qty: number,
  pharmacyPhone: string,
): RuleDecision {
  let product = sku ? catalogue.get(sku) : undefined;
  if (!product) {
    return { kind: "refuse", name: asWritten, reason: "We don't stock this.", code: "not_stocked" };
  }

  const notes: string[] = [];
  if (!product.active) {
    const replacement = product.replacedBy ? catalogue.get(product.replacedBy) : undefined;
    if (!replacement?.active) {
      return { kind: "refuse", name: product.brand, product, reason: "This product is discontinued.", code: "discontinued" };
    }
    notes.push(`Replaces ${product.brand}, which is discontinued (same composition).`);
    product = replacement;
  }

  const rule = SCHEDULE_RULES[product.schedule];
  if (rule === "never_online") {
    return {
      kind: "refuse",
      name: product.brand,
      product,
      reason: `Schedule ${product.schedule} medicine. It can't be sold online.`,
      code: "schedule_x",
    };
  }
  if (rule !== "auto") {
    return {
      kind: "refuse",
      name: product.brand,
      product,
      reason: `Needs a doctor's prescription checked by our pharmacist (Schedule ${product.schedule}). Call ${pharmacyPhone} or visit the store.`,
      code: "prescription",
    };
  }

  if (qty > product.maxPacksPerOrder) {
    notes.push(`Limited to ${product.maxPacksPerOrder} per order.`);
    qty = product.maxPacksPerOrder;
  }
  return { kind: "sell", product, qty, notes };
}
