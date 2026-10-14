/**
 * Dispatch: find qualified providers, offer the job in rounds, handle accept/decline/expiry,
 * and define what happens when nobody accepts.
 *
 * Qualification = active status, trade match, serves the postal code, license & insurance
 * not expired (unverified is allowed only when ALLOW_UNVERIFIED_PROVIDERS=true - never in prod),
 * and acceptsEmergencies for emergency work.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { dispatchOffers, properties, providers, workOrders, type Db } from "@labordispatch/db";
import { conflict, notFound } from "./errors.js";
import type { Window } from "./scheduling.js";
import { addEvent, getWorkOrder, transition } from "./work-orders.js";

export interface DispatchOptions {
  offerMinutes: number;
  /** Providers offered per round. 1 = sequential; >1 = first to accept wins. */
  offersPerRound?: number;
  maxRounds?: number;
  allowUnverifiedProviders?: boolean;
  /** Called to deliver the offer (webhook, SMS, push). Failures are logged, not fatal. */
  deliver?: (offer: typeof dispatchOffers.$inferSelect, provider: typeof providers.$inferSelect) => Promise<void>;
}

export interface Candidate {
  provider: typeof providers.$inferSelect;
  score: number;
  reasons: string[];
}

export async function findCandidates(
  db: Db,
  workOrderId: string,
  opts: { allowUnverifiedProviders?: boolean; exclude?: string[] } = {},
): Promise<Candidate[]> {
  const wo = await getWorkOrder(db, workOrderId);
  const [prop] = await db.select().from(properties).where(eq(properties.id, wo.propertyId)).limit(1);
  if (!prop) throw notFound("property");
  const all = await db.select().from(providers).where(eq(providers.status, "active"));
  const now = Date.now();
  const out: Candidate[] = [];
  for (const p of all) {
    if (opts.exclude?.includes(p.id)) continue;
    if (!p.trades.includes(wo.trade) && !p.trades.includes("general_handyman")) continue;
    if (!p.servicePostalCodes.includes(prop.postalCode)) continue;
    if (wo.urgency === "emergency" && !p.acceptsEmergencies) continue;
    const licenseOk = p.licenseVerifiedAt && (!p.licenseExpiresAt || p.licenseExpiresAt.getTime() > now);
    const insuranceOk = p.insuranceVerifiedAt && (!p.insuranceExpiresAt || p.insuranceExpiresAt.getTime() > now);
    if (!(licenseOk && insuranceOk) && !opts.allowUnverifiedProviders) continue;
    const reasons: string[] = [];
    let score = 0;
    if (p.trades.includes(wo.trade)) { score += 10; reasons.push("exact trade match"); } else reasons.push("handyman fallback");
    if (p.rating) { score += Number(p.rating) * 2; reasons.push(`rating ${p.rating}`); }
    score += Math.min(p.jobsCompleted, 50) / 10;
    if (licenseOk && insuranceOk) { score += 5; reasons.push("license+insurance verified"); } else reasons.push("UNVERIFIED credentials");
    out.push({ provider: p, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function currentRound(db: Db, workOrderId: string): Promise<number> {
  const [r] = await db
    .select({ max: sql<number>`coalesce(max(${dispatchOffers.round}), 0)` })
    .from(dispatchOffers)
    .where(eq(dispatchOffers.workOrderId, workOrderId));
  return Number(r?.max ?? 0);
}

/**
 * Start (or continue) dispatch: offer to the next best provider(s) not yet offered.
 * Returns the offers created, or [] if exhausted (work order moves to no_provider_available).
 */
export async function runDispatchRound(db: Db, workOrderId: string, opts: DispatchOptions) {
  const wo = await getWorkOrder(db, workOrderId);
  if (!["ready_to_dispatch", "offered"].includes(wo.status)) {
    throw conflict(`work order is ${wo.status}; dispatch needs ready_to_dispatch`);
  }
  const prior = await db.select().from(dispatchOffers).where(eq(dispatchOffers.workOrderId, workOrderId));
  const exclude = prior.map((o) => o.providerId);
  const round = (await currentRound(db, workOrderId)) + 1;
  if (opts.maxRounds && round > opts.maxRounds) return exhaust(db, workOrderId, "max rounds reached");

  const candidates = (await findCandidates(db, workOrderId, { allowUnverifiedProviders: opts.allowUnverifiedProviders, exclude })).slice(
    0,
    opts.offersPerRound ?? 1,
  );
  if (!candidates.length) return exhaust(db, workOrderId, "no qualified providers left");

  const expiresAt = new Date(Date.now() + opts.offerMinutes * 60_000);
  const created = [];
  for (const c of candidates) {
    const [offer] = await db
      .insert(dispatchOffers)
      .values({ workOrderId, providerId: c.provider.id, round, expiresAt })
      .returning();
    await addEvent(db, workOrderId, "offer_sent", "system", { offerId: offer!.id, providerId: c.provider.id, round, reasons: c.reasons });
    created.push(offer!);
    if (opts.deliver) {
      try {
        await opts.deliver(offer!, c.provider);
      } catch (err) {
        await addEvent(db, workOrderId, "offer_delivery_failed", "system", { offerId: offer!.id, error: String(err) });
      }
    }
  }
  if (wo.status === "ready_to_dispatch") await transition(db, workOrderId, "offered", "system");
  return created;
}

async function exhaust(db: Db, workOrderId: string, reason: string) {
  await transition(db, workOrderId, "no_provider_available", "system", reason);
  await addEvent(db, workOrderId, "needs_human_dispatcher", "system", { reason });
  return [] as (typeof dispatchOffers.$inferSelect)[];
}

export async function respondToOffer(
  db: Db,
  offerId: string,
  response: { accept: boolean; note?: string; proposedWindows?: Window[] },
) {
  const [offer] = await db.select().from(dispatchOffers).where(eq(dispatchOffers.id, offerId)).limit(1);
  if (!offer) throw notFound("offer");
  if (offer.status !== "pending") throw conflict(`offer already ${offer.status}`);
  if (offer.expiresAt.getTime() < Date.now()) {
    await db.update(dispatchOffers).set({ status: "expired" }).where(eq(dispatchOffers.id, offerId));
    throw conflict("offer expired");
  }
  const actor = `provider:${offer.providerId}`;
  if (!response.accept) {
    const [upd] = await db
      .update(dispatchOffers)
      .set({ status: "declined", respondedAt: new Date(), responseNote: response.note ?? null })
      .where(eq(dispatchOffers.id, offerId))
      .returning();
    await addEvent(db, offer.workOrderId, "offer_declined", actor, { offerId, note: response.note ?? null });
    return { offer: upd!, accepted: false as const };
  }
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Only one acceptance can win: re-check the work order is still offered.
    const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, offer.workOrderId)).for("update");
    if (!wo || wo.status !== "offered") throw conflict("job is no longer available");
    const [upd] = await tx
      .update(dispatchOffers)
      .set({
        status: "accepted",
        respondedAt: new Date(),
        responseNote: response.note ?? null,
        proposedWindows: (response.proposedWindows ?? []).map((w) => ({ startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() })),
      })
      .where(eq(dispatchOffers.id, offerId))
      .returning();
    await tx
      .update(dispatchOffers)
      .set({ status: "withdrawn", respondedAt: new Date() })
      .where(and(eq(dispatchOffers.workOrderId, offer.workOrderId), eq(dispatchOffers.status, "pending")));
    await addEvent(t, offer.workOrderId, "offer_accepted", actor, { offerId });
    await transition(t, offer.workOrderId, "accepted", actor, undefined, { assignedProviderId: offer.providerId });
    return { offer: upd!, accepted: true as const };
  });
}

