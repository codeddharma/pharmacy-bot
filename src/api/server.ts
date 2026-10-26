import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.ts";
import type { AppContext } from "./context.ts";
import { HttpError } from "./http.ts";
import { adminRoutes } from "./routes/admin.ts";
import { catalogueRoutes } from "./routes/catalogue.ts";
import { conversationRoutes } from "./routes/conversations.ts";
import { orderRoutes } from "./routes/orders.ts";
import { peopleRoutes } from "./routes/people.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

/**
 * One server for everything: the dashboard (static files at /), its API (/api/*) and the
 * webhooks from Telegram, WhatsApp and Razorpay (/webhooks/*). One origin keeps login
 * cookies simple and needs a single Nginx site.
 */
export async function buildServer(ctx: AppContext, extra?: (app: FastifyInstance) => void): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  // Only JSON is accepted, which also blocks cross-site form posts (CSRF).
  app.removeContentTypeParser("text/plain");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      done(new HttpError(400, "Invalid JSON"), undefined);
    }
  });

  await app.register(cookie);
  registerAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    console.error(`[api] ${req.method} ${req.url}:`, err);
    return reply.status(500).send({ error: "Something went wrong. Please try again." });
  });

  app.get("/api/health", async () => ({ ok: true }));
  catalogueRoutes(app, ctx);
  orderRoutes(app, ctx);
  peopleRoutes(app, ctx);
  conversationRoutes(app, ctx);
  adminRoutes(app, ctx);
  webhookRoutes(app, ctx);
  extra?.(app);

  if (ctx.dashboardDir && existsSync(path.join(ctx.dashboardDir, "index.html"))) {
    // Built assets have content hashes in their names, so they can be cached for good;
    // index.html must always be fresh so a new deploy shows up on the next page load.
    await app.register(fastifyStatic, {
      root: ctx.dashboardDir,
      // Look files up on each request, so a rebuilt dashboard is served without a restart.
      wildcard: true,
      setHeaders: (reply, file) => {
        reply.header("cache-control", file.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable");
      },
    });
    // Single-page app: any other non-API path serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/webhooks/") || req.method !== "GET") {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "Not found" }));
  }

  return app;
}
