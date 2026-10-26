import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_ROLES } from "../auth/permissions.ts";
import { hashPassword } from "../auth/password.ts";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settings.ts";
import { rupeesToPaise, SeedInventorySchema, SeedProductSchema } from "../types.ts";
import type { DB } from "./client.ts";
import { batches, products, roles, settings, users } from "./schema.ts";

/** Creates the built-in roles if they're missing. Existing roles are left as staff edited them. */
export async function seedRoles(db: DB) {
  for (const r of DEFAULT_ROLES) {
    await db
      .insert(roles)
      .values({ key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: true })
      .onConflictDoNothing({ target: roles.key });
  }
}

export async function seedSettings(db: DB) {
  const [row] = await db.select().from(settings).where(eq(settings.key, "app"));
  if (!row) await new SettingsService(db).save(DEFAULT_SETTINGS, null);
}

function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

/**
 * Loads data/catalogue.json and data/inventory.json into an empty database.
 * Does nothing if products already exist, so it is safe to run on every start.
 */
export async function seedCatalogue(db: DB, catalogueFile: string, inventoryFile: string): Promise<number> {
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(products)) as [{ n: number }];
  if (n > 0) return 0;

  const cat = JSON.parse(readFileSync(catalogueFile, "utf8")) as { products: unknown[] };
  const inv = SeedInventorySchema.parse(JSON.parse(readFileSync(inventoryFile, "utf8")));
  const items = cat.products.map((p) => SeedProductSchema.parse(p));

  await db.transaction(async (tx) => {
    for (const p of items) {
      const stock = inv.items[p.sku];
      await tx.insert(products).values({
        sku: p.sku,
        brand: p.brand,
        generic: p.generic,
        composition: p.composition,
        form: p.form,
        pack: p.pack,
        manufacturer: p.manufacturer,
        category: p.category,
        system: p.system,
        schedule: p.schedule,
        rxRequired: p.rx_required,
        maxPacksPerOrder: p.max_packs_per_order,
        mrpPaise: rupeesToPaise(p.mrp),
        aliases: p.aliases,
        warnings: p.warnings,
        verifiedPrice: p.verified.price,
        verifiedSchedule: p.verified.schedule,
        notes: p.notes ?? null,
        replacedBy: p.replaced_by ?? null,
        source: p.source,
        active: p.active,
        reorderLevel: stock?.reorder_level ?? 0,
        rack: stock?.rack ?? null,
        manualHold: stock?.reserved ?? 0,
      });
    }
    for (const p of items) {
      for (const b of inv.items[p.sku]?.batches ?? []) {
        await tx.insert(batches).values({ sku: p.sku, batchNo: b.batch, mfg: `${b.mfg}-01`, exp: monthEnd(b.exp), qty: b.qty });
      }
    }
  });
  return items.length;
}

export async function createUser(
  db: DB,
  u: { name: string; email: string; password: string; roleKey: string; phone?: string },
): Promise<number> {
  const [role] = await db.select().from(roles).where(eq(roles.key, u.roleKey));
  if (!role) throw new Error(`Unknown role "${u.roleKey}"`);
  const [row] = await db
    .insert(users)
    .values({
      name: u.name,
      email: u.email.toLowerCase(),
      phone: u.phone ?? null,
      passwordHash: await hashPassword(u.password),
      roleId: role.id,
    })
    .returning({ id: users.id });
  return row!.id;
}
