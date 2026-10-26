import type { Engine } from "../core/engine.ts";
import type { DB } from "../db/client.ts";
import type { PaymentProvider } from "../payments/types.ts";
import type { CatalogueCache } from "../services/catalogue.ts";
import type { EventBus } from "../services/events.ts";
import type { SettingsService } from "../services/settings.ts";

/** Everything the API routes need. Built once in index.ts (and in tests). */
export interface AppContext {
  db: DB;
  engine: Engine;
  catalogue: CatalogueCache;
  settings: SettingsService;
  bus: EventBus;
  payments: PaymentProvider | null;
  uploadsDir: string;
  /** Absolute path of the built dashboard, served at "/". */
  dashboardDir: string | null;
  publicUrl: string;
  cookieSecure: boolean;
  razorpayWebhookSecret: string;
  now?: () => Date;
}
