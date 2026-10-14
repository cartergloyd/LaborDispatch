/**
 * MCP tool definitions for LaborDispatch.
 *
 * Each tool is implemented as a plain async handler `(db, args) => ToolResult` so it can be unit
 * tested without a transport, plus `registerTools(server, db)` which wires them into an McpServer.
 *
 * Data-exposure rules for external agents (see README "Pre-Dispatch Notes"):
 *  - Providers are identified by id only. Phone/email/contact names are never returned.
 *  - Work-order responses never include property access notes or any person contact details.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { estimates, providers, type Db } from "@labordispatch/db";
import {
  createWorkOrder,
  DomainError,
  finalizeIntake,
  freeSlots,
  getWorkOrder,
  listAppointmentsForWorkOrder,
  listEvents,
  listOffers,
  placeHold,
  runDispatchRound,
} from "@labordispatch/core";
import { envInt, TRADES, WorkOrderCreateInput } from "@labordispatch/shared";

// ---------- result helpers ----------

/** Subset of the SDK's CallToolResult (which is a passthrough object, hence the index signature). */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Run a handler; DomainErrors become tool errors, anything else propagates to the SDK. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) return fail(`${err.code}: ${err.message}`);
    throw err;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------- input schemas ----------

export const SearchContractorsInput = z.object({
  postalCode: z.string().min(3).max(12).describe("Postal / ZIP code of the property needing service"),
  trade: z.enum(TRADES).describe("Trade required for the job"),
  emergency: z.boolean().optional().describe("If true, only providers that accept emergency calls are returned"),
});

export const GetAvailabilityInput = z.object({
  providerId: z.string().uuid(),
  fromIso: z.string().datetime({ offset: true }).optional().describe("Start of the search range (ISO 8601). Default: now"),
  toIso: z.string().datetime({ offset: true }).optional().describe("End of the search range (ISO 8601). Default: 7 days from now"),
  slotMinutes: z.number().int().min(30).max(480).optional().describe("Slot length in minutes. Default 120"),
});

/** Same fields as the HTTP intake API, minus conversationId (chat-channel internal). */
export const RequestServiceInput = WorkOrderCreateInput.omit({ conversationId: true });

export const DispatchWorkOrderInput = z.object({
  workOrderId: z.string().uuid(),
});

export const RequestBookingInput = z.object({
  workOrderId: z.string().uuid(),
  providerId: z.string().uuid(),
  startsAtIso: z.string().datetime({ offset: true }).describe("Requested window start (ISO 8601)"),
  endsAtIso: z.string().datetime({ offset: true }).describe("Requested window end (ISO 8601)"),
  requestedByPersonId: z.string().uuid().optional().describe("Person id of the requester, if known"),
});

export const WorkOrderIdInput = z.object({
  workOrderId: z.string().uuid(),
});

// ---------- handlers ----------

export async function searchContractors(db: Db, args: z.infer<typeof SearchContractorsInput>): Promise<ToolResult> {
  return guarded(async () => {
    const all = await db.select().from(providers).where(eq(providers.status, "active"));
    const now = Date.now();
    const matches = all
      .filter((p) => p.trades.includes(args.trade) || p.trades.includes("general_handyman"))
      .filter((p) => p.servicePostalCodes.includes(args.postalCode))
      .filter((p) => !(p.licenseExpiresAt && p.licenseExpiresAt.getTime() <= now))
      .filter((p) => !(p.insuranceExpiresAt && p.insuranceExpiresAt.getTime() <= now))
      .filter((p) => !args.emergency || p.acceptsEmergencies)
      .map((p) => ({
        providerId: p.id,
        businessName: p.businessName,
        trades: p.trades,
        exactTradeMatch: p.trades.includes(args.trade),
        rating: p.rating === null ? null : Number(p.rating),
        jobsCompleted: p.jobsCompleted,
        acceptsEmergencies: p.acceptsEmergencies,
        licenseVerified: p.licenseVerifiedAt !== null,
        insuranceVerified: p.insuranceVerifiedAt !== null,
        isDemo: p.isDemo,
      }))
      .sort((a, b) => Number(b.exactTradeMatch) - Number(a.exactTradeMatch) || (b.rating ?? 0) - (a.rating ?? 0));
    return ok({
      postalCode: args.postalCode,
      trade: args.trade,
      emergency: args.emergency ?? false,
      count: matches.length,
      providers: matches,
    });
  });
}

