import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DbHandle } from "@labordispatch/db";
import {
  dispatchWorkOrder,
  getAvailability,
  getEstimates,
  getWorkOrderStatus,
  requestBooking,
  requestService,
  searchContractors,
  type ToolResult,
} from "../src/tools.js";

let h: DbHandle;
let s: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  h = await createDb({ pgliteDir: "memory://" });
  await runMigrations(h);
  s = await seed(h.db);
});
afterAll(async () => h.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (r: ToolResult): any => {
  expect(r.isError).toBeFalsy();
  expect(r.content[0]?.type).toBe("text");
  return JSON.parse(r.content[0]!.text);
};

describe("search_contractors", () => {
  it("finds the seeded plumber for 65807 / plumbing and never leaks contact details", async () => {
    const out = parse(await searchContractors(h.db, { postalCode: "65807", trade: "plumbing" }));
    const ids = out.providers.map((p: { providerId: string }) => p.providerId);
    expect(ids).toContain(s.providers.plumber);
    // handyman is a fallback for any trade; HVAC-only shop must not appear
    expect(ids).toContain(s.providers.handyman);
    expect(ids).not.toContain(s.providers.hvac);
    expect(out.providers[0].providerId).toBe(s.providers.plumber); // exact trade match ranks first
    for (const p of out.providers) {
      expect(p).not.toHaveProperty("phone");
      expect(p).not.toHaveProperty("email");
      expect(p).not.toHaveProperty("contactName");
      expect(p.licenseVerified).toBe(true);
      expect(p.insuranceVerified).toBe(true);
    }
  });

  it("filters by emergency and postal code", async () => {
    const emergency = parse(await searchContractors(h.db, { postalCode: "65807", trade: "appliance_repair", emergency: true }));
    // handyman does appliance_repair but does not accept emergencies
    expect(emergency.providers.map((p: { providerId: string }) => p.providerId)).not.toContain(s.providers.handyman);
    const elsewhere = parse(await searchContractors(h.db, { postalCode: "99999", trade: "plumbing" }));
    expect(elsewhere.count).toBe(0);
  });
});

describe("request_service -> dispatch_work_order", () => {
  let workOrderId: string;

  it("creates a work order for the owner-occupied Essex house and makes it ready to dispatch", async () => {
    const out = parse(
      await requestService(h.db, {
        propertyId: s.properties.essex,
        reportedByPersonId: s.people.alex,
        trade: "plumbing",
        urgency: "urgent",
        title: "Kitchen sink leaking under cabinet",
        description: "Steady drip from P-trap joint; towel soaked overnight.",
        symptoms: ["drip under sink", "water stain on cabinet floor"],
        troubleshootingPerformed: ["tightened slip nut by hand"],
        isLargeProject: false,
      }),
    );
    expect(out.workOrderId).toMatch(/[0-9a-f-]{36}/);
    expect(out.status).toBe("ready_to_dispatch");
    expect(out.ownerApprovalPending).toBe(false);
    workOrderId = out.workOrderId;
  });

  it("dispatches to the plumber and reports the offer", async () => {
    const out = parse(await dispatchWorkOrder(h.db, { workOrderId }));
    expect(out.status).toBe("offered");
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0].providerId).toBe(s.providers.plumber);
    expect(new Date(out.offers[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("reports status with offers and recent events, without contact details", async () => {
    const out = parse(await getWorkOrderStatus(h.db, { workOrderId }));
    expect(out.workOrder.status).toBe("offered");
    expect(out.workOrder.trade).toBe("plumbing");
    expect(out.offers).toHaveLength(1);
    expect(out.recentEvents.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["created", "status_changed", "offer_sent"]),
    );
    expect(out.workOrder).not.toHaveProperty("accessNotes");
    expect(out.workOrder).not.toHaveProperty("billingPersonId");
  });

  it("places a hold from a free slot and labels it as unconfirmed", async () => {
    const avail = parse(await getAvailability(h.db, { providerId: s.providers.plumber }));
    expect(avail.slots.length).toBeGreaterThan(0);
    expect(avail.slots.length).toBeLessThanOrEqual(8);
    const slot = avail.slots[0];
    const hold = parse(
      await requestBooking(h.db, {
        workOrderId,
        providerId: s.providers.plumber,
        startsAtIso: slot.startsAt,
        endsAtIso: slot.endsAt,
        requestedByPersonId: s.people.alex,
      }),
    );
    expect(hold.status).toBe("hold");
    expect(hold.confirmed).toBe(false);
    expect(hold.holdExpiresAt).toBeTruthy();

    // The same slot is now taken.
    const clash = await requestBooking(h.db, {
      workOrderId,
      providerId: s.providers.plumber,
      startsAtIso: slot.startsAt,
      endsAtIso: slot.endsAt,
    });
    expect(clash.isError).toBe(true);
    expect(clash.content[0]!.text).toMatch(/conflict/);
  });

  it("returns an empty estimate list and a DomainError for unknown ids", async () => {
    const est = parse(await getEstimates(h.db, { workOrderId }));
    expect(est.count).toBe(0);
    const missing = await getWorkOrderStatus(h.db, { workOrderId: "00000000-0000-0000-0000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toMatch(/not_found/);
  });
});
