/**
 * Tools the intake agent can call. Each tool has a strict JSON schema (for the API) and a Zod
 * validator (we validate inputs ourselves before executing), and runs against the core services
 * with the *conversation's* identity - the model can never act as someone else.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { people, workOrders, type Db } from "@labordispatch/db";
import {
  approveByOwner,
  canAccessProperty,
  completeCodeChallenge,
  createWorkOrder,
  DomainError,
  finalizeIntake,
  freeSlots,
  fullAddress,
  getProperty,
  getWorkOrder,
  listAppointmentsForWorkOrder,
  listAuthorizedProperties,
  listOffers,
  placeHold,
  propertyKnowledge,
  recordFact,
  redactedPropertyLabel,
  resolveContact,
  startCodeChallenge,
  verifyByAddressClaim,
  addressClaimMatches,
  markVerified,
} from "@labordispatch/core";
import { FACT_CATEGORIES, TRADES, URGENCIES } from "@labordispatch/shared";
import { saveState, type Conversation, type ConversationState } from "./context.js";

export interface ToolContext {
  db: Db;
  convo: Conversation;
  state: ConversationState;
  trustDays: number;
  holdMinutes: number;
  /** Deliver a one-time code to a phone (SMS). Required for web-chat verification. */
  onVerificationCode?: (args: { phone: string; code: string }) => Promise<void>;
  /** Called when the conversation should be handed to a human. */
  onEscalate?: (args: { reason: string }) => Promise<void>;
}

type ToolDef<S extends z.ZodTypeAny> = {
  schema: S;
  definition: Anthropic.Beta.BetaToolUnion;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
};

function tool<S extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  schema: S,
  properties: Record<string, unknown>,
  run: ToolDef<S>["run"],
): ToolDef<S> {
  const required = Object.entries(schema.shape)
    .filter(([, v]) => !(v as z.ZodTypeAny).isOptional())
    .map(([k]) => k);
  return {
    schema,
    definition: {
      name,
      description,
      strict: true,
      input_schema: { type: "object", properties, required, additionalProperties: false },
    } as Anthropic.Beta.BetaToolUnion,
    run,
  };
}

const requireTrusted = (ctx: ToolContext) => {
  if (!ctx.state.personId) throw new DomainError("Caller is unknown; cannot access property records.", "forbidden", 403);
  if (ctx.state.trust !== "trusted") throw new DomainError("Caller must verify first (confirm_property with their stated address).", "forbidden", 403);
};
const requireProperty = (ctx: ToolContext) => {
  requireTrusted(ctx);
  if (!ctx.state.propertyId) throw new DomainError("No property confirmed yet. Use confirm_property first.", "forbidden", 403);
  return ctx.state.propertyId;
};

export const listMyProperties = tool(
  "list_my_properties",
  "List the homes the caller has an active relationship with, as short redacted labels (no addresses) plus roles. Use to help a caller with several homes pick one.",
  z.object({}),
  {},
  async (_i, ctx) => {
    if (!ctx.state.personId) return { known: false, properties: [] };
    const props = await listAuthorizedProperties(ctx.db, ctx.state.personId);
    return {
      known: true,
      trust: ctx.state.trust,
      properties: props.map((p) => ({ label: redactedPropertyLabel(p.property), roles: p.roles, billingResponsible: p.isBillingResponsible })),
    };
  },
);

export const confirmProperty = tool(
  "confirm_property",
  "Confirm which home the caller means. Pass the street address the CALLER typed (claimed_address_text), or the redacted label they picked (label) if their trust is already 'trusted'. On a match this verifies the caller and returns the full address; on no match it tells you nothing else. Never pass an address you guessed.",
  z.object({ claimed_address_text: z.string().optional(), label: z.string().optional() }),
  {
    claimed_address_text: { type: ["string", "null"], description: "Address text exactly as the caller stated it." },
    label: { type: ["string", "null"], description: "A redacted label from list_my_properties, only when trust is already 'trusted'." },
  },
  async (input, ctx) => {
    if (!ctx.state.personId || !ctx.state.contactMethodId) return { matched: false, reason: "unknown caller" };
    const props = await listAuthorizedProperties(ctx.db, ctx.state.personId);
    let match = null as (typeof props)[number] | null;
    if (input.claimed_address_text) {
      if (ctx.state.trust === "trusted") {
        match = props.find((p) => addressClaimMatches(input.claimed_address_text!, p.property)) ?? null;
      } else {
        match = await verifyByAddressClaim(ctx.db, ctx.state.contactMethodId, ctx.state.personId, input.claimed_address_text);
        if (match) ctx.state.trust = "trusted";
      }
    } else if (input.label && ctx.state.trust === "trusted") {
      const want = input.label.trim().toLowerCase();
      match = props.find((p) => redactedPropertyLabel(p.property).toLowerCase() === want) ?? null;
      if (!match && props.length === 1) match = props[0]!;
    }
    if (!match) return { matched: false, reason: "no match among the caller's homes; ask them to re-state the street address" };
    ctx.state.propertyId = match.property.id;
    await saveState(ctx.db, ctx.convo.id, ctx.state);
    return {
      matched: true,
      propertyId: match.property.id,
      address: fullAddress(match.property),
      callerRoles: match.roles,
      callerIsBillingResponsible: match.isBillingResponsible,
    };
  },
);