export async function getAvailability(db: Db, args: z.infer<typeof GetAvailabilityInput>): Promise<ToolResult> {
  return guarded(async () => {
    const from = args.fromIso ? new Date(args.fromIso) : new Date();
    const to = args.toIso ? new Date(args.toIso) : new Date(from.getTime() + 7 * 24 * 60 * 60_000);
    if (to <= from) return fail("validation: toIso must be after fromIso");
    const slotMinutes = args.slotMinutes ?? 120;
    const [prov] = await db.select({ id: providers.id }).from(providers).where(eq(providers.id, args.providerId)).limit(1);
    if (!prov) return fail("not_found: provider not found");
    const slots = await freeSlots(db, args.providerId, from, to, slotMinutes, 8);
    return ok({
      providerId: args.providerId,
      from: from.toISOString(),
      to: to.toISOString(),
      slotMinutes,
      slots: slots.map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
    });
  });
}

export async function requestService(db: Db, args: z.infer<typeof RequestServiceInput>): Promise<ToolResult> {
  return guarded(async () => {
    const created = await createWorkOrder(db, { ...args, actor: "mcp" });
    const wo = await finalizeIntake(db, created.id, "mcp");
    const ownerApprovalPending = wo.status === "pending_owner_approval";
    return ok({
      workOrderId: wo.id,
      status: wo.status,
      trade: wo.trade,
      urgency: wo.urgency,
      requiresOwnerApproval: wo.requiresOwnerApproval,
      ownerApprovalPending,
      nextStep: ownerApprovalPending
        ? "The billing-responsible owner must approve before this can be dispatched."
        : wo.status === "ready_to_dispatch"
          ? "Call dispatch_work_order to offer this job to qualified providers."
          : `Work order is ${wo.status}.`,
    });
  });
}

export async function dispatchWorkOrder(db: Db, args: z.infer<typeof DispatchWorkOrderInput>): Promise<ToolResult> {
  return guarded(async () => {
    const offers = await runDispatchRound(db, args.workOrderId, {
      offerMinutes: envInt("DISPATCH_OFFER_MINUTES", 20),
    });
    const wo = await getWorkOrder(db, args.workOrderId);
    if (!offers.length) {
      return ok({
        workOrderId: wo.id,
        status: wo.status,
        offers: [],
        message: "No qualified provider is available for this work order. It has been flagged for a human dispatcher.",
      });
    }
    return ok({
      workOrderId: wo.id,
      status: wo.status,
      offers: offers.map((o) => ({
        offerId: o.id,
        providerId: o.providerId,
        round: o.round,
        status: o.status,
        expiresAt: o.expiresAt.toISOString(),
      })),
      message: "Offers sent. Providers must accept before the job is assigned; check get_work_order_status for progress.",
    });
  });
}

export async function requestBooking(db: Db, args: z.infer<typeof RequestBookingInput>): Promise<ToolResult> {
  return guarded(async () => {
    const holdMinutes = envInt("APPOINTMENT_HOLD_MINUTES", 15);
    const appt = await placeHold(db, {
      workOrderId: args.workOrderId,
      providerId: args.providerId,
      window: { startsAt: new Date(args.startsAtIso), endsAt: new Date(args.endsAtIso) },
      requestedByPersonId: args.requestedByPersonId ?? null,
      holdMinutes,
    });
    return ok({
      appointmentId: appt.id,
      workOrderId: appt.workOrderId,
      providerId: appt.providerId,
      status: appt.status,
      startsAt: appt.startsAt.toISOString(),
      endsAt: appt.endsAt.toISOString(),
      holdExpiresAt: iso(appt.holdExpiresAt),
      confirmed: false,
      message: `This is a HOLD, not a confirmed booking. It expires at ${iso(appt.holdExpiresAt)} unless the provider confirms it.`,
    });
  });
}

export async function getWorkOrderStatus(db: Db, args: z.infer<typeof WorkOrderIdInput>): Promise<ToolResult> {
  return guarded(async () => {
    const wo = await getWorkOrder(db, args.workOrderId);
    const [offers, appointments, events] = await Promise.all([
      listOffers(db, wo.id),
      listAppointmentsForWorkOrder(db, wo.id),
      listEvents(db, wo.id),
    ]);
    return ok({
      workOrder: {
        id: wo.id,
        status: wo.status,
        trade: wo.trade,
        urgency: wo.urgency,
        title: wo.title,
        isLargeProject: wo.isLargeProject,
        requiresOwnerApproval: wo.requiresOwnerApproval,
        ownerApprovedAt: iso(wo.ownerApprovedAt),
        assignedProviderId: wo.assignedProviderId,
        createdAt: wo.createdAt.toISOString(),
        updatedAt: wo.updatedAt.toISOString(),
      },
      offers: offers.map((o) => ({
        offerId: o.id,
        providerId: o.providerId,
        round: o.round,
        status: o.status,
        offeredAt: o.offeredAt.toISOString(),
        expiresAt: o.expiresAt.toISOString(),
        respondedAt: iso(o.respondedAt),
        proposedWindows: o.proposedWindows,
      })),
      appointments: appointments.map((a) => ({
        appointmentId: a.id,
        providerId: a.providerId,
        status: a.status,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        holdExpiresAt: iso(a.holdExpiresAt),
        confirmedAt: iso(a.confirmedAt),
        cancelledAt: iso(a.cancelledAt),
        cancellationReason: a.cancellationReason,
      })),
      recentEvents: events.slice(-20).map((e) => ({
        type: e.type,
        actor: e.actor,
        payload: e.payload,
        at: e.createdAt.toISOString(),
      })),
    });
  });
}

