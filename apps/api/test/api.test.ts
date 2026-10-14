import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { createDb, runMigrations, seed, providers, type DbHandle } from "@labordispatch/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let h: DbHandle;
let s: Awaited<ReturnType<typeof seed>>;
let app: FastifyInstance;
const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const webhookCalls: { url: string; body: unknown }[] = [];

/** Fake Claude: always confirms the Essex house, creates an HVAC work order, then says thanks. */
function scriptedClient(): Anthropic {
  let n = 0;
  const steps: Array<{ stop_reason: string; content: unknown[] }> = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "confirm_property", input: { claimed_address_text: "11483 Essex Ave", label: null } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "create_work_order", input: { trade: "hvac", urgency: "urgent", title: "No heat", description: "Furnace not igniting; thermostat batteries replaced.", symptoms: ["no heat"], troubleshooting_performed: ["replaced thermostat batteries"], is_large_project: false } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Thanks, an HVAC technician is being dispatched." }] },
  ];
  return {
    beta: {
      messages: {
        create: async () => {
          const step = steps[Math.min(n++, steps.length - 1)]!;
          return { id: "m", type: "message", role: "assistant", model: "fake", stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 }, ...step };
        },
      },
    },
  } as unknown as Anthropic;
}

beforeAll(async () => {
  h = await createDb({ pgliteDir: "memory://" });
  await runMigrations(h);
  s = await seed(h.db);
  const config = loadConfig({ API_TOKEN: TOKEN, DEMO_MODE: "true", CHATWOOT_API_TOKEN: "cw", CHATWOOT_WEBHOOK_TOKEN: "hook", PUBLIC_URL: "http://api.test" });
  const fetchImpl: typeof fetch = async (url, init) => {
    webhookCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  app = await buildApp({ db: h.db, config, intakeClient: scriptedClient(), fetchImpl, logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

describe("api", () => {
  it("health is open; records need a token", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true, demoMode: true });
    expect((await app.inject({ method: "GET", url: "/providers" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/providers", headers: auth })).statusCode).toBe(200);
  });

  it("direct chat runs intake end-to-end and creates a work order", async () => {
    const res = await app.inject({ method: "POST", url: "/chat/alex-1/messages", headers: auth, payload: { text: "no heat at 11483 Essex Ave", fromPhone: "+15555550101", channel: "sms" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toContain("HVAC");
    expect(body.workOrderId).toBeTruthy();
    const wo = (await app.inject({ method: "GET", url: `/work-orders/${body.workOrderId}`, headers: auth })).json();
    expect(wo.status).toBe("ready_to_dispatch");
    expect(wo.events.some((e: { type: string }) => e.type === "created")).toBe(true);
  });

  it("chatwoot webhook: rejects bad token, ignores outgoing, accepts incoming", async () => {
    expect((await app.inject({ method: "POST", url: "/webhooks/chatwoot?token=nope", payload: { event: "message_created" } })).statusCode).toBe(401);
    const out = await app.inject({ method: "POST", url: "/webhooks/chatwoot?token=hook", payload: { event: "message_created", message_type: "outgoing", content: "hi", conversation: { id: 7 }, account: { id: 1 } } });
    expect(out.json()).toEqual({ ignored: "not incoming" });
    const inc = await app.inject({
      method: "POST",
      url: "/webhooks/chatwoot?token=hook",
      payload: { event: "message_created", id: 991, message_type: "incoming", content: "furnace is dead", account: { id: 1 }, conversation: { id: 42, channel: "Channel::Sms", meta: { sender: { phone_number: "+15555550101" } } } },
    });
    expect(inc.json()).toEqual({ accepted: true });
    // background processing posts the reply back to Chatwoot
    await new Promise((r) => setTimeout(r, 300));
    const reply = webhookCalls.find((c) => c.url.includes("/conversations/42/messages"));
    expect(reply?.body).toMatchObject({ message_type: "outgoing", private: false });
  });

  it("dispatch -> offer delivered to provider webhook -> accept -> hold -> confirm", async () => {
    const hvacUrl = "http://receiver.test/offer";
    await h.db.update(providers).set({ offerWebhookUrl: hvacUrl }).where(eq(providers.id, s.providers.hvac));
    const created = (await app.inject({
      method: "POST", url: "/work-orders", headers: auth,
      payload: { propertyId: s.properties.essex, reportedByPersonId: s.people.alex, trade: "hvac", urgency: "routine", title: "AC weak", description: "Blows but not cold.", symptoms: [], troubleshootingPerformed: ["filter replaced"], isLargeProject: false },
    })).json();
    expect(created.status).toBe("ready_to_dispatch");
    const cands = (await app.inject({ method: "GET", url: `/work-orders/${created.id}/candidates`, headers: auth })).json();
    expect(cands[0].providerId).toBe(s.providers.hvac);
    const d = (await app.inject({ method: "POST", url: `/work-orders/${created.id}/dispatch`, headers: auth })).json();
    expect(d.offers).toHaveLength(1);
    const delivered = webhookCalls.find((c) => c.url === hvacUrl)!;
    expect(delivered.body).toMatchObject({ offerId: d.offers[0].id, trade: "hvac", postalCode: "65807", respondUrl: `http://api.test/offers/${d.offers[0].id}/respond` });
    expect(JSON.stringify(delivered.body)).not.toContain("Essex"); // no exact address before acceptance
    // unauthenticated respond is rejected; authenticated accept works
    expect((await app.inject({ method: "POST", url: `/offers/${d.offers[0].id}/respond`, payload: { accept: true } })).statusCode).toBe(401);
    const acc = (await app.inject({ method: "POST", url: `/offers/${d.offers[0].id}/respond`, headers: auth, payload: { accept: true, note: "on it" } })).json();
    expect(acc.accepted).toBe(true);
    const slots = (await app.inject({ method: "GET", url: `/providers/${s.providers.hvac}/free-slots`, headers: auth })).json();
    expect(slots.length).toBeGreaterThan(0);
    const hold = (await app.inject({ method: "POST", url: `/work-orders/${created.id}/appointments`, headers: auth, payload: { providerId: s.providers.hvac, ...slots[0], requestedByPersonId: s.people.alex } })).json();
    expect(hold.status).toBe("hold");
    const dup = await app.inject({ method: "POST", url: `/work-orders/${created.id}/appointments`, headers: auth, payload: { providerId: s.providers.hvac, ...slots[0] } });
    expect(dup.statusCode).toBe(409);
    const conf = (await app.inject({ method: "POST", url: `/appointments/${hold.id}/confirm`, headers: auth, payload: { confirmedBy: `provider:${s.providers.hvac}` } })).json();
    expect(conf.workOrder.status).toBe("scheduled");
    // complete -> invoice -> dispute (owner-occupant, so owner not separately notified) -> resolve
    await app.inject({ method: "POST", url: `/work-orders/${created.id}/status`, headers: auth, payload: { status: "in_progress" } });
    await app.inject({ method: "POST", url: `/work-orders/${created.id}/status`, headers: auth, payload: { status: "completed" } });
    const inv = (await app.inject({ method: "POST", url: `/work-orders/${created.id}/invoices`, headers: auth, payload: { providerId: s.providers.hvac, lineItems: [{ description: "Capacitor", quantity: 1, unitCents: 18900 }] } })).json();
    expect(inv.totalCents).toBe(18900);
    const disp = (await app.inject({ method: "POST", url: `/invoices/${inv.id}/disputes`, headers: auth, payload: { raisedByPersonId: s.people.alex, reason: "still not cold" } })).json();
    expect(disp.ownerNotifiedAt).toBeNull();
    const resolved = (await app.inject({ method: "POST", url: `/disputes/${disp.id}/resolve`, headers: auth, payload: { outcome: "resolved_for_provider", resolution: "re-visit fixed it" } })).json();
    expect(resolved.status).toBe("resolved_for_provider");
  });

  it("demo routes exist in demo mode and are labeled", async () => {
    const res = await app.inject({ method: "GET", url: "/demo/scenarios/templates", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-labordispatch-demo"]).toContain("DEMO");
    expect(res.json().length).toBeGreaterThanOrEqual(10);
  });
});

describe("error mapping", () => {
  it("malformed ids are 400, unknown ids are 404", async () => {
    const bad = await app.inject({ method: "GET", url: "/work-orders/not-a-uuid", headers: auth });
    expect(bad.statusCode, bad.body).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/work-orders/00000000-0000-4000-8000-000000000000", headers: auth });
    expect(missing.statusCode).toBe(404);
  });
});