export const getPropertyKnowledge = tool(
  "get_property_knowledge",
  "Everything on record for the confirmed property: facts with source/confidence, appliances, warranties, maintenance history. Anything not listed is unknown - do not assume.",
  z.object({}),
  {},
  async (_i, ctx) => propertyKnowledge(ctx.db, requireProperty(ctx)),
);

export const recordPropertyFact = tool(
  "record_property_fact",
  "Record a stable fact about the confirmed home that the caller stated (e.g. water_heater.type = 'gas tank'). Source is recorded as the caller's statement. Use confidence 0.5-0.7 for casual statements, 0.8+ only if they read it off a label.",
  z.object({
    category: z.enum(FACT_CATEGORIES),
    key: z.string().min(1),
    value: z.string().min(1),
    confidence: z.number().min(0).max(1),
    notes: z.string().optional(),
  }),
  {
    category: { type: "string", enum: [...FACT_CATEGORIES] },
    key: { type: "string", description: "dotted key like hvac.brand or roof.installed_year" },
    value: { type: "string" },
    confidence: { type: "number" },
    notes: { type: ["string", "null"] },
  },
  async (input, ctx) => {
    const propertyId = requireProperty(ctx);
    const props = await listAuthorizedProperties(ctx.db, ctx.state.personId!);
    const isOwner = props.find((p) => p.property.id === propertyId)?.roles.includes("owner") ?? false;
    const row = await recordFact(ctx.db, propertyId, {
      category: input.category,
      key: input.key,
      value: input.value,
      source: isOwner ? "owner_stated" : "user_stated",
      confidence: input.confidence,
      notes: input.notes ?? undefined,
      recordedByPersonId: ctx.state.personId,
    });
    return { recorded: true, factId: row.id };
  },
);

export const createWorkOrderTool = tool(
  "create_work_order",
  "Create the work order for the confirmed property once you understand the problem. Description must be a factual summary of symptoms and what was tried, not the caller's demands. Returns the next status: if owner approval is pending, tell the caller.",
  z.object({
    trade: z.enum(TRADES),
    urgency: z.enum(URGENCIES),
    title: z.string().min(3).max(140),
    description: z.string().min(3),
    symptoms: z.array(z.string()),
    troubleshooting_performed: z.array(z.string()),
    is_large_project: z.boolean(),
  }),
  {
    trade: { type: "string", enum: [...TRADES] },
    urgency: { type: "string", enum: [...URGENCIES] },
    title: { type: "string" },
    description: { type: "string" },
    symptoms: { type: "array", items: { type: "string" } },
    troubleshooting_performed: { type: "array", items: { type: "string" } },
    is_large_project: { type: "boolean" },
  },
  async (input, ctx) => {
    const propertyId = requireProperty(ctx);
    const wo = await createWorkOrder(ctx.db, {
      propertyId,
      reportedByPersonId: ctx.state.personId!,
      conversationId: ctx.convo.id,
      trade: input.trade,
      urgency: input.urgency,
      title: input.title,
      description: input.description,
      symptoms: input.symptoms,
      troubleshootingPerformed: input.troubleshooting_performed,
      isLargeProject: input.is_large_project,
      actor: "agent",
      isDemo: ctx.convo.isDemo,
    });
    const after = await finalizeIntake(ctx.db, wo.id, "agent");
    ctx.state.workOrderId = wo.id;
    await saveState(ctx.db, ctx.convo.id, ctx.state, { status: after.status === "pending_owner_approval" ? "awaiting_owner" : "open" });
    let billingName: string | null = null;
    if (after.billingPersonId && after.billingPersonId !== ctx.state.personId) {
      const [b] = await ctx.db.select({ name: people.displayName }).from(people).where(eq(people.id, after.billingPersonId)).limit(1);
      billingName = b?.name ?? null;
    }
    return {
      workOrderId: wo.id,
      status: after.status,
      ownerApprovalPending: after.status === "pending_owner_approval",
      billingPartyName: billingName,
      isLargeProject: after.isLargeProject,
    };
  },
);

