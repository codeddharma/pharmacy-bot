import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GrammyError } from "grammy";
import { buildServer } from "./api/server.ts";
import { createTelegram } from "./channels/telegram.ts";
import { createWhatsApp } from "./channels/whatsapp.ts";
import { config } from "./config.ts";
import { Engine, type ChannelSender } from "./core/engine.ts";
import { cleanupUploads } from "./core/jobs.ts";
import { openDatabase } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { seedCatalogue, seedRoles, seedSettings } from "./db/seed.ts";
import { GeminiExtractor } from "./extract/gemini.ts";
import type { Extractor } from "./extract/types.ts";
import { MockPaymentProvider } from "./payments/mock.ts";
import { RazorpayProvider } from "./payments/razorpay.ts";
import type { PaymentProvider } from "./payments/types.ts";
import { CatalogueCache } from "./services/catalogue.ts";
import { EventBus } from "./services/events.ts";
import { SettingsService } from "./services/settings.ts";
import type { Channel } from "./types.ts";

async function main() {
  const { db, close } = await openDatabase({ url: config.databaseUrl || undefined, pgliteDir: config.pgliteDir });
  console.log(`[db] ${config.databaseUrl ? "PostgreSQL" : `embedded PGlite at ${config.pgliteDir} (development only)`}`);

  await seedRoles(db);
  await seedSettings(db);
  const seeded = await seedCatalogue(db, config.seedCatalogue, config.seedInventory);
  if (seeded) console.log(`[db] loaded ${seeded} medicines from data/catalogue.json`);
  const staff = await db.select({ id: users.id }).from(users).limit(1);
  if (staff.length === 0) console.warn('[auth] No staff accounts yet. Create the first admin: npm run user:create -- --role admin --name "Your Name" --email you@example.com');

  const settings = new SettingsService(db);
  const catalogue = new CatalogueCache(db);
  await catalogue.load();
  const bus = new EventBus();

  let extractor: Extractor | null = null;
  if (config.extractor === "gemini" && config.geminiApiKey) {
    extractor = new GeminiExtractor(config.geminiApiKey, config.geminiModel);
    console.log(`[extract] ${extractor.name}`);
  } else {
    console.warn("[extract] GEMINI_API_KEY not set: photos and PDFs are off, typed lists still work.");
  }

  let payments: PaymentProvider | null;
  if (config.paymentProvider === "razorpay") {
    if (!config.razorpayKeyId || !config.razorpayKeySecret || !config.razorpayWebhookSecret) {
      throw new Error("PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET");
    }
    payments = new RazorpayProvider(config.razorpayKeyId, config.razorpayKeySecret);
    console.log(`[payments] Razorpay (${config.razorpayKeyId.startsWith("rzp_test_") ? "test mode" : "LIVE"})`);
  } else {
    payments = new MockPaymentProvider(config.publicUrl);
    console.warn("[payments] mock provider: UPI payments are fake. Set PAYMENT_PROVIDER=razorpay for real payments.");
  }

  const senders: Partial<Record<Channel, ChannelSender>> = {};
  const telegram = config.telegramToken ? createTelegram(config.telegramToken) : null;
  if (telegram) senders.telegram = telegram.sender;
  const w = config.whatsapp;
  const whatsapp = w.token && w.phoneNumberId && w.verifyToken && w.appSecret ? createWhatsApp(w) : null;
  if (whatsapp) senders.whatsapp = whatsapp.sender;
  if (!telegram && !whatsapp) console.warn("[channels] Neither Telegram nor WhatsApp is configured; only the dashboard will run.");

  const engine = new Engine({
    db,
    catalogue,
    settings,
    bus,
    extractor,
    payments,
    senders,
    saveUpload: async (key, data, ext) => {
      const dir = path.join(config.uploadsDir, key.replace(/[^a-z0-9_-]/gi, "_"));
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext.replace(/[^a-z0-9]/gi, "")}`);
      await writeFile(file, data, { mode: 0o600 });
      return file;
    },
  });

  const app = await buildServer(
    {
      db,
      engine,
      catalogue,
      settings,
      bus,
      payments,
      uploadsDir: config.uploadsDir,
      dashboardDir: config.dashboardDir,
      publicUrl: config.publicUrl,
      cookieSecure: config.publicUrl.startsWith("https://"),
      razorpayWebhookSecret: config.razorpayWebhookSecret,
    },
    (server) => {
      if (whatsapp) whatsapp.register(server, engine);
    },
  );

  if (telegram) {
    telegram.attach(engine);
    if (config.telegramMode === "webhook") {
      if (!config.telegramWebhookSecret) throw new Error("TELEGRAM_MODE=webhook needs TELEGRAM_WEBHOOK_SECRET");
      if (!config.publicUrl.startsWith("https://")) throw new Error("TELEGRAM_MODE=webhook needs an https PUBLIC_URL");
      await telegram.useWebhook(app, config.publicUrl, config.telegramWebhookSecret);
    }
  }
  if (whatsapp) console.log(`[whatsapp] webhook ${config.publicUrl}/webhooks/whatsapp`);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[api] dashboard and API on http://${config.host}:${config.port} (public: ${config.publicUrl})`);
  if (telegram && config.telegramMode === "polling") await telegram.startPolling();

  const runCleanup = async () => {
    const s = await settings.get();
    const n = await cleanupUploads(config.uploadsDir, s.bot.uploadRetentionDays, new Date());
    if (n) console.log(`[uploads] deleted ${n} files older than ${s.bot.uploadRetentionDays} days`);
  };
  void runCleanup().catch((e) => console.error("[uploads]", e));
  const timers = [
    setInterval(() => engine.runJobs().catch((e) => console.error("[jobs]", e)), 60_000),
    setInterval(() => runCleanup().catch((e) => console.error("[uploads]", e)), 6 * 60 * 60 * 1000),
  ];

  // PM2 sends SIGINT on stop/restart: stop taking work, finish what's running, close the database.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[app] shutting down");
    timers.forEach(clearInterval);
    if (telegram && config.telegramMode === "polling") await telegram.bot.stop();
    await app.close();
    await close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((err) => {
  if (err instanceof GrammyError && err.error_code === 401) {
    console.error("Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN in .env (get it from @BotFather).");
  } else {
    console.error(err);
  }
  process.exit(1);
});
