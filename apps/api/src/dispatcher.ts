/** Delivers dispatch offers to providers (webhook today; SMS/push later) and runs housekeeping. */
import type { Db, dispatchOffers, providers } from "@labordispatch/db";
import { eq } from "drizzle-orm";
import { properties, workOrders } from "@labordispatch/db";
import { expireHolds, expireOffersAndAdvance, runDispatchRound, type DispatchOptions } from "@labordispatch/core";
import type { ApiConfig } from "./config.js";

export function makeDeliver(db: Db, config: ApiConfig, fetchImpl: typeof fetch = fetch): NonNullable<DispatchOptions["deliver"]> {
  return async (offer: typeof dispatchOffers.$inferSelect, provider: typeof providers.$inferSelect) => {
    if (!provider.offerWebhookUrl) return; // TODO: SMS/push delivery for providers without an integration
    const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, offer.workOrderId)).limit(1);
    if (!wo) return;
    const [prop] = await db.select().from(properties).where(eq(properties.id, wo.propertyId)).limit(1);
    // Offer payload is deliberately coarse: no exact address or access notes until the offer is accepted.
    const payload = {
      offerId: offer.id,
      workOrderId: wo.id,
      providerId: provider.id,
      trade: wo.trade,
      urgency: wo.urgency,
      title: wo.title,
      description: wo.description,
      postalCode: prop?.postalCode ?? null,
      city: prop?.city ?? null,
      expiresAt: offer.expiresAt.toISOString(),
      respondUrl: `${config.publicUrl}/offers/${offer.id}/respond`,
    };
    const res = await fetchImpl(provider.offerWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`offer webhook ${provider.offerWebhookUrl} returned ${res.status}`);
  };
}

export function dispatchOptions(db: Db, config: ApiConfig, fetchImpl?: typeof fetch): DispatchOptions {
  return {
    offerMinutes: config.offerMinutes,
    offersPerRound: 1,
    maxRounds: 5,
    allowUnverifiedProviders: config.allowUnverifiedProviders,
    deliver: makeDeliver(db, config, fetchImpl),
  };
}

/** Auto-dispatch anything that became ready (owner approvals, intake completions). */
export async function dispatchReadyWorkOrders(db: Db, opts: DispatchOptions): Promise<number> {
  const ready = await db.select({ id: workOrders.id }).from(workOrders).where(eq(workOrders.status, "ready_to_dispatch"));
  let n = 0;
  for (const r of ready) {
    await runDispatchRound(db, r.id, opts).then(() => n++).catch(() => undefined);
  }
  return n;
}

export function startHousekeeping(db: Db, opts: DispatchOptions, log: (msg: string) => void, intervalMs = 30_000) {
  const tick = async () => {
    try {
      const holds = await expireHolds(db);
      const advanced = await expireOffersAndAdvance(db, opts);
      const dispatched = await dispatchReadyWorkOrders(db, opts);
      if (holds || advanced.length || dispatched) log(`housekeeping: expired ${holds} holds, advanced ${advanced.length} offers, dispatched ${dispatched}`);
    } catch (err) {
      log(`housekeeping error: ${String(err)}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
