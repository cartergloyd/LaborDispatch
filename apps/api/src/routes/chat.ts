/**
 * Direct chat API (no Chatwoot): used by the demo harness, tests, and any custom front end.
 * POST /chat/:conversationKey/messages { text, fromPhone? }
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiContext } from "../app.js";
import { runIntake } from "../intake.js";
import { bearerAuth } from "../auth.js";

export async function chatRoutes(app: FastifyInstance, ctx: ApiContext) {
  const Body = z.object({
    text: z.string().min(1).max(4000),
    fromPhone: z.string().optional(),
    channel: z.enum(["sms", "web_chat", "demo", "api"]).default("api"),
    messageId: z.string().optional(),
  });
  app.post<{ Params: { key: string } }>("/chat/:key/messages", { preHandler: bearerAuth(ctx.config.apiToken) }, async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const result = await runIntake(ctx.intakeDeps, {
      channel: body.data.channel,
      externalId: req.params.key,
      externalAccountId: "direct",
      inboundIdentifier: body.data.fromPhone ?? null,
      text: body.data.text,
      messageExternalId: body.data.messageId ?? null,
      isDemo: body.data.channel === "demo",
    });
    return {
      reply: result.reply,
      duplicate: result.duplicate,
      conversationId: result.conversation.id,
      status: result.conversation.status,
      workOrderId: result.conversation.workOrderId,
      usage: result.usage,
    };
  });
}
