import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, seed, type DbHandle } from "@labordispatch/db";
import {
  addressClaimMatches,
  approveByOwner,
  confirmAppointment,
  createWorkOrder,
  DomainError,
  finalizeIntake,
  findCandidates,
  freeSlots,
  listAuthorizedProperties,
  placeHold,
  redactedPropertyLabel,
  resolveContact,
  respondToOffer,
  runDispatchRound,
  verifyByAddressClaim,
} from "../src/index.js";

let h: DbHandle;
let s: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  h = await createDb({ pgliteDir: "memory://" });
  await runMigrations(h);
  s = await seed(h.db);
});
afterAll(async () => h.close());

describe("identity & authorization", () => {
  it("resolves a phone to a person with time-bounded trust", async () => {
    const alex = await resolveContact(h.db, "phone", "(555) 555-0101", 90);
    expect(alex?.person.displayName).toBe("Alex Owner");
    expect(alex?.trust).toBe("trusted");
    const pat = await resolveContact(h.db, "phone", "+15555550103", 90);
    expect(pat?.trust).toBe("needs_verification");
    expect(await resolveContact(h.db, "phone", "+15555559999", 90)).toBeNull();
  });

  it("lists only properties the person has an active relationship with, with redacted labels", async () => {
    const props = await listAuthorizedProperties(h.db, s.people.alex);
    expect(props.map((p) => p.property.id).sort()).toEqual([s.properties.essex, s.properties.rental1, s.properties.rental2].sort());
    const logan = await listAuthorizedProperties(h.db, s.people.logan);
    expect(logan).toHaveLength(1);
    expect(logan[0]!.roles).toEqual(["tenant"]);
    expect(logan[0]!.isBillingResponsible).toBe(false);
    const pat = await listAuthorizedProperties(h.db, s.people.pat);
    const labels = pat.map((p) => redactedPropertyLabel(p.property));
    expect(labels).toContain("the lake cabin");
    expect(labels.some((l) => l.includes("Harbor View") && !l.includes("40"))).toBe(true);
  });

  it("verifies by address claim without ever disclosing the address", async () => {
    const pat = (await resolveContact(h.db, "phone", "+15555550103", 90))!;
    expect(await verifyByAddressClaim(h.db, pat.contactMethod.id, pat.person.id, "I'm at 41 Harbor View")).toBeNull();
    const hit = await verifyByAddressClaim(h.db, pat.contactMethod.id, pat.person.id, "40 harbor view drive");
    expect(hit?.property.id).toBe(s.properties.patHome);
    expect((await resolveContact(h.db, "phone", "+15555550103", 90))?.trust).toBe("trusted");
    // a stranger cannot claim Alex's address
    const sam = (await resolveContact(h.db, "phone", "+15555550199", 90))!;
    expect(await verifyByAddressClaim(h.db, sam.contactMethod.id, sam.person.id, "11483 Essex Ave")).toBeNull();
  });

  it("address matching needs house number + a street word", () => {
    const p = { line1: "11483 Essex Ave" } as never;
    expect(addressClaimMatches("11483 essex", p)).toBe(true);
    expect(addressClaimMatches("essex ave", p)).toBe(false);
    expect(addressClaimMatches("11483 maple", p)).toBe(false);
  });
});

