// DEMO ONLY - remove before production
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contactMethods, createDb, demoScenarios, runMigrations, seed, type DbHandle } from "@labordispatch/db";
import { DEMO_TAG, TRADES, URGENCIES } from "@labordispatch/shared";
import { generateScenario, listScenarioTemplates, recordOutcome, recordScenario, SEED_PHONES } from "../src/index.js";

describe("scenario templates", () => {
  const templates = listScenarioTemplates();

  it("has at least 10 realistic templates with valid enums and unique labels", () => {
    expect(templates.length).toBeGreaterThanOrEqual(10);
    expect(new Set(templates.map((t) => t.label)).size).toBe(templates.length);
    for (const t of templates) {
      expect(TRADES).toContain(t.expected.trade);
      expect(URGENCIES).toContain(t.expected.urgency);
      expect(t.openingMessage.length).toBeGreaterThan(5);
      expect(t.variant).toBe("A");
    }
  });

  it("covers every README edge case", () => {
    const byLabel = Object.fromEntries(templates.map((t) => [t.label, t]));
    expect(byLabel.no_hot_water_tenant?.fromPhone).toBe(SEED_PHONES.logan);
    expect(byLabel.no_hot_water_tenant?.expected.shouldRequireOwnerApproval).toBe(true);
    expect(byLabel.furnace_short_cycling?.fromPhone).toBe(SEED_PHONES.alex);
    expect(byLabel.roof_leak_after_storm?.expected.isLargeProject).toBe(true);
    expect(byLabel.prompt_injection_water_heater?.openingMessage.toLowerCase()).toContain("ignore your instructions");
    expect(byLabel.pat_which_house?.persona).toBe("two_homes");
    expect(byLabel.pat_which_house?.expected.shouldVerifyFirst).toBe(true);
    expect(byLabel.stranger_gate_code?.persona).toBe("stranger");
    expect(byLabel.stranger_gate_code?.fromPhone).toBe(SEED_PHONES.sam);
    expect(byLabel.stranger_gate_code?.expected.shouldVerifyFirst).toBe(true);
    expect(byLabel.vague_ac_problem?.expected.trade).toBe("hvac");
    const personas = new Set(templates.map((t) => t.persona));
    expect([...personas].sort()).toEqual(["owner_occupant", "stale_verification", "stranger", "tenant", "two_homes"]);
  });

  it("returns fresh copies", () => {
    const a = listScenarioTemplates();
    a[0]!.followUps.push("mutated");
    expect(listScenarioTemplates()[0]!.followUps).not.toContain("mutated");
  });
});

describe("generateScenario", () => {
  it("is deterministic for a seed", () => {
    for (const seed of [0, 1, 42, 123456, 0xffffffff]) {
      expect(generateScenario(seed)).toEqual(generateScenario(seed));
    }
  });

  it("varies template, variant, and wording across seeds", () => {
    const out = Array.from({ length: 200 }, (_, i) => generateScenario(i));
    expect(new Set(out.map((s) => s.label)).size).toBeGreaterThan(5);
    expect(new Set(out.map((s) => s.variant))).toEqual(new Set(["A", "B"]));
    const labels = new Set(listScenarioTemplates().map((t) => t.label));
    for (const s of out) {
      expect(labels.has(s.label)).toBe(true);
      expect(Object.values(SEED_PHONES)).toContain(s.fromPhone);
    }
  });

  it("works without a seed", () => {
    const s = generateScenario();
    expect(["A", "B"]).toContain(s.variant);
  });
});

describe("against a seeded database", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createDb({ pgliteDir: "memory://" });
    await runMigrations(h);
    await seed(h.db);
  });
  afterAll(async () => h.close());

  it("every template phone exists in the seed", async () => {
    const phones = [...new Set(listScenarioTemplates().map((t) => t.fromPhone))];
    for (const phone of phones) {
      const rows = await h.db.select().from(contactMethods).where(eq(contactMethods.value, phone));
      expect(rows.length, `phone ${phone} missing from seed`).toBe(1);
    }
  });

  it("records a scenario and its outcome, tagged DEMO", async () => {
    const scenario = generateScenario(7);
    const row = await recordScenario(h.db, scenario);
    expect(row.label).toBe(scenario.label);
    expect(row.variant).toBe(scenario.variant);
    expect((row.scenario as { demoTag: string }).demoTag).toBe(DEMO_TAG);
    expect(row.outcome).toBeNull();

    const upd = await recordOutcome(h.db, row.id, { trade: "plumbing", passed: true });
    expect(upd?.outcome).toMatchObject({ trade: "plumbing", passed: true, demoTag: DEMO_TAG });

    const [stored] = await h.db.select().from(demoScenarios).where(eq(demoScenarios.id, row.id));
    expect(stored?.outcome).toMatchObject({ passed: true });
    expect(await recordOutcome(h.db, "00000000-0000-0000-0000-000000000000", {})).toBeUndefined();
  });
});
