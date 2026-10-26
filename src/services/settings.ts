import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../db/client.ts";
import { settings } from "../db/schema.ts";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");

export const SettingsSchema = z.object({
  pharmacy: z.object({
    name: z.string().min(1),
    phone: z.string(),
    pharmacistPhone: z.string(),
    managerPhone: z.string(),
    address: z.string(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
  }),
  hours: z.object({
    timezone: z.string(),
    /** Index 0 = Sunday … 6 = Saturday. */
    weekly: z
      .array(z.object({ open: hhmm, close: hhmm, closed: z.boolean() }))
      .length(7),
    /** Dates the shop is closed, YYYY-MM-DD. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Orders placed less than this many minutes before closing are delivered at the next opening. */
    sameDayCutoffMinutes: z.number().int().min(0).max(240),
    /** "auto" follows the weekly hours; staff can force open or closed. */
    override: z.enum(["auto", "open", "closed"]),
  }),
  delivery: z.object({
    radiusKm: z.number().positive(),
    feeRupees: z.number().min(0),
    freeAboveRupees: z.number().min(0),
    /** Delivery time shown to customers, by distance. Sorted by maxKm. */
    etaBands: z.array(z.object({ maxKm: z.number().positive(), text: z.string().min(1) })).min(1),
    /** If set, PIN codes must start with one of these (used when the customer doesn't share a location). */
    serviceablePincodePrefixes: z.array(z.string().regex(/^\d{1,6}$/)),
    /** Refuse checkout unless the customer shares their location. */
    requireLocation: z.boolean(),
  }),
  inventory: z.object({
    /** Batches expiring within this many days are never sold. */
    nearExpiryDays: z.number().int().min(0).max(365),
  }),
  orders: z.object({
    reservationMinutes: z.number().int().min(5).max(120),
    /** Warn when the same items were ordered within this many minutes. */
    duplicateWindowMinutes: z.number().int().min(0),
    codEnabled: z.boolean(),
    upiEnabled: z.boolean(),
  }),
  consultations: z.object({
    /** Alert managers when a question has waited this long. */
    escalateAfterMinutes: z.number().int().min(1),
  }),
  bot: z.object({
    sessionTimeoutMinutes: z.number().int().min(5),
    uploadRetentionDays: z.number().int().min(1),
  }),
  whatsapp: z.object({
    /** Approved template used to reply after WhatsApp's 24-hour window has closed. */
    followUpTemplate: z.string(),
    templateLanguage: z.string(),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

const nineToNine = { open: "09:00", close: "21:00", closed: false };

export const DEFAULT_SETTINGS: Settings = {
  pharmacy: {
    name: "Demo Pharmacy",
    phone: "+91 00000 00000",
    pharmacistPhone: "+91 00000 00000",
    managerPhone: "+91 00000 00000",
    address: "",
    lat: null,
    lng: null,
  },
  hours: {
    timezone: "Asia/Kolkata",
    weekly: Array.from({ length: 7 }, () => ({ ...nineToNine })),
    holidays: [],
    sameDayCutoffMinutes: 30,
    override: "auto",
  },
  delivery: {
    radiusKm: 10,
    feeRupees: 40,
    freeAboveRupees: 499,
    etaBands: [
      { maxKm: 2, text: "20–30 minutes" },
      { maxKm: 5, text: "30–45 minutes" },
      { maxKm: 10, text: "45–60 minutes" },
    ],
    serviceablePincodePrefixes: [],
    requireLocation: false,
  },
  inventory: { nearExpiryDays: 90 },
  orders: { reservationMinutes: 15, duplicateWindowMinutes: 120, codEnabled: true, upiEnabled: true },
  consultations: { escalateAfterMinutes: 15 },
  bot: { sessionTimeoutMinutes: 30, uploadRetentionDays: 30 },
  whatsapp: { followUpTemplate: "", templateLanguage: "en" },
};

const KEY = "app";

/** Settings live in one row and are cached; every write goes through `saveSettings`. */
export class SettingsService {
  private cache: Settings | null = null;
  private listeners: ((s: Settings) => void)[] = [];

  constructor(private readonly db: DbOrTx) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, KEY));
    // Merge over the defaults so settings added in a later version get sensible values.
    const merged = deepMerge(DEFAULT_SETTINGS, (row?.value ?? {}) as Partial<Settings>);
    this.cache = SettingsSchema.parse(merged);
    return this.cache;
  }

  async save(next: Settings, userId: number | null): Promise<Settings> {
    const parsed = SettingsSchema.parse(next);
    parsed.delivery.etaBands.sort((a, b) => a.maxKm - b.maxKm);
    await this.db
      .insert(settings)
      .values({ key: KEY, value: parsed, updatedBy: userId })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed, updatedBy: userId, updatedAt: new Date() } });
    this.cache = parsed;
    for (const fn of this.listeners) fn(parsed);
    return parsed;
  }

  onChange(fn: (s: Settings) => void) {
    this.listeners.push(fn);
  }
}

function deepMerge<T>(base: T, over: unknown): T {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (over && typeof over === "object" && !Array.isArray(over)) {
    for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
