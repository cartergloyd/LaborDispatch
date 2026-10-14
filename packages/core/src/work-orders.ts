/**
 * Work orders: intake -> (owner approval) -> dispatch -> schedule -> complete -> invoice.
 * Transitions are whitelisted; every change is appended to work_order_events.
 */
import { and, desc, eq } from "drizzle-orm";
import { workOrderEvents, workOrders, type Db } from "@labordispatch/db";
import type { WorkOrderCreateInput, WorkOrderStatus } from "@labordispatch/shared";
import { DomainError, forbidden, notFound } from "./errors.js";
import { billingPartyFor, canAccessProperty } from "./identity.js";

export const ALLOWED_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  intake: ["needs_info", "pending_owner_approval", "ready_to_dispatch", "cancelled"],
  needs_info: ["intake", "pending_owner_approval", "ready_to_dispatch", "cancelled"],
  pending_owner_approval: ["ready_to_dispatch", "needs_info", "cancelled"],
  ready_to_dispatch: ["offered", "no_provider_available", "cancelled"],
  offered: ["accepted", "ready_to_dispatch", "no_provider_available", "cancelled"],
  accepted: ["scheduled", "ready_to_dispatch", "cancelled"],
  scheduled: ["in_progress", "accepted", "cancelled"],
  in_progress: ["completed", "scheduled", "cancelled"],
  completed: ["invoiced", "disputed"],
  invoiced: ["paid", "disputed"],
  disputed: ["invoiced", "paid", "cancelled"],
  paid: [],
  cancelled: [],
  no_provider_available: ["ready_to_dispatch", "cancelled"],
};

export async function addEvent(
  db: Db,
  workOrderId: string,
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
) {
  await db.insert(workOrderEvents).values({ workOrderId, type, actor, payload });
}

export async function getWorkOrder(db: Db, id: string) {
  const [row] = await db.select().from(workOrders).where(eq(workOrders.id, id)).limit(1);
  if (!row) throw notFound("work order");
  return row;
}

export async function listWorkOrders(db: Db, filter: { propertyId?: string; status?: WorkOrderStatus } = {}) {
  const conds = [];
  if (filter.propertyId) conds.push(eq(workOrders.propertyId, filter.propertyId));
  if (filter.status) conds.push(eq(workOrders.status, filter.status));
  const q = db.select().from(workOrders).orderBy(desc(workOrders.createdAt));
  return conds.length ? q.where(and(...conds)) : q;
}

export async function listEvents(db: Db, workOrderId: string) {
  return db
    .select()
    .from(workOrderEvents)
    .where(eq(workOrderEvents.workOrderId, workOrderId))
    .orderBy(workOrderEvents.createdAt);
}

/**
 * Create from intake. Derives the billing party and whether owner approval is required
 * (reporter is not the billing party, e.g. tenant -> landlord). Large projects always require approval.
 */
export async function createWorkOrder(
  db: Db,
  input: WorkOrderCreateInput & { actor?: string; isDemo?: boolean },
) {
  if (input.reportedByPersonId) {
    const ok = await canAccessProperty(db, input.reportedByPersonId, input.propertyId);
    if (!ok) throw forbidden("reporter has no active relationship with this property");
  }
  const billing = await billingPartyFor(db, input.propertyId);
  const requiresOwnerApproval =
    input.isLargeProject || (billing !== null && billing.id !== input.reportedByPersonId);

  const [wo] = await db
    .insert(workOrders)
    .values({
      propertyId: input.propertyId,
      reportedByPersonId: input.reportedByPersonId ?? null,
      billingPersonId: billing?.id ?? null,
      conversationId: input.conversationId ?? null,
      trade: input.trade,
      urgency: input.urgency,
      title: input.title,
      description: input.description,
      symptoms: input.symptoms,
      troubleshootingPerformed: input.troubleshootingPerformed,
      isLargeProject: input.isLargeProject,
      requiresOwnerApproval,
      status: "intake",
      isDemo: input.isDemo ?? false,
    })
    .returning();
  if (!wo) throw new Error("insert failed");
  await addEvent(db, wo.id, "created", input.actor ?? "system", {
    requiresOwnerApproval,
    billingPersonId: billing?.id ?? null,
  });
  return wo;
}

export async function transition(
  db: Db,
  workOrderId: string,
  to: WorkOrderStatus,
  actor: string,
  note?: string,
  extra: Partial<typeof workOrders.$inferInsert> = {},
) {
  const wo = await getWorkOrder(db, workOrderId);
  if (wo.status === to) return wo;
  if (!ALLOWED_TRANSITIONS[wo.status].includes(to)) {
    throw new DomainError(`cannot move work order from ${wo.status} to ${to}`, "invalid_transition", 409);
  }
  const [updated] = await db
    .update(workOrders)
    .set({ status: to, ...extra })
    .where(eq(workOrders.id, workOrderId))
    .returning();
  await addEvent(db, workOrderId, "status_changed", actor, { from: wo.status, to, note: note ?? null });
  return updated!;
}

/**
 * Finish intake: decide where the work order goes next.
 * Emergencies skip owner approval for dispatch (safety first) but still notify the owner.
 */
export async function finalizeIntake(db: Db, workOrderId: string, actor: string) {
  const wo = await getWorkOrder(db, workOrderId);
  if (wo.status !== "intake" && wo.status !== "needs_info") return wo;
  if (wo.requiresOwnerApproval && wo.urgency !== "emergency") {
    return transition(db, workOrderId, "pending_owner_approval", actor, "reporter is not the billing party");
  }
  if (wo.requiresOwnerApproval && wo.urgency === "emergency") {
    await addEvent(db, workOrderId, "owner_notified", actor, { reason: "emergency dispatched before approval" });
  }
  return transition(db, workOrderId, "ready_to_dispatch", actor);
}

/** Only the billing-responsible party may approve. */
export async function approveByOwner(db: Db, workOrderId: string, personId: string, note?: string) {
  const wo = await getWorkOrder(db, workOrderId);
  if (wo.billingPersonId !== personId) throw forbidden("only the billing-responsible party can approve");
  return transition(db, workOrderId, "ready_to_dispatch", `person:${personId}`, note, {
    ownerApprovedAt: new Date(),
    ownerApprovedByPersonId: personId,
  });
}
