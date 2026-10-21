import type { CatalogueStore } from "../store/catalogue.ts";
import type { Product } from "../types.ts";

export type RuleDecision =
  | { kind: "sell"; product: Product; qty: number; notes: string[] }
  | { kind: "refuse"; name: string; product?: Product; reason: string; code: RefusalCode };

export type RefusalCode = "not_stocked" | "discontinued" | "prescription" | "schedule_x";

/**
 * Decides whether the bot may sell one requested item. Stock is checked separately.
 * Only products whose schedule maps to "auto" in catalogue.meta.schedule_rules are sold.
 */
export function decide(
  catalogue: CatalogueStore,
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
    const replacement = product.replaced_by ? catalogue.get(product.replaced_by) : undefined;
    if (!replacement?.active) {
      return { kind: "refuse", name: product.brand, product, reason: "This product is discontinued.", code: "discontinued" };
    }
    notes.push(`Replaces ${product.brand}, which is discontinued (same composition).`);
    product = replacement;
  }

  const rule = catalogue.scheduleRules[product.schedule];
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

  if (qty > product.max_packs_per_order) {
    notes.push(`Limited to ${product.max_packs_per_order} per order.`);
    qty = product.max_packs_per_order;
  }
  return { kind: "sell", product, qty, notes };
}