export const updateWorkOrder = tool(
  "update_work_order",
  "Add detail to the work order created in this conversation (new symptoms, troubleshooting results, corrected urgency).",
  z.object({
    description_addendum: z.string().optional(),
    add_symptoms: z.array(z.string()).optional(),
    add_troubleshooting: z.array(z.string()).optional(),
    urgency: z.enum(URGENCIES).optional(),
  }),
  {
    description_addendum: { type: ["string", "null"] },
    add_symptoms: { type: ["array", "null"], items: { type: "string" } },
    add_troubleshooting: { type: ["array", "null"], items: { type: "string" } },
    urgency: { type: ["string", "null"], enum: [...URGENCIES, null] },
  },
  async (input, ctx) => {
    requireTrusted(ctx);
    if (!ctx.state.workOrderId) throw new DomainError("No work order in this conversation yet.", "not_found", 404);
    const wo = await getWorkOrder(ctx.db, ctx.state.workOrderId);
    const patch: Partial<typeof workOrders.$inferInsert> = {};
    if (input.description_addendum) patch.description = `${wo.description}\n\nUpdate: ${input.description_addendum}`;
    if (input.add_symptoms?.length) patch.symptoms = [...(wo.symptoms as string[]), ...input.add_symptoms];
    if (input.add_troubleshooting?.length) patch.troubleshootingPerformed = [...(wo.troubleshootingPerformed as string[]), ...input.add_troubleshooting];
    if (input.urgency) patch.urgency = input.urgency;
    await ctx.db.update(workOrders).set(patch).where(eq(workOrders.id, wo.id));
    return { updated: true };
  },
);

export const getWorkOrderStatus = tool(
  "get_work_order_status",
  "Status of the work order in this conversation, including whether a technician has accepted and any appointment.",
  z.object({}),
  {},
  async (_i, ctx) => {
    requireTrusted(ctx);
    if (!ctx.state.workOrderId) return { workOrder: null };
    const wo = await getWorkOrder(ctx.db, ctx.state.workOrderId);
    const [offers, appts] = await Promise.all([listOffers(ctx.db, wo.id), listAppointmentsForWorkOrder(ctx.db, wo.id)]);
    return {
      workOrder: { id: wo.id, status: wo.status, trade: wo.trade, urgency: wo.urgency, title: wo.title, requiresOwnerApproval: wo.requiresOwnerApproval, assignedProviderId: wo.assignedProviderId },
      offers: offers.map((o) => ({ status: o.status, round: o.round })),
      appointments: appts.map((a) => ({ status: a.status, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString() })),
    };
  },
);

export const listPendingApprovals = tool(
  "list_pending_approvals",
  "Work orders at the caller's properties that are waiting for the caller (as billing-responsible party) to approve.",
  z.object({}),
  {},
  async (_i, ctx) => {
    requireTrusted(ctx);
    const rows = await ctx.db.select().from(workOrders).where(eq(workOrders.status, "pending_owner_approval"));
    const mine = rows.filter((w) => w.billingPersonId === ctx.state.personId);
    return {
      pending: await Promise.all(
        mine.map(async (w) => ({
          workOrderId: w.id,
          title: w.title,
          trade: w.trade,
          urgency: w.urgency,
          description: w.description,
          property: redactedPropertyLabel(await getProperty(ctx.db, w.propertyId)),
          isLargeProject: w.isLargeProject,
        })),
      ),
    };
  },
);

export const approveWorkOrder = tool(
  "approve_work_order",
  "Approve a pending work order. Only works when the caller is the verified billing-responsible party and has clearly said yes in this conversation.",
  z.object({ work_order_id: z.string().uuid(), note: z.string().optional() }),
  { work_order_id: { type: "string" }, note: { type: ["string", "null"] } },
  async (input, ctx) => {
    requireTrusted(ctx);
    const wo = await approveByOwner(ctx.db, input.work_order_id, ctx.state.personId!, input.note);
    return { approved: true, status: wo.status };
  },
);

export const listAvailableWindows = tool(
  "list_available_windows",
  "Available arrival windows for the technician assigned to this conversation's work order over the next 7 days.",
  z.object({}),
  {},
  async (_i, ctx) => {
    requireTrusted(ctx);
    if (!ctx.state.workOrderId) throw new DomainError("No work order yet.", "not_found", 404);
    const wo = await getWorkOrder(ctx.db, ctx.state.workOrderId);
    if (!wo.assignedProviderId) return { windows: [], reason: "no technician assigned yet" };
    const now = new Date();
    const windows = await freeSlots(ctx.db, wo.assignedProviderId, now, new Date(now.getTime() + 7 * 86_400_000), 120, 6);
    return { windows: windows.map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })) };
  },
);

