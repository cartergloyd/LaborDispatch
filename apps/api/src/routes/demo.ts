// DEMO ONLY - remove before production (delete this file and its registration in app.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { demoScenarios, providers } from "@labordispatch/db";
import { generateScenario, listScenarioTemplates, recordOutcome, recordScenario, type DemoScenario } from "@labordispatch/demo";
import { DEMO_TAG } from "@labordispatch/shared";
import type { ApiContext } from "../app.js";
import { bearerAuth } from "../auth.js";
import { runIntake } from "../intake.js";

export async function demoRoutes(app: FastifyInstance, ctx: ApiContext) {
  app.addHook("preHandler", bearerAuth(ctx.config.apiToken));
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-labordispatch-demo", DEMO_TAG);
  });
  const db = ctx.db;

  app.get("/demo/scenarios/templates", async () => listScenarioTemplates());
  app.get<{ Querystring: { seed?: string } }>("/demo/scenarios/generate", async (req) => generateScenario(req.query.seed ? Number(req.query.seed) : undefined));

  /** Record a scenario (from the CLI) and optionally run its opening message through intake. */
  app.post("/demo/scenarios", async (req, reply) => {
    const body = z.object({ scenario: z.custom<DemoScenario>((v) => typeof v === "object" && v !== null), run: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const row = await recordScenario(db, body.data.scenario, {});
    if (!body.data.run) return reply.code(201).send(row);
    const result = await runScenario(row.id, body.data.scenario);
    return reply.code(201).send({ scenario: row, result });
  });

  app.post<{ Params: { id: string } }>("/demo/scenarios/:id/run", async (req, reply) => {
    const [row] = await db.select().from(demoScenarios).where(eq(demoScenarios.id, req.params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "scenario not found" });
    return runScenario(row.id, row.scenario as DemoScenario);
  });

  app.get("/demo/scenarios", async () => db.select().from(demoScenarios));

  /** Point demo providers at the fake receivers server. */
  app.post("/demo/providers/wire-receivers", async (req) => {
    const body = z.object({ receiversUrl: z.string().url() }).parse(req.body);
    const rows = await db
      .update(providers)
      .set({ offerWebhookUrl: `${body.receiversUrl.replace(/\/$/, "")}/demo/receive-offer` })
      .where(eq(providers.isDemo, true))
      .returning();
    return rows;
  });

  async function runScenario(scenarioId: string, scenario: DemoScenario) {
    const key = `demo-${scenarioId}`;
    const transcript: { from: "user" | "bot"; text: string }[] = [];
    let last: Awaited<ReturnType<typeof runIntake>> | null = null;
    for (const text of [scenario.openingMessage, ...scenario.followUps]) {
      transcript.push({ from: "user", text });
      last = await runIntake(ctx.intakeDeps, { channel: "demo", externalId: key, externalAccountId: "demo", inboundIdentifier: scenario.fromPhone, text, isDemo: true });
      transcript.push({ from: "bot", text: last.reply ?? "" });
      if (last.conversation.status === "handed_off") break;
    }
    const outcome = {
      variant: scenario.variant,
      transcript,
      conversationId: last?.conversation.id ?? null,
      workOrderId: last?.conversation.workOrderId ?? null,
      conversationStatus: last?.conversation.status ?? null,
      expected: scenario.expected,
      usage: last?.usage ?? null,
    };
    await recordOutcome(db, scenarioId, outcome);
    await db.update(demoScenarios).set({ conversationId: outcome.conversationId, workOrderId: outcome.workOrderId }).where(eq(demoScenarios.id, scenarioId));
    return outcome;
  }
}
