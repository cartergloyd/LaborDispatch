/**
 * Property knowledge: addresses, parties, facts-with-provenance, appliances, warranties, maintenance.
 * Facts are append-only; a new value for the same key supersedes the old row instead of overwriting it.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  appliances,
  maintenanceRecords,
  properties,
  propertyFacts,
  propertyParties,
  warranties,
  type Db,
} from "@labordispatch/db";
import type { AddressInput, FactCategory, FactSource, PartyRole, PropertyFactInput } from "@labordispatch/shared";
import { conflict, notFound } from "./errors.js";

export async function createProperty(
  db: Db,
  input: AddressInput & { isDemo?: boolean; accessNotes?: string | null },
): Promise<typeof properties.$inferSelect> {
  const [row] = await db
    .insert(properties)
    .values({
      line1: input.line1.trim(),
      line2: input.line2?.trim() || null,
      city: input.city.trim(),
      state: input.state.toUpperCase(),
      postalCode: input.postalCode.trim(),
      country: input.country ?? "US",
      nickname: input.nickname ?? null,
      accessNotes: input.accessNotes ?? null,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

export async function getProperty(db: Db, propertyId: string) {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
  if (!row) throw notFound("property");
  return row;
}

export async function addParty(
  db: Db,
  propertyId: string,
  personId: string,
  role: PartyRole,
  isBillingResponsible = false,
) {
  const existing = await db
    .select({ id: propertyParties.id })
    .from(propertyParties)
    .where(
      and(
        eq(propertyParties.propertyId, propertyId),
        eq(propertyParties.personId, personId),
        eq(propertyParties.role, role),
        isNull(propertyParties.endsAt),
      ),
    )
    .limit(1);
  if (existing.length) throw conflict(`person already has active role ${role} on this property`);
  const [row] = await db
    .insert(propertyParties)
    .values({ propertyId, personId, role, isBillingResponsible })
    .returning();
  return row!;
}

/** Tenant moves out / owner sells: end the relationship. Access stops immediately. */
export async function endParty(db: Db, partyId: string) {
  const [row] = await db
    .update(propertyParties)
    .set({ endsAt: new Date() })
    .where(and(eq(propertyParties.id, partyId), isNull(propertyParties.endsAt)))
    .returning();
  if (!row) throw notFound("active party");
  return row;
}

export async function recordFact(
  db: Db,
  propertyId: string,
  input: PropertyFactInput & { recordedByPersonId?: string | null },
) {
  const current = await db
    .select()
    .from(propertyFacts)
    .where(
      and(eq(propertyFacts.propertyId, propertyId), eq(propertyFacts.key, input.key), isNull(propertyFacts.supersededById)),
    )
    .limit(1);
  const [row] = await db
    .insert(propertyFacts)
    .values({
      propertyId,
      category: input.category,
      key: input.key,
      value: input.value as object,
      source: input.source,
      confidence: input.confidence.toFixed(2),
      observedAt: input.observedAt ?? null,
      recordedByPersonId: input.recordedByPersonId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  const prev = current[0];
  if (prev) {
    await db.update(propertyFacts).set({ supersededById: row.id }).where(eq(propertyFacts.id, prev.id));
  }
  return row;
}

/** Current (non-superseded) facts. */
export async function listCurrentFacts(db: Db, propertyId: string, category?: FactCategory) {
  const where = category
    ? and(eq(propertyFacts.propertyId, propertyId), isNull(propertyFacts.supersededById), eq(propertyFacts.category, category))
    : and(eq(propertyFacts.propertyId, propertyId), isNull(propertyFacts.supersededById));
  return db.select().from(propertyFacts).where(where).orderBy(propertyFacts.category, propertyFacts.key);
}

export async function addAppliance(
  db: Db,
  propertyId: string,
  input: {
    kind: string;
    manufacturer?: string | null;
    model?: string | null;
    serialNumber?: string | null;
    locationInHome?: string | null;
    installedAt?: Date | null;
    source?: FactSource;
    confidence?: number;
    notes?: string | null;
  },
) {
  const [row] = await db
    .insert(appliances)
    .values({
      propertyId,
      kind: input.kind,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      serialNumber: input.serialNumber ?? null,
      locationInHome: input.locationInHome ?? null,
      installedAt: input.installedAt ?? null,
      source: input.source ?? "user_stated",
      confidence: (input.confidence ?? 0.5).toFixed(2),
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

export async function listAppliances(db: Db, propertyId: string) {
  return db
    .select()
    .from(appliances)
    .where(and(eq(appliances.propertyId, propertyId), isNull(appliances.retiredAt)))
    .orderBy(appliances.kind);
}

export async function addWarranty(
  db: Db,
  propertyId: string,
  input: {
    provider: string;
    covers: string;
    applianceId?: string | null;
    policyNumber?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    documentUrl?: string | null;
    source?: FactSource;
  },
) {
  const [row] = await db
    .insert(warranties)
    .values({
      propertyId,
      applianceId: input.applianceId ?? null,
      provider: input.provider,
      covers: input.covers,
      policyNumber: input.policyNumber ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      documentUrl: input.documentUrl ?? null,
      source: input.source ?? "user_stated",
    })
    .returning();
  return row!;
}

export async function listWarranties(db: Db, propertyId: string) {
  return db.select().from(warranties).where(eq(warranties.propertyId, propertyId));
}

export async function addMaintenanceRecord(
  db: Db,
  propertyId: string,
  input: typeof maintenanceRecords.$inferInsert extends infer T ? Omit<T, "id" | "propertyId" | "createdAt"> : never,
) {
  const [row] = await db.insert(maintenanceRecords).values({ ...input, propertyId }).returning();
  return row!;
}

export async function listMaintenance(db: Db, propertyId: string) {
  return db
    .select()
    .from(maintenanceRecords)
    .where(eq(maintenanceRecords.propertyId, propertyId))
    .orderBy(desc(maintenanceRecords.performedAt), maintenanceRecords.dueAt);
}

/**
 * Everything the intake agent may know about a property, *excluding* access notes.
 * Unknown stays unknown: we return only recorded facts, never defaults.
 */
export async function propertyKnowledge(db: Db, propertyId: string) {
  const [facts, appl, warr, maint] = await Promise.all([
    listCurrentFacts(db, propertyId),
    listAppliances(db, propertyId),
    listWarranties(db, propertyId),
    listMaintenance(db, propertyId),
  ]);
  const now = Date.now();
  return {
    facts: facts.map((f) => ({
      category: f.category,
      key: f.key,
      value: f.value,
      source: f.source,
      confidence: Number(f.confidence),
      observedAt: f.observedAt?.toISOString() ?? null,
      recordedAt: f.recordedAt.toISOString(),
    })),
    appliances: appl.map((a) => ({
      id: a.id,
      kind: a.kind,
      manufacturer: a.manufacturer,
      model: a.model,
      locationInHome: a.locationInHome,
      installedAt: a.installedAt?.toISOString() ?? null,
      source: a.source,
      confidence: Number(a.confidence),
    })),
    warranties: warr.map((w) => ({
      id: w.id,
      provider: w.provider,
      covers: w.covers,
      applianceId: w.applianceId,
      active: w.endsAt ? w.endsAt.getTime() > now : null,
      endsAt: w.endsAt?.toISOString() ?? null,
    })),
    maintenance: maint.map((m) => ({
      kind: m.kind,
      category: m.category,
      description: m.description,
      performedAt: m.performedAt?.toISOString() ?? null,
      dueAt: m.dueAt?.toISOString() ?? null,
      vendorName: m.vendorName,
    })),
  };
}
