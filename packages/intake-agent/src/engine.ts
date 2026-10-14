/**
 * The intake conversation engine.
 *
 * One call = one inbound message -> (Claude + tools loop) -> one outbound reply.
 * History is stored as full content blocks and replayed append-only (thinking blocks included),
 * so it stays valid under preserved-thinking checks. Caller context is injected as a
 * mid-conversation system message, never mixed into the texter's words.
 */
import Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { messages, type Db } from "@labordispatch/db";
import { getConversation, hasMessageWithExternalId, refreshIdentity, renderCallerContext, saveState, type Conversation } from "./context.js";
import { INTAKE_SYSTEM_PROMPT } from "./prompt.js";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

export interface IntakeConfig {
  model?: string;
  effort?: "low" | "medium" | "high";
  trustDays: number;
  holdMinutes: number;
  maxToolIterations?: number;
  client?: Anthropic;
  onVerificationCode?: ToolContext["onVerificationCode"];
  onEscalate?: ToolContext["onEscalate"];
}

export interface InboundMessage {
  conversationId: string;
  text: string;
  /** Provider message id for idempotency (e.g. Chatwoot message id). */
  externalId?: string | null;
}

export interface IntakeResult {
  reply: string | null;
  conversation: Conversation;
  duplicate: boolean;
  usage?: { input: number; output: number; cacheRead: number };
}

const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";
const SAFE_REPLY = "I'm not able to help with that here. A member of our team will follow up with you shortly.";

type Msg = Anthropic.Beta.BetaMessageParam;

async function loadHistory(db: Db, conversationId: string): Promise<Msg[]> {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  const out: Msg[] = [];
  for (const r of rows) {
    if (r.llmContent) out.push(r.llmContent as Msg);
    else if (r.direction === "inbound") out.push({ role: "user", content: r.body });
    else if (r.direction === "outbound") out.push({ role: "assistant", content: r.body });
  }
  return out;
}

async function persist(db: Db, conversationId: string, direction: "inbound" | "outbound" | "system", body: string, llmContent: Msg, externalId?: string | null) {
  await db.insert(messages).values({ conversationId, direction, body, llmContent, externalId: externalId ?? null });
}

function textOf(content: Anthropic.Beta.BetaContentBlock[] | Anthropic.Beta.BetaContentBlockParam[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n");
}

export async function handleInboundMessage(db: Db, inbound: InboundMessage, config: IntakeConfig): Promise<IntakeResult> {
  const client = config.client ?? new Anthropic();
  let convo = await getConversation(db, inbound.conversationId);

  if (inbound.externalId && (await hasMessageWithExternalId(db, convo.id, inbound.externalId))) {
    return { reply: null, conversation: convo, duplicate: true };
  }
  if (convo.status === "handed_off" || convo.status === "closed") {
    await persist(db, convo.id, "inbound", inbound.text, { role: "user", content: inbound.text }, inbound.externalId);
    return { reply: null, conversation: convo, duplicate: false };
  }

  const state = await refreshIdentity(db, convo, config.trustDays);
  await saveState(db, convo.id, state);
  const ctx: ToolContext = {
    db,
    convo,
    state,
    trustDays: config.trustDays,
    holdMinutes: config.holdMinutes,
    onVerificationCode: config.onVerificationCode,
    onEscalate: config.onEscalate,
  };

  const history = await loadHistory(db, convo.id);
  const userMsg: Msg = { role: "user", content: inbound.text };
  const contextMsg: Msg = { role: "system" as Msg["role"], content: await renderCallerContext(db, convo, state) };
  await persist(db, convo.id, "inbound", inbound.text, userMsg, inbound.externalId);
  await persist(db, convo.id, "system", "caller_context", contextMsg);
  const convoMessages: Msg[] = [...history, userMsg, contextMsg];

  let reply: string | null = null;
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const maxIter = config.maxToolIterations ?? 8;

  for (let i = 0; i < maxIter; i++) {
    const response = await client.beta.messages.create({
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: FALLBACK_MODEL }],
      output_config: { effort: config.effort ?? "medium" },
      system: [{ type: "text", text: INTAKE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOL_DEFINITIONS,
      messages: convoMessages,
    });
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;

    const assistantMsg: Msg = { role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] };
    convoMessages.push(assistantMsg);
    const text = textOf(response.content);
    await persist(db, convo.id, "outbound", text || `[${response.stop_reason}]`, assistantMsg);

    if (response.stop_reason === "refusal") {
      reply = SAFE_REPLY;
      await ctx.onEscalate?.({ reason: `model refusal: ${response.stop_details?.category ?? "unspecified"}` });
      await saveState(db, convo.id, ctx.state, { status: "handed_off" });
      break;
    }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "max_tokens") {
      reply = text || "Sorry, could you say that again in a few words?";
      break;
    }
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      reply = text || null;
      break;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const r = await executeTool(tu.name, tu.input, ctx);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, is_error: r.isError });
    }
    const resultMsg: Msg = { role: "user", content: results };
    convoMessages.push(resultMsg);
    await persist(db, convo.id, "system", "tool_results", resultMsg);
  }

  if (reply === null) reply = "Thanks, I have what I need for now and will follow up shortly.";
  convo = await getConversation(db, convo.id);
  if (convo.status === "open") await saveState(db, convo.id, ctx.state, { status: "awaiting_user" });
  convo = await getConversation(db, convo.id);
  return { reply, conversation: convo, duplicate: false, usage };
}
