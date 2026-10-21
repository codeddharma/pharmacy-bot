import { existsSync } from "node:fs";
import path from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  extractor: (process.env.EXTRACTOR ?? "gemini") as "gemini" | "none",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
  adminChatIds: list("ADMIN_CHAT_IDS"),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),

  pharmacyName: process.env.PHARMACY_NAME ?? "Demo Pharmacy",
  pharmacyPhone: process.env.PHARMACY_PHONE ?? "+91 00000 00000",
  /** PIN code prefixes you deliver to, e.g. "380,382". Empty = deliver everywhere. */
  serviceablePincodePrefixes: list("SERVICEABLE_PINCODE_PREFIXES"),
  deliveryFee: num("DELIVERY_FEE", 40),
  freeDeliveryAbove: num("FREE_DELIVERY_ABOVE", 499),

  reservationMinutes: num("RESERVATION_MINUTES", 15),
  sessionTimeoutMinutes: num("SESSION_TIMEOUT_MINUTES", 30),
  uploadRetentionDays: num("UPLOAD_RETENTION_DAYS", 30),
  maxUploadBytes: 20 * 1024 * 1024, // Telegram bots can't download bigger files anyway
};

export type Config = typeof config;
