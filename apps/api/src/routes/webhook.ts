/**
 * Chatwoot -> LaborDispatch. Chatwoot posts every event; we act on incoming, non-private messages.
 * Authenticity: the webhook URL carries ?token=<CHATWOOT_WEBHOOK_TOKEN>.
 */
import type { FastifyInstance } from "fastify";
import { ChatwootWebhook } from "@labordispatch/shared";
import type { ApiContext } from "../app.js";
import { runIntake } from "../intake.js";

export async function webhookRoutes(app: FastifyInstance, ctx: ApiContext) {
  app.post<{ Querystring: { token?: string } }>("/webhooks/chatwoot", async (req, reply) => {
    const cw = ctx.config.chatwoot;
    if (!cw) return reply.code(503).send({ error: "Chatwoot not configured" });
    if (!cw.webhookToken || req.query.token !== cw.webhookToken) return reply.code(401).send({ error: "bad token" });

    const parsed = ChatwootWebhook.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "unrecognized payload" });
    const ev = parsed.data;
    if (ev.event !== "message_created") return { ignored: ev.event };
    if (ev.message_type !== "incoming" && ev.message_type !== 0) return { ignored: "not incoming" };
    if (ev.private) return { ignored: "private" };
    const content = (ev.content ?? "").trim();
    if (!content) return { ignored: "empty" };

    const conversationId = String(ev.conversation?.id ?? ev.conversation?.display_id ?? "");
    if (!conversationId) return reply.code(400).send({ error: "no conversation id" });
    const accountId = String(ev.account?.id ?? cw.accountId);
    const sender = ev.conversation?.meta?.sender ?? ev.sender ?? ev.contact;
    const phone = sender?.phone_number ?? null;
    const channelName = String(ev.conversation?.channel ?? "").toLowerCase();
    const isSms = Boolean(phone) && (channelName.includes("sms") || channelName.includes("twilio") || channelName.includes("whatsapp") || channelName === "");
    const channel = isSms ? "sms" : "web_chat";

    // Respond to Chatwoot immediately; do the LLM work after the reply is flushed.
    reply.send({ accepted: true });
    void (async () => {
      try {
        const result = await runIntake(ctx.intakeDeps, {
          channel,
          externalId: conversationId,
          externalAccountId: accountId,
          inboundIdentifier: phone ?? sender?.identifier ?? null,
          text: content,
          messageExternalId: ev.id !== undefined ? String(ev.id) : null,
          onEscalate: async ({ reason }) => ctx.chatwoot?.handoff(conversationId, reason),
        });
        if (result.reply && !result.duplicate) await ctx.chatwoot?.sendMessage(conversationId, result.reply);
      } catch (err) {
        app.log.error({ err }, "intake failed");
        await ctx.chatwoot?.handoff(conversationId, `intake error: ${String(err)}`).catch(() => undefined);
      }
    })();
    return reply;
  });
}