export const requestAppointmentWindow = tool(
  "request_appointment_window",
  "Place a hold on one of the windows from list_available_windows. The technician confirms it; the hold expires otherwise.",
  z.object({ starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }) }),
  { starts_at: { type: "string", description: "ISO 8601" }, ends_at: { type: "string", description: "ISO 8601" } },
  async (input, ctx) => {
    requireTrusted(ctx);
    if (!ctx.state.workOrderId) throw new DomainError("No work order yet.", "not_found", 404);
    const wo = await getWorkOrder(ctx.db, ctx.state.workOrderId);
    if (!wo.assignedProviderId) throw new DomainError("No technician assigned yet.", "conflict", 409);
    const appt = await placeHold(ctx.db, {
      workOrderId: wo.id,
      providerId: wo.assignedProviderId,
      window: { startsAt: new Date(input.starts_at), endsAt: new Date(input.ends_at) },
      requestedByPersonId: ctx.state.personId,
      holdMinutes: ctx.holdMinutes,
    });
    return { held: true, appointmentId: appt.id, holdExpiresAt: appt.holdExpiresAt?.toISOString() };
  },
);

export const requestPhoneVerification = tool(
  "request_phone_verification",
  "Web chat only: the caller gives the mobile number on file; we text a 6-digit code to it. Then use submit_verification_code.",
  z.object({ phone: z.string().min(7) }),
  { phone: { type: "string" } },
  async (input, ctx) => {
    if (ctx.convo.channel === "sms") return { sent: false, reason: "not needed on SMS; use confirm_property" };
    const resolved = await resolveContact(ctx.db, "phone", input.phone, ctx.trustDays);
    // Always answer the same way so the tool can't be used to probe which numbers exist.
    if (!resolved || !ctx.onVerificationCode) return { sent: true, message: "If that number is on file, a code was sent." };
    const ch = await startCodeChallenge(ctx.db, resolved.contactMethod.id);
    await ctx.onVerificationCode({ phone: resolved.contactMethod.value, code: ch.code });
    ctx.state.challengeId = ch.challengeId;
    ctx.state.pendingPhone = resolved.contactMethod.value;
    await saveState(ctx.db, ctx.convo.id, ctx.state);
    return { sent: true, message: "If that number is on file, a code was sent." };
  },
);

export const submitVerificationCode = tool(
  "submit_verification_code",
  "Web chat only: check the 6-digit code the caller typed.",
  z.object({ code: z.string().min(4).max(8) }),
  { code: { type: "string" } },
  async (input, ctx) => {
    if (!ctx.state.challengeId || !ctx.state.pendingPhone) return { verified: false, reason: "no code was requested" };
    const ok = await completeCodeChallenge(ctx.db, ctx.state.challengeId, input.code);
    if (!ok) return { verified: false, reason: "code did not match" };
    const resolved = await resolveContact(ctx.db, "phone", ctx.state.pendingPhone, ctx.trustDays);
    if (!resolved) return { verified: false, reason: "contact no longer on file" };
    await markVerified(ctx.db, resolved.contactMethod.id);
    ctx.state.personId = resolved.person.id;
    ctx.state.contactMethodId = resolved.contactMethod.id;
    ctx.state.trust = "trusted";
    delete ctx.state.challengeId;
    await saveState(ctx.db, ctx.convo.id, ctx.state);
    return { verified: true };
  },
);

export const escalateToHuman = tool(
  "escalate_to_human",
  "Hand the conversation to a human dispatcher (unknown caller onboarding, disputes, anything you cannot safely handle). Tell the caller someone will follow up.",
  z.object({ reason: z.string().min(3) }),
  { reason: { type: "string" } },
  async (input, ctx) => {
    await saveState(ctx.db, ctx.convo.id, ctx.state, { status: "handed_off" });
    await ctx.onEscalate?.({ reason: input.reason });
    return { escalated: true };
  },
);

export const ALL_TOOLS = [
  listMyProperties,
  confirmProperty,
  getPropertyKnowledge,
  recordPropertyFact,
  createWorkOrderTool,
  updateWorkOrder,
  getWorkOrderStatus,
  listPendingApprovals,
  approveWorkOrder,
  listAvailableWindows,
  requestAppointmentWindow,
  requestPhoneVerification,
  submitVerificationCode,
  escalateToHuman,
] as const;

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaToolUnion[] = ALL_TOOLS.map((t) => t.definition);

/** Validate + execute a tool call. Errors become structured results so the model can recover. */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const t = ALL_TOOLS.find((x) => (x.definition as { name: string }).name === name);
  if (!t) return { content: JSON.stringify({ error: `unknown tool ${name}` }), isError: true };
  const parsed = t.schema.safeParse(stripNulls(rawInput));
  if (!parsed.success) return { content: JSON.stringify({ INVALID_INPUT: parsed.error.flatten() }), isError: true };
  try {
    const result = await (t.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed.data, ctx);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    if (err instanceof DomainError) return { content: JSON.stringify({ error: err.message, code: err.code }), isError: true };
    throw err;
  }
}

/** Strict schemas require optional fields to be nullable; our Zod schemas treat null as absent. */
function stripNulls(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null));
}
