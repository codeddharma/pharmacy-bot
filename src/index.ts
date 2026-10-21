import path from "node:path";
import { GrammyError } from "grammy";
import { createTelegram } from "./channels/telegram.ts";
import { config } from "./config.ts";
import { Engine } from "./core/engine.ts";
import { cleanupUploads } from "./core/jobs.ts";
import { MockPaymentProvider } from "./core/payment.ts";
import { GeminiExtractor } from "./extract/gemini.ts";
import type { Extractor } from "./extract/types.ts";
import { CatalogueStore } from "./store/catalogue.ts";
import { openStore } from "./store/db.ts";

async function main() {
  if (!config.telegramToken) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const store = await openStore(config.dataDir);
  const catalogue = new CatalogueStore(path.join(config.dataDir, "catalogue.json"));
  catalogue.watch();
  console.log(`[data] ${catalogue.products.length} products, ${Object.keys(store.inventory.data.items).length} inventory items from ${config.dataDir}`);

  let extractor: Extractor | null = null;
  if (config.extractor === "gemini" && config.geminiApiKey) {
    extractor = new GeminiExtractor(config.geminiApiKey, config.geminiModel);
    console.log(`[extract] using ${extractor.name}`);
  } else {
    console.warn("[extract] GEMINI_API_KEY not set: photos and PDFs are off, typed lists still work.");
  }
  if (config.adminChatIds.length === 0) console.warn("[admin] ADMIN_CHAT_IDS is empty: no one gets order alerts.");

  const telegram = createTelegram(config);
  const engine = new Engine({
    store,
    catalogue,
    extractor,
    payment: new MockPaymentProvider(),
    notifier: telegram.notifier,
    config,
  });
  telegram.attach(engine);

  const runCleanup = () =>
    cleanupUploads(config.dataDir, config.uploadRetentionDays, new Date())
      .then((n) => n && console.log(`[uploads] deleted ${n} files older than ${config.uploadRetentionDays} days`))
      .catch((e) => console.error("[uploads]", e));
  void runCleanup();

  const timers = [
    setInterval(() => engine.runJobs().catch((e) => console.error("[jobs]", e)), 60_000),
    setInterval(runCleanup, 6 * 60 * 60 * 1000),
  ];
  const stop = () => {
    timers.forEach(clearInterval);
    void telegram.bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await telegram.start();
}

main().catch((err) => {
  if (err instanceof GrammyError && err.error_code === 401) {
    console.error("Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN in .env (get it from @BotFather).");
  } else {
    console.error(err);
  }
  process.exit(1);
});
