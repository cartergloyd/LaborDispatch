/**
 * Scheduling rules (README "Booking and scheduling rules"):
 *  - A homeowner *requests* a window. The system places a HOLD that expires after
 *    APPOINTMENT_HOLD_MINUTES unless the provider (or a dispatcher) confirms it.
 *  - Two requests for the same provider slot: the provider row is locked for the duration of the
 *    insert so the second request sees the first hold and is rejected with 409.
 *  - Cancellation records who/why; cancelled and expired holds free the slot.
 */
import { and, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { appointments, providerAvailability, providers, workOrders, type Db } from "@labordispatch/db";
import { conflict, notFound } from "./errors.js";
import { addEvent, transition } from "./work-orders.js";

export interface Window {
  startsAt: Date;
  endsAt: Date;
}

function overlaps(a: Window, b: Window) {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/** Appointments that currently block a provider's time (confirmed/requested, or unexpired holds). */
async function blockingAppointments(db: Db, providerId: string, range: Window) {
  const now = new Date();
  return db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.providerId, providerId),
        lt(appointments.startsAt, range.endsAt),
        gt(appointments.endsAt, range.startsAt),
        or(
          inArray(appointments.status, ["requested", "confirmed"]),
          and(eq(appointments.status, "hold"), gt(appointments.holdExpiresAt, now)),
        ),
      ),
    );
}

/**
 * Free windows for a provider between `from` and `to`, sliced into `slotMinutes` slots that fit
 * inside their declared availability and don't collide with blocking appointments.
 */
export async function freeSlots(
  db: Db,
  providerId: string,
  from: Date,
  to: Date,
  slotMinutes = 120,
  limit = 6,
): Promise<Window[]> {
  const avail = await db
    .select()
    .from(providerAvailability)
    .where(
      and(eq(providerAvailability.providerId, providerId), lt(providerAvailability.startsAt, to), gt(providerAvailability.endsAt, from)),
    )
    .orderBy(providerAvailability.startsAt);
  const blocking = await blockingAppointments(db, providerId, { startsAt: from, endsAt: to });
  const out: Window[] = [];
  const step = slotMinutes * 60_000;
  for (const a of avail) {
    let cursor = Math.max(a.startsAt.getTime(), from.getTime());
    const end = Math.min(a.endsAt.getTime(), to.getTime());
    while (cursor + step <= end && out.length < limit) {
      const w = { startsAt: new Date(cursor), endsAt: new Date(cursor + step) };
      if (!blocking.some((b) => overlaps(w, b))) out.push(w);
      cursor += step;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Place a hold on a provider slot for a work order. Serialized per provider. */
export async function placeHold(
  db: Db,
  input: { workOrderId: string; providerId: string; window: Window; requestedByPersonId?: string | null; holdMinutes: number },
) {
  if (input.window.endsAt <= input.window.startsAt) throw conflict("window end must be after start");
  return db.transaction(async (tx) => {
    // Lock the provider row so concurrent holds for the same provider serialize.
    const [prov] = await tx.select({ id: providers.id }).from(providers).where(eq(providers.id, input.providerId)).for("update");
    if (!prov) throw notFound("provider");
    const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, input.workOrderId)).limit(1);
    if (!wo) throw notFound("work order");
    const clash = await blockingAppointments(tx as unknown as Db, input.providerId, input.window);
    if (clash.length) throw conflict("that time is no longer available");
    const [appt] = await tx
      .insert(appointments)
      .values({
        workOrderId: input.workOrderId,
        providerId: input.providerId,
        propertyId: wo.propertyId,
        startsAt: input.window.startsAt,
        endsAt: input.window.endsAt,
        status: "hold",
        holdExpiresAt: new Date(Date.now() + input.holdMinutes * 60_000),
        requestedByPersonId: input.requestedByPersonId ?? null,
      })
      .returning();
    await addEvent(tx as unknown as Db, input.workOrderId, "hold_placed", input.requestedByPersonId ? `person:${input.requestedByPersonId}` : "system", {
      appointmentId: appt!.id,
      startsAt: input.window.startsAt.toISOString(),
      endsAt: input.window.endsAt.toISOString(),
    });
    return appt!;
  });
}

/** Provider or dispatcher confirms a hold/request. */
export async function confirmAppointment(db: Db, appointmentId: string, confirmedBy: string) {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!appt) throw notFound("appointment");
  if (appt.status === "hold" && appt.holdExpiresAt && appt.holdExpiresAt.getTime() < Date.now()) {
    throw conflict("hold has expired");
  }
  if (!["hold", "requested"].includes(appt.status)) throw conflict(`appointment is ${appt.status}`);
  const [updated] = await db
    .update(appointments)
    .set({ status: "confirmed", confirmedBy, confirmedAt: new Date(), holdExpiresAt: null })
    .where(eq(appointments.id, appointmentId))
    .returning();
  await addEvent(db, appt.workOrderId, "appointment_confirmed", confirmedBy, { appointmentId });
  const wo = await transition(db, appt.workOrderId, "scheduled", confirmedBy, undefined, {
    assignedProviderId: appt.providerId,
  }).catch(() => null);
  return { appointment: updated!, workOrder: wo };
}

export async function cancelAppointment(db: Db, appointmentId: string, actor: string, reason: string) {
  const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!appt) throw notFound("appointment");
  if (["cancelled", "completed"].includes(appt.status)) throw conflict(`appointment is ${appt.status}`);
  const [updated] = await db
    .update(appointments)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: reason })
    .where(eq(appointments.id, appointmentId))
    .returning();
  await addEvent(db, appt.workOrderId, "appointment_cancelled", actor, { appointmentId, reason });
  // A scheduled job whose appointment is cancelled goes back to accepted (provider still assigned).
  await transition(db, appt.workOrderId, "accepted", actor, "appointment cancelled").catch(() => null);
  return updated!;
}

/** Housekeeping: expire stale holds. Call from a timer. Returns count expired. */
export async function expireHolds(db: Db): Promise<number> {
  const rows = await db
    .update(appointments)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: "hold expired" })
    .where(and(eq(appointments.status, "hold"), lt(appointments.holdExpiresAt, new Date()), ne(appointments.holdExpiresAt, sql`NULL`)))
    .returning();
  for (const r of rows) await addEvent(db, r.workOrderId, "hold_expired", "system", { appointmentId: r.id });
  return rows.length;
}

export async function listAppointmentsForWorkOrder(db: Db, workOrderId: string) {
  return db.select().from(appointments).where(eq(appointments.workOrderId, workOrderId)).orderBy(appointments.startsAt);
}
