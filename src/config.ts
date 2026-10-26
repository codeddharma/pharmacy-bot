import { existsSync } from "node:fs";
import path from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

/**
 * Server settings from the environment (.env). Pharmacy settings such as opening hours,
 * delivery radius and fees live in the database and are edited from the dashboard.
 */
export const config = {
  port: num("PORT", 3000),
  host: env("HOST", "127.0.0.1"),
  /** The dashboard's public address, e.g. https://admin.example.com. Webhooks and payment links use it. */
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),

  /** PostgreSQL connection. Leave empty for the embedded database in PGLITE_DIR (development only). */
  databaseUrl: env("DATABASE_URL"),
  pgliteDir: path.resolve(env("PGLITE_DIR", "./data/pgdata")),
  uploadsDir: path.resolve(env("UPLOADS_DIR", "./data/uploads")),
  dashboardDir: path.resolve(env("DASHBOARD_DIR", "./dashboard/dist")),
  seedCatalogue: path.resolve("data/catalogue.json"),
  seedInventory: path.resolve("data/inventory.json"),

  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  /** "polling" for local development, "webhook" on the server. */
  telegramMode: env("TELEGRAM_MODE", "polling") as "polling" | "webhook",
  telegramWebhookSecret: env("TELEGRAM_WEBHOOK_SECRET"),

  whatsapp: {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    graphVersion: env("WHATSAPP_GRAPH_VERSION", "v23.0"),
  },

  extractor: env("EXTRACTOR", "gemini") as "gemini" | "none",
  geminiApiKey: env("GEMINI_API_KEY"),
  geminiModel: env("GEMINI_MODEL", "gemini-3.1-flash-lite"),

  /** "mock" pays instantly through a local page; "razorpay" takes real payments. */
  paymentProvider: env("PAYMENT_PROVIDER", "mock") as "mock" | "razorpay",
  razorpayKeyId: env("RAZORPAY_KEY_ID"),
  razorpayKeySecret: env("RAZORPAY_KEY_SECRET"),
  razorpayWebhookSecret: env("RAZORPAY_WEBHOOK_SECRET"),
};

export type Config = typeof config;
