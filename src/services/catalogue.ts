import { asc } from "drizzle-orm";
import type { DbOrTx } from "../db/client.ts";
import { products } from "../db/schema.ts";
import { toProduct, type Product } from "../types.ts";

/**
 * In-memory copy of the products table for the bot's fast, synchronous lookups.
 * Reloaded whenever staff change the catalogue from the dashboard.
 */
export class CatalogueCache {
  private list: Product[] = [];
  private bySku = new Map<string, Product>();
  private listeners: (() => void)[] = [];

  constructor(private readonly db: DbOrTx) {}

  async load(): Promise<void> {
    const rows = await this.db.select().from(products).orderBy(asc(products.brand));
    this.list = rows.map(toProduct);
    this.bySku = new Map(this.list.map((p) => [p.sku, p]));
    for (const fn of this.listeners) fn();
  }

  get products(): Product[] {
    return this.list;
  }

  get(sku: string): Product | undefined {
    return this.bySku.get(sku);
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }
}

/** Ingredients and strengths, normalised, so products with the same composition compare equal. */
export function compositionKey(p: Pick<Product, "composition">): string {
  return p.composition
    .map((c) => `${c.name.toLowerCase().replace(/\s+/g, " ").trim()}|${(c.strength ?? "").toLowerCase().replace(/\s+/g, "")}`)
    .sort()
    .join("+");
}

/** Other sellable products with exactly the same ingredients and strengths (never for prescription items). */
export function substitutesFor(product: Product, all: Product[]): Product[] {
  if (product.schedule !== "OTC") return [];
  const key = compositionKey(product);
  return all.filter((p) => p.sku !== product.sku && p.active && p.schedule === "OTC" && compositionKey(p) === key);
}
