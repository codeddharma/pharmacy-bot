import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth/password.ts";
import { config } from "./config.ts";
import { openDatabase } from "./db/client.ts";
import { roles, users } from "./db/schema.ts";
import { createUser, seedCatalogue, seedRoles, seedSettings } from "./db/seed.ts";

/**
 * Admin tasks from the command line:
 *   npm run user:create -- --role admin --name "Neel" --email neel@example.com [--password ...]
 *   npm run user:password -- --email neel@example.com [--password ...]
 *   npm run db:seed
 * Without --password, a random one is generated and printed once.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" }, password: { type: "string" }, phone: { type: "string" } },
  });
  const { db, close } = await openDatabase({ url: config.databaseUrl || undefined, pgliteDir: config.pgliteDir });
  try {
    await seedRoles(db);
    await seedSettings(db);
    switch (command) {
      case "seed": {
        const n = await seedCatalogue(db, config.seedCatalogue, config.seedInventory);
        console.log(n ? `Loaded ${n} medicines.` : "Medicines already loaded; nothing to do.");
        break;
      }
      case "create-user": {
        if (!values.email || !values.name || !values.role) throw new Error('Usage: npm run user:create -- --role admin --name "Name" --email you@example.com');
        const available = (await db.select({ key: roles.key }).from(roles)).map((r) => r.key);
        if (!available.includes(values.role)) throw new Error(`Unknown role. Use one of: ${available.join(", ")}`);
        const password = values.password ?? randomBytes(9).toString("base64url");
        await createUser(db, { name: values.name, email: values.email, password, roleKey: values.role, phone: values.phone });
        console.log(`Created ${values.role} ${values.email}.${values.password ? "" : `\nPassword: ${password}\nChange it after logging in.`}`);
        break;
      }
      case "set-password": {
        if (!values.email) throw new Error("Usage: npm run user:password -- --email you@example.com");
        const password = values.password ?? randomBytes(9).toString("base64url");
        const updated = await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.email, values.email.toLowerCase())).returning();
        if (!updated.length) throw new Error(`No user with email ${values.email}`);
        console.log(`Password updated for ${values.email}.${values.password ? "" : `\nNew password: ${password}`}`);
        break;
      }
      default:
        throw new Error("Commands: seed, create-user, set-password");
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
