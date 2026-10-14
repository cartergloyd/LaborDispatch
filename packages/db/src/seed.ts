/**
 * Seed data mirroring the README edge cases. Everything here is flagged is_demo = true.
 *
 *  - Alex owns and lives at 11483 Essex Ave, and owns two rentals. Logan is the tenant in one.
 *    Logan reporting a problem -> work order bills to Alex and needs Alex's approval.
 *  - Pat (Alex's dad) owns a primary home and a vacation home -> must confirm which one.
 *  - Three providers (plumber, HVAC, handyman) serving the same postal codes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  appliances,
  contactMethods,
  maintenanceRecords,
  people,
  properties,
  propertyFacts,
  propertyParties,
  providerAvailability,
  providers,
  warranties,
} from "./schema.js";

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000);

export interface SeedResult {
  people: Record<"alex" | "logan" | "pat" | "sam", string>;
  properties: Record<"essex" | "rental1" | "rental2" | "patHome" | "patCabin", string>;
  providers: Record<"plumber" | "hvac" | "handyman", string>;
}

export async function seed(db: Db): Promise<SeedResult> {
  const existing = await db.select({ id: people.id }).from(people).where(eq(people.displayName, "Alex Owner")).limit(1);
  if (existing.length) throw new Error("seed already applied (Alex Owner exists)");

  const person = async (displayName: string, phone: string, verifiedDaysAgo: number | null) => {
    const [p] = await db.insert(people).values({ displayName, isDemo: true }).returning();
    await db.insert(contactMethods).values({
      personId: p!.id,
      kind: "phone",
      value: phone,
      isPrimary: true,
      status: verifiedDaysAgo === null ? "unverified" : "verified",
      lastVerifiedAt: verifiedDaysAgo === null ? null : daysAgo(verifiedDaysAgo),
    });
    return p!.id;
  };
  const alex = await person("Alex Owner", "+15555550101", 10);
  const logan = await person("Logan Tenant", "+15555550102", 5);
  const pat = await person("Pat Senior", "+15555550103", 400); // verified long ago -> must re-verify
  const sam = await person("Sam Stranger", "+15555550199", null); // knows nobody's address

  const prop = async (v: Partial<typeof properties.$inferInsert> & Pick<typeof properties.$inferInsert, "line1" | "city" | "state" | "postalCode">) => {
    const [p] = await db.insert(properties).values({ ...v, isDemo: true }).returning();
    return p!.id;
  };
  const essex = await prop({ line1: "11483 Essex Ave", city: "Springfield", state: "MO", postalCode: "65807", nickname: "Essex Ave house", accessNotes: "Garage keypad 4471 (DEMO)" });
  const rental1 = await prop({ line1: "2208 Maple Ct", city: "Springfield", state: "MO", postalCode: "65807", nickname: "Maple Ct rental" });
  const rental2 = await prop({ line1: "915 Birch Ln", line2: "Unit B", city: "Springfield", state: "MO", postalCode: "65810", nickname: "Birch Ln duplex" });
  const patHome = await prop({ line1: "40 Harbor View Dr", city: "Branson", state: "MO", postalCode: "65616" });
  const patCabin = await prop({ line1: "7 Lakeshore Trail", city: "Shell Knob", state: "MO", postalCode: "65747", nickname: "the lake cabin" });

  await db.insert(propertyParties).values([
    { propertyId: essex, personId: alex, role: "owner", isBillingResponsible: true },
    { propertyId: essex, personId: alex, role: "resident" },
    { propertyId: rental1, personId: alex, role: "owner", isBillingResponsible: true },
    { propertyId: rental1, personId: logan, role: "tenant" },
    { propertyId: rental2, personId: alex, role: "owner", isBillingResponsible: true },
    { propertyId: patHome, personId: pat, role: "owner", isBillingResponsible: true },
    { propertyId: patHome, personId: pat, role: "resident" },
    { propertyId: patCabin, personId: pat, role: "owner", isBillingResponsible: true },
  ]);

  await db.insert(propertyFacts).values([
    { propertyId: essex, category: "roof", key: "roof.installed_year", value: 2011, source: "document", confidence: "0.95", recordedByPersonId: alex },
    { propertyId: essex, category: "roof", key: "roof.material", value: "architectural asphalt shingle", source: "owner_stated", confidence: "0.80", recordedByPersonId: alex },
    { propertyId: essex, category: "hvac", key: "hvac.last_service", value: daysAgo(200).toISOString().slice(0, 10), source: "technician_observed", confidence: "0.90" },
    { propertyId: rental1, category: "water_heater", key: "water_heater.type", value: "gas tank, 40 gal", source: "owner_stated", confidence: "0.70", recordedByPersonId: alex },
    { propertyId: rental1, category: "water_heater", key: "water_heater.installed_year", value: 2019, source: "owner_stated", confidence: "0.70", recordedByPersonId: alex },
    { propertyId: rental1, category: "access", key: "access.pets", value: "one dog, friendly", source: "user_stated", confidence: "0.60", recordedByPersonId: logan },
  ]);

  const [furnace] = await db.insert(appliances).values({ propertyId: essex, kind: "furnace", manufacturer: "Carrier", model: "59SC5A", installedAt: daysAgo(6 * 365), source: "document", confidence: "0.95" }).returning();
  const [wh] = await db.insert(appliances).values({ propertyId: rental1, kind: "water_heater", manufacturer: "Rheem", model: "XG40T06EC36U1", installedAt: daysAgo(5 * 365), source: "owner_stated", confidence: "0.70" }).returning();
  await db.insert(appliances).values({ propertyId: rental1, kind: "range", manufacturer: "GE", source: "user_stated", confidence: "0.50" });

  await db.insert(warranties).values([
    { propertyId: essex, applianceId: furnace!.id, provider: "Carrier", covers: "heat exchanger (parts)", startsAt: daysAgo(6 * 365), endsAt: daysAhead(4 * 365), source: "document" },
    { propertyId: rental1, applianceId: wh!.id, provider: "Rheem", covers: "tank + parts", startsAt: daysAgo(5 * 365), endsAt: daysAhead(365), source: "owner_stated" },
  ]);

  await db.insert(maintenanceRecords).values([
    { propertyId: essex, applianceId: furnace!.id, kind: "completed", category: "hvac", description: "Annual furnace tune-up", performedAt: daysAgo(200), costCents: 14900, vendorName: "Ozark Comfort HVAC", source: "document" },
    { propertyId: essex, kind: "recommended", category: "gutters", description: "Gutter cleaning before fall", dueAt: daysAhead(30), source: "system_derived" },
    { propertyId: rental1, applianceId: wh!.id, kind: "recommended", category: "water_heater", description: "Flush water heater tank (annual)", dueAt: daysAhead(10), source: "system_derived" },
  ]);

  const provider = async (v: Partial<typeof providers.$inferInsert> & Pick<typeof providers.$inferInsert, "businessName">) => {
    const [p] = await db
      .insert(providers)
      .values({
        status: "active",
        servicePostalCodes: ["65807", "65810", "65616"],
        licenseVerifiedAt: daysAgo(30),
        licenseExpiresAt: daysAhead(300),
        insuranceVerifiedAt: daysAgo(30),
        insuranceExpiresAt: daysAhead(200),
        isDemo: true,
        ...v,
      })
      .returning();
    // Availability: next 7 days, 8am-5pm local.
    const rows = [];
    for (let d = 1; d <= 7; d++) {
      const day = new Date(); day.setDate(day.getDate() + d); day.setHours(8, 0, 0, 0);
      const end = new Date(day); end.setHours(17, 0, 0, 0);
      rows.push({ providerId: p!.id, startsAt: day, endsAt: end });
    }
    await db.insert(providerAvailability).values(rows);
    return p!.id;
  };
  const plumber = await provider({ businessName: "Queen City Plumbing (DEMO)", contactName: "Dana", phone: "+15555550201", trades: ["plumbing"], rating: "4.80", jobsCompleted: 120, acceptsEmergencies: true });
  const hvac = await provider({ businessName: "Ozark Comfort HVAC (DEMO)", contactName: "Chris", phone: "+15555550202", trades: ["hvac"], rating: "4.60", jobsCompleted: 80, acceptsEmergencies: true });
  const handyman = await provider({ businessName: "Fix-It Fast Handyman (DEMO)", contactName: "Morgan", phone: "+15555550203", trades: ["general_handyman", "appliance_repair"], rating: "4.30", jobsCompleted: 35 });

  return {
    people: { alex, logan, pat, sam },
    properties: { essex, rental1, rental2, patHome, patCabin },
    providers: { plumber, hvac, handyman },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const handle = await createDb();
  await runMigrations(handle);
  const r = await seed(handle.db);
  console.error("Seeded demo data (ids below as JSON):");
  console.log(JSON.stringify(r, null, 2));
  await handle.close();
}
