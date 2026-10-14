// DEMO ONLY - remove before production
/**
 * Fake dispatch receivers: pretend contractors that receive offer webhooks from the API's
 * dispatcher and, after a short delay, call back the API's `respondUrl` to accept/decline.
 *
 * They deliberately NEVER touch the database. They simulate an external contractor's system,
 * so the only contract they rely on is the webhook payload + the respond endpoint.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { DEMO_TAG } from "@labordispatch/shared";

export const RECEIVER_BEHAVIORS = ["accept", "decline", "ignore", "slow_accept"] as const;
export type ReceiverBehavior = (typeof RECEIVER_BEHAVIORS)[number];

export const offerPayloadSchema = z.object({
  offerId: z.string().min(1),
  workOrderId: z.string().min(1),
  providerId: z.string().min(1),
  trade: z.string(),
  urgency: z.string(),
  title: z.string(),
  description: z.string(),
  postalCode: z.string(),
  expiresAt: z.string(),
  respondUrl: z.string().url(),
});
export type OfferPayload = z.infer<typeof offerPayloadSchema>;

export interface ReceiversServerOptions {
  /** providerId -> behavior. Defaults to parsing `DEMO_RECEIVER_BEHAVIOR` (JSON) from env. */
  behavior?: Record<string, ReceiverBehavior>;
  /** Behavior for providers not in the map. Default "accept". */
  defaultBehavior?: ReceiverBehavior;
  /** Fixed delay before responding. Omit for random 1-4 s (8 s for slow_accept). Use 0 in tests. */
  delayMs?: number;
  /** Bearer token sent to `respondUrl`. Defaults to `API_TOKEN` env. */
  apiToken?: string;
  /** Injectable fetch (tests). Defaults to the global fetch, resolved at call time. */
  fetchImpl?: typeof fetch;
  /** Injectable logger. Defaults to console.log with a [DEMO RECEIVER] prefix. */
  log?: (message: string) => void;
}

export interface ReceiversDemoState {
  demoTag: typeof DEMO_TAG;
  behaviorFor(providerId: string): ReceiverBehavior;
  /** Resolves once every scheduled response has finished (tests). */
  drain(): Promise<void>;
  received: OfferPayload[];
  responses: { offerId: string; accept: boolean; status: number | null; error?: string }[];
}

declare module "fastify" {
  interface FastifyInstance {
    demo: ReceiversDemoState;
  }
}

export function parseBehaviorEnv(raw: string | undefined): Record<string, ReceiverBehavior> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DEMO_RECEIVER_BEHAVIOR must be a JSON object of providerId -> ${RECEIVER_BEHAVIORS.join("|")}`);
  }
  return z.record(z.enum(RECEIVER_BEHAVIORS)).parse(parsed);
}

export function buildReceiversServer(opts: ReceiversServerOptions = {}): FastifyInstance {
  const behaviorMap = opts.behavior ?? parseBehaviorEnv(process.env.DEMO_RECEIVER_BEHAVIOR);
  const defaultBehavior: ReceiverBehavior = opts.defaultBehavior ?? "accept";
  const apiToken = opts.apiToken ?? process.env.API_TOKEN ?? "";
  const fetchImpl: typeof fetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const log = opts.log ?? ((m: string) => console.log(`[DEMO RECEIVER] ${m}`));

  const app = Fastify({ logger: false });
  const pending = new Set<Promise<void>>();

  const state: ReceiversDemoState = {
    demoTag: DEMO_TAG,
    behaviorFor: (providerId) => behaviorMap[providerId] ?? defaultBehavior,
    drain: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    received: [],
    responses: [],
  };
  app.decorate("demo", state);

  app.get("/demo/health", async () => ({ ok: true, demo: DEMO_TAG }));

  app.post("/demo/receive-offer", async (req, reply) => {
    const parsed = offerPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid offer payload", issues: parsed.error.issues, demo: DEMO_TAG });
    }
    const offer = parsed.data;
    const behavior = state.behaviorFor(offer.providerId);
    const delayMs = opts.delayMs ?? (behavior === "slow_accept" ? 8_000 : 1_000 + Math.floor(Math.random() * 3_000));
    state.received.push(offer);
    log(
      `received offer ${offer.offerId} for provider ${offer.providerId} (${offer.trade}/${offer.urgency}, ${offer.postalCode}) "${offer.title}" -> behavior=${behavior}`,
    );

    if (behavior === "ignore") {
      log(`ignoring offer ${offer.offerId} (will let it expire at ${offer.expiresAt})`);
      return reply.code(202).send({ ok: true, demo: DEMO_TAG, behavior, willRespond: false });
    }

    const accept = behavior === "accept" || behavior === "slow_accept";
    const task = respondLater({ offer, accept, behavior, delayMs, apiToken, fetchImpl, log, state });
    pending.add(task);
    void task.finally(() => pending.delete(task));

    return reply.code(202).send({ ok: true, demo: DEMO_TAG, behavior, willRespond: true, willRespondInMs: delayMs });
  });

  return app;
}

async function respondLater(args: {
  offer: OfferPayload;
  accept: boolean;
  behavior: ReceiverBehavior;
  delayMs: number;
  apiToken: string;
  fetchImpl: typeof fetch;
  log: (m: string) => void;
  state: ReceiversDemoState;
}): Promise<void> {
  const { offer, accept, behavior, delayMs, apiToken, fetchImpl, log, state } = args;
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  const note = `${accept ? "Accepted" : "Declined"} by fake contractor (behavior=${behavior}). ${DEMO_TAG}`;
  try {
    const res = await fetchImpl(offer.respondUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ accept, note }),
    });
    state.responses.push({ offerId: offer.offerId, accept, status: res.status });
    log(`${accept ? "ACCEPTED" : "DECLINED"} offer ${offer.offerId} after ${delayMs}ms -> ${offer.respondUrl} (HTTP ${res.status})`);
  } catch (err) {
    state.responses.push({ offerId: offer.offerId, accept, status: null, error: String(err) });
    log(`FAILED to respond to offer ${offer.offerId} at ${offer.respondUrl}: ${String(err)}`);
  }
}
