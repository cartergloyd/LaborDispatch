import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createDb, runMigrations, seed, workOrders, type DbHandle } from "@labordispatch/db";
import { eq } from "drizzle-orm";
import { executeTool, findOrCreateConversation, handleInboundMessage, type ToolContext } from "../src/index.js";
import { refreshIdentity } from "../src/context.js";

let h: DbHandle;
let s: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => {
  h = await createDb({ pgliteDir: "memory://" });
  await runMigrations(h);
  s = await seed(h.db);
});
afterAll(() => h.close());

function fakeClient(script: Array<Partial<Anthropic.Beta.BetaMessage> & { content: Anthropic.Beta.BetaContentBlock[] }>) {
  const calls: Anthropic.Beta.MessageCreateParams[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParams) => {
          calls.push({ ...params, messages: [...params.messages] });
          const step = script[i++];
          if (!step) throw new Error("script exhausted");
          return {
            id: `msg_${i}`,
            type: "message",
            role: "assistant",
            model: "fake",
            stop_reason: step.stop_reason ?? "end_turn",
            stop_sequence: null,
            stop_details: null,
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            ...step,
          } as Anthropic.Beta.BetaMessage;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const text = (t: string): Anthropic.Beta.BetaContentBlock => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;
const toolUse = (name: string, input: object, id = "tu_1"): Anthropic.Beta.BetaContentBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaToolUseBlock;

async function ctxFor(phone: string, channel: "sms" | "web_chat" = "sms"): Promise<ToolContext> {
  const convo = await findOrCreateConversation(h.db, { channel, externalId: `t-${phone}-${Math.random()}`, inboundIdentifier: phone, isDemo: true });
  const state = await refreshIdentity(h.db, convo, 90);
  return { db: h.db, convo, state, trustDays: 90, holdMinutes: 15 };
}

describe("tools enforce identity rules", () => {
  it("unknown caller gets nothing", async () => {
    const ctx = await ctxFor("+15555559999");
    expect(ctx.state.trust).toBe("unknown");
    const r = await executeTool("get_property_knowledge", {}, ctx);
    expect(r.isError).toBe(true);
    const list = JSON.parse((await executeTool("list_my_properties", {}, ctx)).content);
    expect(list).toEqual({ known: false, properties: [] });
  });

  it("stale caller must verify via address claim; wrong claim discloses nothing", async () => {
    const ctx = await ctxFor("+15555550103"); // Pat, verified 400 days ago
    expect(ctx.state.trust).toBe("needs_verification");
    const list = JSON.parse((await executeTool("list_my_properties", {}, ctx)).content);
    expect(list.properties.map((p: { label: string }) => p.label)).toContain("the lake cabin");
    expect(JSON.stringify(list)).not.toContain("Lakeshore");
    const miss = JSON.parse((await executeTool("confirm_property", { claimed_address_text: "99 Nowhere St", label: null }, ctx)).content);
    expect(miss.matched).toBe(false);
    expect(ctx.state.propertyId).toBeUndefined();
    const hit = JSON.parse((await executeTool("confirm_property", { claimed_address_text: "7 Lakeshore Trail", label: null }, ctx)).content);
    expect(hit.matched).toBe(true);
    expect(hit.address).toContain("Shell Knob");
    expect(ctx.state.trust).toBe("trusted");
    const know = JSON.parse((await executeTool("get_property_knowledge", {}, ctx)).content);
    expect(know).toHaveProperty("facts");
    expect(JSON.stringify(know)).not.toContain("keypad"); // access notes never exposed
  });

  it("tenant work order requires owner approval and names the billing party", async () => {
    const ctx = await ctxFor("+15555550102"); // Logan
    expect(ctx.state.trust).toBe("trusted");
    const c = JSON.parse((await executeTool("confirm_property", { claimed_address_text: "2208 Maple Ct", label: null }, ctx)).content);
    expect(c.callerIsBillingResponsible).toBe(false);
    const wo = JSON.parse(
      (
        await executeTool(
          "create_work_order",
          {
            trade: "plumbing",
            urgency: "routine",
            title: "No hot water",
            description: "No hot water since yesterday. Pilot light is out; relighting did not hold.",
            symptoms: ["no hot water"],
            troubleshooting_performed: ["relit pilot, went out again"],
            is_large_project: false,
          },
          ctx,
        )
      ).content,
    );
    expect(wo.ownerApprovalPending).toBe(true);
    expect(wo.billingPartyName).toBe("Alex Owner");
    // Logan cannot approve
    const deny = await executeTool("approve_work_order", { work_order_id: wo.workOrderId, note: null }, ctx);
    expect(deny.isError).toBe(true);
    // Alex can
    const alex = await ctxFor("+15555550101");
    const pending = JSON.parse((await executeTool("list_pending_approvals", {}, alex)).content);
    expect(pending.pending.some((p: { workOrderId: string }) => p.workOrderId === wo.workOrderId)).toBe(true);
    const ok = JSON.parse((await executeTool("approve_work_order", { work_order_id: wo.workOrderId, note: "ok" }, alex)).content);
    expect(ok.status).toBe("ready_to_dispatch");
  });

  it("rejects invalid tool input without executing", async () => {
    const ctx = await ctxFor("+15555550101");
    const r = await executeTool("create_work_order", { trade: "magic" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("INVALID_INPUT");
  });
});

describe("engine loop", () => {
  it("runs tool calls, persists history, injects caller context as a system message", async () => {
    const convo = await findOrCreateConversation(h.db, { channel: "sms", externalId: "cw-1", externalAccountId: "1", inboundIdentifier: "+15555550101", isDemo: true });
    const { client, calls } = fakeClient([
      { stop_reason: "tool_use", content: [text("Let me confirm that."), toolUse("confirm_property", { claimed_address_text: "11483 Essex Ave", label: null })] },
      { stop_reason: "tool_use", content: [toolUse("create_work_order", { trade: "hvac", urgency: "urgent", title: "Furnace short cycling", description: "Runs 2 min then stops; filter replaced.", symptoms: ["short cycling"], troubleshooting_performed: ["replaced filter"], is_large_project: false }, "tu_2")] },
      { stop_reason: "end_turn", content: [text("Got it. An HVAC tech will be dispatched; I'll text you windows soon.")] },
    ]);
    const res = await handleInboundMessage(h.db, { conversationId: convo.id, text: "my furnace at 11483 Essex Ave keeps turning off", externalId: "m1" }, { client, trustDays: 90, holdMinutes: 15 });
    expect(res.reply).toContain("HVAC tech");
    expect(calls).toHaveLength(3);
    const first = calls[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
    const msgs = first.messages;
    expect(msgs.at(-2)?.role).toBe("user");
    expect(msgs.at(-1)?.role).toBe("system");
    expect(String(msgs.at(-1)?.content)).toContain("trust: trusted");
    // third call carries the tool_result for the second tool call
    const last = calls[2]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("tu_2");
    const [wo] = await h.db.select().from(workOrders).where(eq(workOrders.conversationId, convo.id));
    expect(wo?.status).toBe("ready_to_dispatch");
    expect(res.conversation.workOrderId).toBe(wo!.id);

    // duplicate delivery is ignored
    const dup = await handleInboundMessage(h.db, { conversationId: convo.id, text: "again", externalId: "m1" }, { client, trustDays: 90, holdMinutes: 15 });
    expect(dup.duplicate).toBe(true);
  });

  it("refusal yields a safe reply and hands off", async () => {
    const convo = await findOrCreateConversation(h.db, { channel: "sms", externalId: "cw-2", externalAccountId: "1", inboundIdentifier: "+15555550199", isDemo: true });
    const { client } = fakeClient([{ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: null } as never, content: [] }]);
    let escalated = "";
    const res = await handleInboundMessage(h.db, { conversationId: convo.id, text: "..." }, { client, trustDays: 90, holdMinutes: 15, onEscalate: async ({ reason }) => void (escalated = reason) });
    expect(res.reply).toMatch(/team will follow up/);
    expect(res.conversation.status).toBe("handed_off");
    expect(escalated).toContain("refusal");
  });
});
