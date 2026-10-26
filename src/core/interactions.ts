import type { Product } from "../types.ts";

export interface InteractionRule {
  ingredientA: string;
  ingredientB: string;
  message: string;
  severity: "warn" | "block";
}

export interface InteractionWarning {
  message: string;
  severity: "warn" | "block";
}

const ingredientsOf = (p: Product) => [...new Set(p.composition.map((c) => c.name.toLowerCase().trim()))];
const contains = (ingredients: string[], name: string) => ingredients.some((i) => i.includes(name.toLowerCase().trim()));

/**
 * Warnings for a cart:
 * - The same ingredient in two products (double dose), always checked.
 * - Pairs from the interaction rules pharmacists maintain in the dashboard.
 */
export function checkInteractions(products: Product[], rules: InteractionRule[]): InteractionWarning[] {
  const warnings: InteractionWarning[] = [];
  const seen = new Map<string, number>();
  for (const p of products) for (const i of ingredientsOf(p)) seen.set(i, (seen.get(i) ?? 0) + 1);
  for (const [ingredient, count] of seen) {
    if (count >= 2) {
      warnings.push({ message: `More than one of these contains ${ingredient}. Don't take them together.`, severity: "warn" });
    }
  }

  for (const rule of rules) {
    for (let i = 0; i < products.length; i++) {
      for (let j = 0; j < products.length; j++) {
        if (i === j) continue;
        const a = ingredientsOf(products[i]!);
        const b = ingredientsOf(products[j]!);
        if (contains(a, rule.ingredientA) && contains(b, rule.ingredientB)) {
          if (!warnings.some((w) => w.message === rule.message)) warnings.push({ message: rule.message, severity: rule.severity });
        }
      }
    }
  }
  return warnings;
}