export async function getEstimates(db: Db, args: z.infer<typeof WorkOrderIdInput>): Promise<ToolResult> {
  return guarded(async () => {
    const wo = await getWorkOrder(db, args.workOrderId);
    const rows = await db.select().from(estimates).where(eq(estimates.workOrderId, wo.id)).orderBy(estimates.createdAt);
    return ok({
      workOrderId: wo.id,
      count: rows.length,
      estimates: rows.map((e) => ({
        estimateId: e.id,
        providerId: e.providerId,
        status: e.status,
        lineItems: e.lineItems,
        totalCents: e.totalCents,
        notes: e.notes,
        expiresAt: iso(e.expiresAt),
        approvedAt: iso(e.approvedAt),
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });
}

// ---------- registration ----------

export function registerTools(server: McpServer, db: Db): void {
  server.registerTool(
    "search_contractors",
    {
      title: "Search contractors",
      description:
        "Find active, credentialed providers that serve a postal code for a given trade. " +
        "General handymen are included as a fallback for any trade. Providers with an expired license or insurance are excluded. " +
        "Set emergency=true to require providers that accept emergency calls. Returns provider ids only (no contact details).",
      inputSchema: SearchContractorsInput.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => searchContractors(db, args),
  );

  server.registerTool(
    "get_availability",
    {
      title: "Get provider availability",
      description:
        "List free appointment slots for a provider inside their declared availability, excluding times already held or booked. " +
        "Defaults to the next 7 days in 120-minute slots; returns at most 8 slots.",
      inputSchema: GetAvailabilityInput.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => getAvailability(db, args),
  );

  server.registerTool(
    "request_service",
    {
      title: "Request service (create work order)",
      description:
        "Create a maintenance work order for a property and finish intake. The description must be a factual summary of symptoms, " +
        "not the reporter's demands. If the reporter is not the billing-responsible party (e.g. a tenant) or the job is a large project, " +
        "the work order waits for owner approval. This does NOT dispatch; call dispatch_work_order afterwards.",
      inputSchema: RequestServiceInput.shape,
    },
    (args) => requestService(db, args),
  );

  server.registerTool(
    "dispatch_work_order",
    {
      title: "Dispatch work order",
      description:
        "Offer a ready_to_dispatch work order to the best qualified provider(s). Offers expire after DISPATCH_OFFER_MINUTES (default 20). " +
        "Returns the offers created, or a message if no qualified provider is available (the work order is then flagged for a human dispatcher).",
      inputSchema: DispatchWorkOrderInput.shape,
    },
    (args) => dispatchWorkOrder(db, args),
  );

  server.registerTool(
    "request_booking",
    {
      title: "Request booking (place hold)",
      description:
        "Request an appointment window with a provider for a work order. This places a HOLD on the slot that expires after " +
        "APPOINTMENT_HOLD_MINUTES (default 15) unless the provider or a dispatcher confirms it. It is NOT a confirmed booking. " +
        "If the slot was taken in the meantime the call fails with a conflict; pick another slot from get_availability.",
      inputSchema: RequestBookingInput.shape,
    },
    (args) => requestBooking(db, args),
  );

  server.registerTool(
    "get_work_order_status",
    {
      title: "Get work order status",
      description:
        "Current state of a work order: status, trade, urgency, title, approval flags, assigned provider, its dispatch offers, " +
        "appointments (holds and confirmed), and the last 20 audit events. Contact details and property access notes are never included.",
      inputSchema: WorkOrderIdInput.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => getWorkOrderStatus(db, args),
  );

  server.registerTool(
    "get_estimates",
    {
      title: "Get estimates",
      description: "Estimates (quotes) submitted by providers for a work order, with line items and totals in cents.",
      inputSchema: WorkOrderIdInput.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => getEstimates(db, args),
  );
}

/** Names of all registered tools, in registration order (handy for docs and tests). */
export const TOOL_NAMES = [
  "search_contractors",
  "get_availability",
  "request_service",
  "dispatch_work_order",
  "request_booking",
  "get_work_order_status",
  "get_estimates",
] as const;