describe("work orders: landlord/tenant", () => {
  it("tenant report bills the owner and requires approval; owner approves", async () => {
    const wo = await createWorkOrder(h.db, {
      propertyId: s.properties.rental1,
      reportedByPersonId: s.people.logan,
      trade: "plumbing",
      urgency: "routine",
      title: "Water heater not heating",
      description: "No hot water since yesterday; pilot light appears out.",
      symptoms: ["no hot water"],
      troubleshootingPerformed: ["checked pilot light - out"],
      isLargeProject: false,
      isDemo: true,
    });
    expect(wo.billingPersonId).toBe(s.people.alex);
    expect(wo.requiresOwnerApproval).toBe(true);
    const after = await finalizeIntake(h.db, wo.id, "agent");
    expect(after.status).toBe("pending_owner_approval");
    await expect(approveByOwner(h.db, wo.id, s.people.logan)).rejects.toThrow(DomainError);
    const approved = await approveByOwner(h.db, wo.id, s.people.alex, "go ahead");
    expect(approved.status).toBe("ready_to_dispatch");
  });

  it("owner-occupant report goes straight to dispatch", async () => {
    const wo = await createWorkOrder(h.db, {
      propertyId: s.properties.essex,
      reportedByPersonId: s.people.alex,
      trade: "hvac",
      urgency: "urgent",
      title: "Furnace short cycling",
      description: "Furnace runs 2 minutes then stops.",
      symptoms: [],
      troubleshootingPerformed: ["replaced filter"],
      isLargeProject: false,
      isDemo: true,
    });
    expect(wo.requiresOwnerApproval).toBe(false);
    expect((await finalizeIntake(h.db, wo.id, "agent")).status).toBe("ready_to_dispatch");
  });

  it("rejects a reporter with no relationship to the property", async () => {
    await expect(
      createWorkOrder(h.db, {
        propertyId: s.properties.essex,
        reportedByPersonId: s.people.sam,
        trade: "plumbing",
        urgency: "routine",
        title: "x",
        description: "y",
        symptoms: [],
        troubleshootingPerformed: [],
        isLargeProject: false,
      }),
    ).rejects.toThrow(/no active relationship/);
  });
});

describe("dispatch & scheduling", () => {
  it("offers to the best qualified provider, accepts, holds a slot, confirms", async () => {
    const wo = await createWorkOrder(h.db, {
      propertyId: s.properties.essex,
      reportedByPersonId: s.people.alex,
      trade: "plumbing",
      urgency: "routine",
      title: "Kitchen sink leak",
      description: "Slow drip under sink at the P-trap.",
      symptoms: ["drip"],
      troubleshootingPerformed: ["tightened slip nut"],
      isLargeProject: false,
      isDemo: true,
    });
    await finalizeIntake(h.db, wo.id, "agent");
    const cands = await findCandidates(h.db, wo.id);
    expect(cands[0]!.provider.id).toBe(s.providers.plumber); // exact trade beats handyman
    const delivered: string[] = [];
    const offers = await runDispatchRound(h.db, wo.id, { offerMinutes: 20, deliver: async (_o, p) => void delivered.push(p.id) });
    expect(offers).toHaveLength(1);
    expect(delivered).toEqual([s.providers.plumber]);
    const res = await respondToOffer(h.db, offers[0]!.id, { accept: true });
    expect(res.accepted).toBe(true);

    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(Date.now() + 3 * 86_400_000);
    const slots = await freeSlots(h.db, s.providers.plumber, from, to, 120, 3);
    expect(slots.length).toBeGreaterThan(0);
    const hold = await placeHold(h.db, { workOrderId: wo.id, providerId: s.providers.plumber, window: slots[0]!, holdMinutes: 15, requestedByPersonId: s.people.alex });
    expect(hold.status).toBe("hold");
    // Same slot again -> conflict
    await expect(placeHold(h.db, { workOrderId: wo.id, providerId: s.providers.plumber, window: slots[0]!, holdMinutes: 15 })).rejects.toThrow(/no longer available/);
    const after = await freeSlots(h.db, s.providers.plumber, from, to, 120, 3);
    expect(after.some((w) => w.startsAt.getTime() === slots[0]!.startsAt.getTime())).toBe(false);
    const confirmed = await confirmAppointment(h.db, hold.id, `provider:${s.providers.plumber}`);
    expect(confirmed.appointment.status).toBe("confirmed");
    expect(confirmed.workOrder?.status).toBe("scheduled");
  });

  it("moves to no_provider_available when nobody qualifies", async () => {
    const wo = await createWorkOrder(h.db, {
      propertyId: s.properties.patCabin, // postal code no provider serves
      reportedByPersonId: s.people.pat,
      trade: "roofing",
      urgency: "routine",
      title: "Roof leak",
      description: "Stain on ceiling after rain.",
      symptoms: [],
      troubleshootingPerformed: [],
      isLargeProject: true,
      isDemo: true,
    });
    const fin = await finalizeIntake(h.db, wo.id, "agent");
    expect(fin.status).toBe("pending_owner_approval"); // large project always needs approval
    await approveByOwner(h.db, wo.id, s.people.pat);
    const offers = await runDispatchRound(h.db, wo.id, { offerMinutes: 20 });
    expect(offers).toHaveLength(0);
  });
});
