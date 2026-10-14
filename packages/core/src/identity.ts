/**
 * Identity, verification and household authorization.
 *
 * Rules (README "Pre-Dispatch Notes"):
 *  - A phone number is never proof of ownership. We resolve phone -> contact method -> person,
 *    then check explicit, *active* person<->property relationships.
 *  - Trust is time-bounded: a contact verified within VERIFICATION_TRUST_DAYS is "trusted";
 *    older ones must re-verify before any address, access code, or history is disclosed.
 *  - We never read an address back to an unverified caller. They state it; we match it.
 */
import { createHash, randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  contactMethods,
  people,
  properties,
  propertyParties,
  verificationChallenges,
  type Db,
} from "@labordispatch/db";
import { normalizePhone, type ContactMethodKind, type PartyRole } from "@labordispatch/shared";
import { DomainError, forbidden, notFound } from "./errors.js";

export type TrustState = "trusted" | "needs_verification" | "unknown";

export interface ResolvedContact {
  contactMethod: typeof contactMethods.$inferSelect;
  person: typeof people.$inferSelect;
  trust: TrustState;
}

export function normalizeContactValue(kind: ContactMethodKind, raw: string): string | null {
  if (kind === "phone") return normalizePhone(raw);
  const v = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

export function trustStateFor(
  cm: Pick<typeof contactMethods.$inferSelect, "status" | "lastVerifiedAt" | "revokedAt">,
  trustDays: number,
  now = new Date(),
): TrustState {
  if (cm.revokedAt || cm.status === "revoked") return "unknown";
  if (cm.status !== "verified" || !cm.lastVerifiedAt) return "needs_verification";
  const ageMs = now.getTime() - cm.lastVerifiedAt.getTime();
  return ageMs <= trustDays * 86_400_000 ? "trusted" : "needs_verification";
}

export async function resolveContact(
  db: Db,
  kind: ContactMethodKind,
  rawValue: string,
  trustDays: number,
): Promise<ResolvedContact | null> {
  const value = normalizeContactValue(kind, rawValue);
  if (!value) return null;
  const row = await db
    .select({ cm: contactMethods, person: people })
    .from(contactMethods)
    .innerJoin(people, eq(people.id, contactMethods.personId))
    .where(and(eq(contactMethods.kind, kind), eq(contactMethods.value, value), isNull(contactMethods.revokedAt)))
    .limit(1);
  const hit = row[0];
  if (!hit) return null;
  return { contactMethod: hit.cm, person: hit.person, trust: trustStateFor(hit.cm, trustDays) };
}

export interface AuthorizedProperty {
  property: typeof properties.$inferSelect;
  roles: PartyRole[];
  isBillingResponsible: boolean;
}

/** Properties the person currently has an active relationship with. */
export async function listAuthorizedProperties(db: Db, personId: string): Promise<AuthorizedProperty[]> {
  const rows = await db
    .select({ property: properties, role: propertyParties.role, billing: propertyParties.isBillingResponsible })
    .from(propertyParties)
    .innerJoin(properties, eq(properties.id, propertyParties.propertyId))
    .where(and(eq(propertyParties.personId, personId), isNull(propertyParties.endsAt)));
  const byId = new Map<string, AuthorizedProperty>();
  for (const r of rows) {
    const entry = byId.get(r.property.id) ?? { property: r.property, roles: [], isBillingResponsible: false };
    entry.roles.push(r.role);
    entry.isBillingResponsible ||= r.billing;
    byId.set(r.property.id, entry);
  }
  return [...byId.values()];
}

export async function canAccessProperty(db: Db, personId: string, propertyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: propertyParties.id })
    .from(propertyParties)
    .where(
      and(
        eq(propertyParties.personId, personId),
        eq(propertyParties.propertyId, propertyId),
        isNull(propertyParties.endsAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * A non-identifying label safe to show an unverified caller to let them pick between homes:
 * the nickname if set, else "<street name> in <city>" (no house number).
 */
export function redactedPropertyLabel(p: typeof properties.$inferSelect): string {
  if (p.nickname) return p.nickname;
  const street = p.line1.replace(/^\s*\d+[A-Za-z-]*\s+/, "");
  return `${street} in ${p.city}`;
}

export function fullAddress(p: typeof properties.$inferSelect): string {
  return [p.line1, p.line2, `${p.city}, ${p.state} ${p.postalCode}`].filter(Boolean).join(", ");
}

// ---------- knowledge-based verification (caller states the address) ----------

function addressTokens(s: string): { number: string | null; words: Set<string> } {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const m = cleaned.match(/\b(\d{1,6})\b/);
  const stop = new Set(["st", "street", "ave", "avenue", "rd", "road", "dr", "drive", "ln", "lane", "ct", "court", "blvd", "way", "the", "at", "on", "in", "my", "house", "home", "apt", "unit"]);
  const words = new Set(cleaned.split(/\s+/).filter((w) => w && !/^\d+$/.test(w) && !stop.has(w)));
  return { number: m?.[1] ?? null, words };
}

/** True when the claimed text contains the property's house number and at least one street-name word. */
export function addressClaimMatches(claim: string, p: typeof properties.$inferSelect): boolean {
  const c = addressTokens(claim);
  const a = addressTokens(p.line1);
  if (!a.number || c.number !== a.number) return false;
  for (const w of a.words) if (c.words.has(w)) return true;
  return false;
}

/**
 * Caller claims "I'm at 11483 Essex Ave". We match against *their* authorized properties only.
 * On success the contact method is (re-)verified now. Returns the matched property or null.
 */
export async function verifyByAddressClaim(
  db: Db,
  contactMethodId: string,
  personId: string,
  claim: string,
): Promise<AuthorizedProperty | null> {
  const authorized = await listAuthorizedProperties(db, personId);
  const match = authorized.find((ap) => addressClaimMatches(claim, ap.property));
  if (!match) return null;
  await markVerified(db, contactMethodId);
  return match;
}

export async function markVerified(db: Db, contactMethodId: string): Promise<void> {
  await db
    .update(contactMethods)
    .set({ status: "verified", lastVerifiedAt: new Date() })
    .where(eq(contactMethods.id, contactMethodId));
}

export async function revokeContactMethod(db: Db, contactMethodId: string): Promise<void> {
  await db
    .update(contactMethods)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(contactMethods.id, contactMethodId));
}

// ---------- one-time-code verification (web chat proving control of a phone) ----------

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startCodeChallenge(
  db: Db,
  contactMethodId: string,
  ttlMinutes = 10,
): Promise<{ challengeId: string; code: string; expiresAt: Date }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  const [row] = await db
    .insert(verificationChallenges)
    .values({ contactMethodId, codeHash: hash(code), expiresAt })
    .returning();
  if (!row) throw new Error("failed to create challenge");
  return { challengeId: row.id, code, expiresAt };
}

export async function completeCodeChallenge(db: Db, challengeId: string, code: string): Promise<boolean> {
  const [ch] = await db.select().from(verificationChallenges).where(eq(verificationChallenges.id, challengeId)).limit(1);
  if (!ch) throw notFound("verification challenge");
  if (ch.consumedAt) throw new DomainError("challenge already used", "expired", 410);
  if (ch.expiresAt.getTime() < Date.now()) throw new DomainError("challenge expired", "expired", 410);
  if (ch.attempts >= 5) throw forbidden("too many attempts");
  const ok = ch.codeHash === hash(code.trim());
  await db
    .update(verificationChallenges)
    .set({ attempts: sql`${verificationChallenges.attempts} + 1`, consumedAt: ok ? new Date() : null })
    .where(eq(verificationChallenges.id, challengeId));
  if (ok) await markVerified(db, ch.contactMethodId);
  return ok;
}

// ---------- people & contact methods ----------

export async function createPerson(
  db: Db,
  input: { displayName: string; contactMethods?: { kind: ContactMethodKind; value: string }[]; isDemo?: boolean },
): Promise<typeof people.$inferSelect> {
  const [person] = await db
    .insert(people)
    .values({ displayName: input.displayName, isDemo: input.isDemo ?? false })
    .returning();
  if (!person) throw new Error("insert failed");
  for (const [i, cm] of (input.contactMethods ?? []).entries()) {
    await addContactMethod(db, person.id, cm.kind, cm.value, i === 0);
  }
  return person;
}

export async function addContactMethod(
  db: Db,
  personId: string,
  kind: ContactMethodKind,
  rawValue: string,
  isPrimary = false,
): Promise<typeof contactMethods.$inferSelect> {
  const value = normalizeContactValue(kind, rawValue);
  if (!value) throw new DomainError(`invalid ${kind}: ${rawValue}`, "validation");
  const [row] = await db.insert(contactMethods).values({ personId, kind, value, isPrimary }).returning();
  if (!row) throw new Error("insert failed");
  return row;
}

/** Billing-responsible party for a property: explicit flag first, then any owner, then property manager. */
export async function billingPartyFor(db: Db, propertyId: string): Promise<typeof people.$inferSelect | null> {
  const rows = await db
    .select({ person: people, role: propertyParties.role, billing: propertyParties.isBillingResponsible })
    .from(propertyParties)
    .innerJoin(people, eq(people.id, propertyParties.personId))
    .where(and(eq(propertyParties.propertyId, propertyId), isNull(propertyParties.endsAt)));
  const explicit = rows.find((r) => r.billing);
  if (explicit) return explicit.person;
  const owner = rows.find((r) => r.role === "owner");
  if (owner) return owner.person;
  const pm = rows.find((r) => r.role === "property_manager");
  return pm?.person ?? null;
}
