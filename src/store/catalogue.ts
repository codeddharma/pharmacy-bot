import { readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { CatalogueSchema, type Catalogue, type Product } from "../types.ts";

/**
 * Read-only view of data/catalogue.json. Edit the file while the bot is running and
 * it reloads automatically; if the new file is invalid, the old one stays in use.
 */
export class CatalogueStore {
  private data: Catalogue;
  private bySku = new Map<string, Product>();
  private listeners: (() => void)[] = [];

  constructor(private readonly file: string) {
    this.data = CatalogueStore.load(file);
    this.index();
  }

  static load(file: string): Catalogue {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const parsed = CatalogueSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${path.basename(file)} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }
    const skus = new Set<string>();
    for (const p of parsed.data.products) {
      if (skus.has(p.sku)) throw new Error(`Duplicate SKU in catalogue: ${p.sku}`);
      skus.add(p.sku);
    }
    return parsed.data;
  }

  private index() {
    this.bySku = new Map(this.data.products.map((p) => [p.sku, p]));
    for (const fn of this.listeners) fn();
  }

  get products(): Product[] {
    return this.data.products;
  }

  get scheduleRules() {
    return this.data.meta.schedule_rules;
  }

  get(sku: string): Product | undefined {
    return this.bySku.get(sku);
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  reload(): { ok: true; count: number } | { ok: false; error: string } {
    try {
      this.data = CatalogueStore.load(this.file);
      this.index();
      return { ok: true, count: this.data.products.length };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private watcher?: FSWatcher;

  watch() {
    let timer: NodeJS.Timeout | undefined;
    this.watcher = watch(this.file, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const result = this.reload();
        if (result.ok) console.log(`[catalogue] reloaded ${result.count} products`);
        else console.error(`[catalogue] reload failed, keeping previous version:\n${result.error}`);
      }, 300);
    });
  }

  /** Stops watching the file so the process can exit. */
  close() {
    this.watcher?.close();
  }
}
