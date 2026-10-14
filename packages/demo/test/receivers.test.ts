// DEMO ONLY - remove before production
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_TAG } from "@labordispatch/shared";
import { buildReceiversServer, parseBehaviorEnv, type OfferPayload } from "../src/index.js";

const PROVIDER = "11111111-1111-1111-1111-111111111111";
const offer: OfferPayload = {
  offerId: "22222222-2222-2222-2222-222222222222",
  workOrderId: "33333333-3333-3333-3333-333333333333",
  providerId: PROVIDER,
  trade: "plumbing",
  urgency: "urgent",
  title: "No hot water",
  description: "Tenant reports no hot water since last night.",
  postalCode: "65807",
  expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
  respondUrl: "http://api.test/dispatch/offers/22222222-2222-2222-2222-222222222222/respond",
};

const apps: FastifyInstance[] = [];
const build = (...args: Parameters<typeof buildReceiversServer>) => {
  const app = buildReceiversServer(...args);
  apps.push(app);
  return app;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("fake receivers server", () => {
  it("GET /demo/health advertises the demo tag", async () => {
    const app = build({ delayMs: 0, log: () => {} });
    const res = await app.inject({ method: "GET", url: "/demo/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, demo: DEMO_TAG });
  });

  it("behavior=decline calls respondUrl with {accept:false} and the bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const logs: string[] = [];
    const app = build({ behavior: { [PROVIDER]: "decline" }, delayMs: 0, apiToken: "test-token", log: (m) => logs.push(m) });

    const res = await app.inject({ method: "POST", url: "/demo/receive-offer", payload: offer });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true, demo: DEMO_TAG, behavior: "decline", willRespond: true });

    await app.demo.drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(offer.respondUrl);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body as string);
    expect(body.accept).toBe(false);
    expect(body.note).toContain(DEMO_TAG);
    expect(app.demo.responses).toEqual([{ offerId: offer.offerId, accept: false, status: 200 }]);
    expect(logs.some((l) => l.includes("DECLINED"))).toBe(true);
  });

  it("defaults to accept for unknown providers, and slow_accept also accepts", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const app = build({ behavior: { other: "slow_accept" }, delayMs: 0, fetchImpl: fetchMock, log: () => {} });
    await app.inject({ method: "POST", url: "/demo/receive-offer", payload: offer });
    await app.inject({ method: "POST", url: "/demo/receive-offer", payload: { ...offer, offerId: "x2", providerId: "other" } });
    await app.demo.drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).accept);
    expect(bodies).toEqual([true, true]);
  });

  it("behavior=ignore never calls back", async () => {
    const fetchMock = vi.fn();
    const app = build({ behavior: { [PROVIDER]: "ignore" }, delayMs: 0, fetchImpl: fetchMock, log: () => {} });
    const res = await app.inject({ method: "POST", url: "/demo/receive-offer", payload: offer });
    expect(res.json()).toMatchObject({ behavior: "ignore", willRespond: false });
    await app.demo.drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads with 400", async () => {
    const app = build({ delayMs: 0, log: () => {} });
    const res = await app.inject({ method: "POST", url: "/demo/receive-offer", payload: { offerId: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().demo).toBe(DEMO_TAG);
  });

  it("records failed callbacks instead of crashing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = build({ delayMs: 0, fetchImpl: fetchMock, log: () => {} });
    await app.inject({ method: "POST", url: "/demo/receive-offer", payload: offer });
    await app.demo.drain();
    expect(app.demo.responses[0]).toMatchObject({ offerId: offer.offerId, status: null });
    expect(app.demo.responses[0]?.error).toContain("ECONNREFUSED");
  });
});

describe("parseBehaviorEnv", () => {
  it("parses a JSON map and rejects bad values", () => {
    expect(parseBehaviorEnv(undefined)).toEqual({});
    expect(parseBehaviorEnv('{"a":"accept","b":"ignore"}')).toEqual({ a: "accept", b: "ignore" });
    expect(() => parseBehaviorEnv("not json")).toThrow(/DEMO_RECEIVER_BEHAVIOR/);
    expect(() => parseBehaviorEnv('{"a":"maybe"}')).toThrow();
  });
});
