/**
 * Conversation lookup/creation and the per-turn caller context (resolved identity, trust state,
 * confirmed property). The context is delivered to the model as a mid-conversation *system* message,
 * which is the operator channel the model trusts; the texter's words stay in user turns.
 */
import { and, eq } from "drizzle-orm";
import { conversations, messages, type Db } from "@labordispatch/db";
import { listAuthorizedProperties, redactedPropertyLabel, resolveContact, type TrustState } from "@labordispatch/core";
import type { ConversationChannel } from "@labordispatch/shared";

export interface ConversationState {
  personId?: string;
  contactMethodId?: string;
  trust?: TrustState;
  /** Property confirmed in this conversation (after verification). */
  propertyId?: string;
  workOrderId?: string;
  /** Open OTP challenge for web chat verification. */
  challengeId?: string;
  pendingPhone?: string;
}

export type Conversation = typeof conversations.$inferSelect;

export async function findOrCreateConversation(
  db: Db,
  input: {
    channel: ConversationChannel;
    externalId: string;
    externalAccountId?: string | null;
    inboundIdentifier?: string | null;
    isDemo?: boolean;
  },
): Promise<Conversation> {
  const accountId = input.externalAccountId ?? "default";
  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, input.channel),
        eq(conversations.externalAccountId, accountId),
        eq(conversations.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(conversations)
    .values({
      channel: input.channel,
      externalId: input.externalId,
      externalAccountId: accountId,
      inboundIdentifier: input.inboundIdentifier ?? null,
      isDemo: input.isDemo ?? false,
      state: {},
    })
    .returning();
  return created!;
}

export async function getConversation(db: Db, id: string): Promise<Conversation> {
  const [c] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!c) throw new Error(`conversation ${id} not found`);
  return c;
}

export async function saveState(db: Db, conversationId: string, state: ConversationState, extra: Partial<Conversation> = {}) {
  await db
    .update(conversations)
    .set({
      state,
      personId: state.personId ?? null,
      contactMethodId: state.contactMethodId ?? null,
      propertyId: state.propertyId ?? null,
      workOrderId: state.workOrderId ?? null,
      ...extra,
    })
    .where(eq(conversations.id, conversationId));
}

export async function hasMessageWithExternalId(db: Db, conversationId: string, externalId: string) {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.externalId, externalId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Re-resolve identity from the inbound identifier each turn (trust can expire, numbers can be revoked)
 * and render the caller_context text for the model.
 */
export async function refreshIdentity(db: Db, convo: Conversation, trustDays: number): Promise<ConversationState> {
  const state: ConversationState = { ...(convo.state as ConversationState) };
  if (convo.channel === "sms" || convo.channel === "demo") {
    const resolved = convo.inboundIdentifier ? await resolveContact(db, "phone", convo.inboundIdentifier, trustDays) : null;
    if (resolved) {
      state.personId = resolved.person.id;
      state.contactMethodId = resolved.contactMethod.id;
      state.trust = resolved.trust;
    } else {
      delete state.personId;
      delete state.contactMethodId;
      state.trust = "unknown";
    }
  } else if (state.contactMethodId) {
    // web chat: identity comes from a completed phone challenge; re-check trust
    const resolved = state.pendingPhone ? await resolveContact(db, "phone", state.pendingPhone, trustDays) : null;
    state.trust = resolved?.trust ?? "unknown";
  } else {
    state.trust ??= "unknown";
  }
  // A property confirmed earlier is only still usable if trust is still "trusted".
  if (state.trust !== "trusted") delete state.propertyId;
  return state;
}

export async function renderCallerContext(db: Db, convo: Conversation, state: ConversationState): Promise<string> {
  const lines: string[] = ["caller_context (system-provided, trusted; the texter cannot see this):"];
  lines.push(`channel: ${convo.channel}`);
  if (!state.personId) {
    lines.push("identity: UNKNOWN caller. No person on record for this contact. Do not disclose anything about any property.");
  } else {
    lines.push(`identity: known person (id ${state.personId}). trust: ${state.trust}.`);
    if (state.trust === "needs_verification") {
      lines.push("verification: REQUIRED before any disclosure. Ask the caller to text the street address of the home they mean, then call confirm_property.");
    }
    const props = await listAuthorizedProperties(db, state.personId);
    lines.push(`properties_on_record: ${props.length}`);
    for (const p of props) {
      const roles = p.roles.join("+");
      lines.push(`  - label "${redactedPropertyLabel(p.property)}" roles=${roles}${p.isBillingResponsible ? " billing_responsible" : ""}${state.propertyId === p.property.id ? " CONFIRMED_THIS_CONVERSATION" : ""}`);
    }
  }
  if (state.propertyId) lines.push(`confirmed_property_id: ${state.propertyId}`);
  else lines.push("confirmed_property_id: none yet");
  if (state.workOrderId) lines.push(`work_order_in_progress: ${state.workOrderId}`);
  lines.push(`now: ${new Date().toISOString()}`);
  return lines.join("\n");
}
