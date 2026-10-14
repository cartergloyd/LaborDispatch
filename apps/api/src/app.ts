import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Db } from "@labordispatch/db";
import { DomainError } from "@labordispatch/core";
import type { IntakeConfig } from "@labordispatch/intake-agent";
import type { ApiConfig } from "./config.js";
import { ChatwootClient } from "./chatwoot.js";
import type { IntakeDeps } from "./intake.js";
import { webhookRoutes } from "./routes/webhook.js";
import { chatRoutes } from "./routes/chat.js";
import { recordRoutes } from "./routes/records.js";
import { dispatchRoutes } from "./routes/dispatch.js";
import { demoRoutes } from "./routes/demo.js";

export interface ApiContext {
  db: Db;
  config: ApiConfig;
  chatwoot: ChatwootClient | null;
  intakeDeps: IntakeDeps;
  fetchImpl?: typeof fetch;
}

export interface BuildAppOptions {
  db: Db;
  config: ApiConfig;
  /** Inject a Claude client (tests use a scripted fake). */
  intakeClient?: IntakeConfig["client"];
  fetchImpl?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  await app.register(cors, { origin: true });

  const chatwoot = opts.config.chatwoot
    ? new ChatwootClient({ ...opts.config.chatwoot, fetchImpl: opts.fetchImpl })
    : null;
  const ctx: ApiContext = {
    db: opts.db,
    config: opts.config,
    chatwoot,
    fetchImpl: opts.fetchImpl,
    intakeDeps: {
      db: opts.db,
      config: opts.config,
      intake: {
        client: opts.intakeClient,
        onVerificationCode: async ({ phone, code }) => {
          // TODO: send via the SMS provider. Logged only in demo mode so nothing leaks in prod.
          if (opts.config.demoMode) app.log.info({ phone }, `[DEMO] verification code ${code}`);
        },
      },
    },
  };

  app.setErrorHandler((err: Error & { validation?: unknown }, _req, reply) => {
    if (err instanceof DomainError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: err.message });
    // Drizzle wraps driver errors; the Postgres message is on the cause chain.
    const causeText = [err, (err as { cause?: unknown }).cause, ((err as { cause?: { cause?: unknown } }).cause as { cause?: unknown } | undefined)?.cause]
      .map((e) => (e instanceof Error ? e.message : String(e ?? "")))
      .join(" | ");
    if (/invalid input syntax for type uuid/.test(causeText)) return reply.code(400).send({ error: "malformed id" });
    app.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal error" });
  });

  app.get("/health", async () => ({ ok: true, demoMode: opts.config.demoMode, chatwoot: Boolean(chatwoot) }));

  await app.register(async (i) => webhookRoutes(i, ctx));
  await app.register(async (i) => chatRoutes(i, ctx));
  await app.register(async (i) => recordRoutes(i, ctx));
  await app.register(async (i) => dispatchRoutes(i, ctx));
  if (opts.config.demoMode) {
    app.log.warn("DEMO_MODE is on: /demo/* routes are enabled. Disable before production.");
    await app.register(async (i) => demoRoutes(i, ctx));
  }
  return app;
}
