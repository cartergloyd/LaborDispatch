/**
 * Estimates, invoices, payments and disputes.
 *  - Only the billing-responsible party approves estimates / is billed.
 *  - Disputes on rental properties loop the owner in (ownerNotifiedAt) because the tenant raised the
 *    issue but the owner pays.
 */
import { eq } from "drizzle-orm";
import { disputes, estimates, invoices, payments, type Db } from "@labordispatch/db";
import { conflict, forbidden, notFound } from "./errors.js";
import { addEvent, getWorkOrder, transition } from "./work-orders.js";

export interface LineItem {
  description: string;
  quantity: number;
  unitCents: number;
}
export const sumLineItems = (items: LineItem[]) => items.reduce((s, li) => s + Math.round(li.quantity * li.unitCents), 0);

export async function createEstimate(db: Db, input: { workOrderId: string; providerId: string; lineItems: LineItem[]; notes?: string; expiresAt?: Date }) {
  const [row] = await db
    .insert(estimates)
    .values({
      workOrderId: input.workOrderId,
      providerId: input.providerId,
      lineItems: input.lineItems,
      totalCents: sumLineItems(input.lineItems),
      notes: input.notes ?? null,
      expiresAt: input.expiresAt ?? null,
      status: "sent",
    })
    .returning();
  await addEvent(db, input.workOrderId, "estimate_sent", `provider:${input.providerId}`, { estimateId: row!.id, totalCents: row!.totalCents });
  return row!;
}

export async function approveEstimate(db: Db, estimateId: string, personId: string) {
  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId)).limit(1);
  if (!est) throw notFound("estimate");
  const wo = await getWorkOrder(db, est.workOrderId);
  if (wo.billingPersonId && wo.billingPersonId !== personId) throw forbidden("only the billing-responsible party can approve an estimate");
  if (est.status !== "sent") throw conflict(`estimate is ${est.status}`);
  const [upd] = await db
    .update(estimates)
    .set({ status: "approved", approvedAt: new Date(), approvedByPersonId: personId })
    .where(eq(estimates.id, estimateId))
    .returning();
  await addEvent(db, est.workOrderId, "estimate_approved", `person:${personId}`, { estimateId });
  return upd!;
}

export async function createInvoice(db: Db, input: { workOrderId: string; providerId: string; lineItems: LineItem[]; taxCents?: number; dueInDays?: number }) {
  const wo = await getWorkOrder(db, input.workOrderId);
  if (!["completed", "invoiced", "disputed"].includes(wo.status)) throw conflict("work must be completed before invoicing");
  const subtotal = sumLineItems(input.lineItems);
  const tax = input.taxCents ?? 0;
  const [row] = await db
    .insert(invoices)
    .values({
      workOrderId: input.workOrderId,
      providerId: input.providerId,
      billToPersonId: wo.billingPersonId,
      lineItems: input.lineItems,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: subtotal + tax,
      status: "sent",
      issuedAt: new Date(),
      dueAt: new Date(Date.now() + (input.dueInDays ?? 14) * 86_400_000),
    })
    .returning();
  await transition(db, input.workOrderId, "invoiced", `provider:${input.providerId}`).catch(() => null);
  await addEvent(db, input.workOrderId, "invoice_sent", `provider:${input.providerId}`, { invoiceId: row!.id, totalCents: row!.totalCents });
  return row!;
}

export async function recordPayment(db: Db, input: { invoiceId: string; amountCents: number; method: string; reference?: string }) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (!inv) throw notFound("invoice");
  if (inv.status === "void") throw conflict("invoice is void");
  await db.insert(payments).values({ invoiceId: inv.id, amountCents: input.amountCents, method: input.method, reference: input.reference ?? null });
  const paid = inv.paidCents + input.amountCents;
  const status = paid >= inv.totalCents ? "paid" : "partially_paid";
  const [upd] = await db
    .update(invoices)
    .set({ paidCents: paid, status, paidAt: status === "paid" ? new Date() : null })
    .where(eq(invoices.id, inv.id))
    .returning();
  await addEvent(db, inv.workOrderId, "payment_recorded", "system", { invoiceId: inv.id, amountCents: input.amountCents, status });
  if (status === "paid") await transition(db, inv.workOrderId, "paid", "system").catch(() => null);
  return upd!;
}

export async function openDispute(db: Db, input: { invoiceId: string; raisedByPersonId?: string | null; reason: string }) {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (!inv) throw notFound("invoice");
  const wo = await getWorkOrder(db, inv.workOrderId);
  // Rental: the reporter (tenant) and billing party (owner) differ -> owner must be looped in.
  const ownerInvolved = wo.billingPersonId !== null && wo.billingPersonId !== input.raisedByPersonId;
  const [row] = await db
    .insert(disputes)
    .values({
      invoiceId: inv.id,
      raisedByPersonId: input.raisedByPersonId ?? null,
      reason: input.reason,
      ownerNotifiedAt: ownerInvolved ? new Date() : null,
    })
    .returning();
  await db.update(invoices).set({ status: "disputed" }).where(eq(invoices.id, inv.id));
  await transition(db, inv.workOrderId, "disputed", input.raisedByPersonId ? `person:${input.raisedByPersonId}` : "system").catch(() => null);
  await addEvent(db, inv.workOrderId, "dispute_opened", "system", { disputeId: row!.id, ownerNotified: ownerInvolved });
  return row!;
}

export async function resolveDispute(db: Db, disputeId: string, outcome: "resolved_for_customer" | "resolved_for_provider" | "withdrawn", resolution: string) {
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId)).limit(1);
  if (!d) throw notFound("dispute");
  if (d.status !== "open" && d.status !== "under_review") throw conflict(`dispute is ${d.status}`);
  const [upd] = await db.update(disputes).set({ status: outcome, resolution, resolvedAt: new Date() }).where(eq(disputes.id, disputeId)).returning();
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, d.invoiceId)).limit(1);
  if (inv) {
    const back = inv.paidCents >= inv.totalCents ? "paid" : "sent";
    await db.update(invoices).set({ status: outcome === "resolved_for_customer" ? "void" : back }).where(eq(invoices.id, inv.id));
    await addEvent(db, inv.workOrderId, "dispute_resolved", "system", { disputeId, outcome });
    await transition(db, inv.workOrderId, inv.paidCents >= inv.totalCents ? "paid" : "invoiced", "system").catch(() => null);
  }
  return upd!;
}