/** Housekeeping: expire pending offers and start the next round for each affected work order. */
export async function expireOffersAndAdvance(db: Db, opts: DispatchOptions): Promise<string[]> {
  const expired = await db
    .update(dispatchOffers)
    .set({ status: "expired", respondedAt: new Date() })
    .where(and(eq(dispatchOffers.status, "pending"), lt(dispatchOffers.expiresAt, new Date())))
    .returning();
  const touched = [...new Set(expired.map((e) => e.workOrderId))];
  for (const woId of touched) {
    await addEvent(db, woId, "offers_expired", "system", { offerIds: expired.filter((e) => e.workOrderId === woId).map((e) => e.id) });
    const stillPending = await db
      .select({ id: dispatchOffers.id })
      .from(dispatchOffers)
      .where(and(eq(dispatchOffers.workOrderId, woId), eq(dispatchOffers.status, "pending")));
    if (!stillPending.length) await runDispatchRound(db, woId, opts).catch(() => undefined);
  }
  return touched;
}

export async function listOffers(db: Db, workOrderId: string) {
  return db.select().from(dispatchOffers).where(eq(dispatchOffers.workOrderId, workOrderId)).orderBy(desc(dispatchOffers.offeredAt));
}

export async function listPendingOffersForProvider(db: Db, providerId: string) {
  return db
    .select()
    .from(dispatchOffers)
    .where(and(eq(dispatchOffers.providerId, providerId), inArray(dispatchOffers.status, ["pending"])));
}
