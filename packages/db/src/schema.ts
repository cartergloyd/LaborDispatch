/**
 * LaborDispatch database schema (PostgreSQL dialect).
 *
 * Design principles from the README:
 *  - A phone number is NOT proof of identity. People, contact methods, properties and the
 *    relationships between them are explicit, and verification is time-bounded.
 *  - Facts about a property carry source, date and confidence; unknown stays unknown.
 *  - Landlord/tenant: the reporter and the billing-responsible party can differ.
 *  - Everything demo-generated is flagged `isDemo` so it can be purged before production.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  APPOINTMENT_STATUSES,
  CONTACT_METHOD_KINDS,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATUSES,
  DISPUTE_STATUSES,
  ESTIMATE_STATUSES,
  FACT_CATEGORIES,
  FACT_SOURCES,
  INVOICE_STATUSES,
  MAINTENANCE_KINDS,
  MESSAGE_DIRECTIONS,
  OFFER_STATUSES,
  PARTY_ROLES,
  PROVIDER_STATUSES,
  TRADES,
  URGENCIES,
  VERIFICATION_STATUSES,
  WORK_ORDER_STATUSES,
} from "@labordispatch/shared";

// ---------- enums ----------
export const contactMethodKind = pgEnum("contact_method_kind", CONTACT_METHOD_KINDS);
export const verificationStatus = pgEnum("verification_status", VERIFICATION_STATUSES);
export const partyRole = pgEnum("party_role", PARTY_ROLES);
export const factSource = pgEnum("fact_source", FACT_SOURCES);
export const factCategory = pgEnum("fact_category", FACT_CATEGORIES);
export const trade = pgEnum("trade", TRADES);
export const urgency = pgEnum("urgency", URGENCIES);
export const workOrderStatus = pgEnum("work_order_status", WORK_ORDER_STATUSES);
export const offerStatus = pgEnum("offer_status", OFFER_STATUSES);
export const appointmentStatus = pgEnum("appointment_status", APPOINTMENT_STATUSES);
export const providerStatus = pgEnum("provider_status", PROVIDER_STATUSES);
export const estimateStatus = pgEnum("estimate_status", ESTIMATE_STATUSES);
export const invoiceStatus = pgEnum("invoice_status", INVOICE_STATUSES);
export const disputeStatus = pgEnum("dispute_status", DISPUTE_STATUSES);
export const conversationChannel = pgEnum("conversation_channel", CONVERSATION_CHANNELS);
export const conversationStatus = pgEnum("conversation_status", CONVERSATION_STATUSES);
export const messageDirection = pgEnum("message_direction", MESSAGE_DIRECTIONS);
export const maintenanceKind = pgEnum("maintenance_kind", MAINTENANCE_KINDS);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const isDemo = () => boolean("is_demo").notNull().default(false);

// ---------- identity ----------
export const people = pgTable("people", {
  id: id(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  isDemo: isDemo(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contactMethods = pgTable(
  "contact_methods",
  {
    id: id(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    kind: contactMethodKind("kind").notNull(),
    /** E.164 for phones, lowercase for emails. */
    value: text("value").notNull(),
    status: verificationStatus("status").notNull().default("unverified"),
    /** Last time this contact method proved control (OTP, callback, etc). */
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    /** Set when a number is reassigned or the person says they no longer use it. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One *active* owner per phone/email. Partial index so a revoked number can be re-registered.
    uniqueIndex("contact_methods_active_value_uq")
      .on(t.kind, t.value)
      .where(sql`${t.revokedAt} IS NULL`),
    index("contact_methods_person_idx").on(t.personId),
  ],
);

export const verificationChallenges = pgTable(
  "verification_challenges",
  {
    id: id(),
    contactMethodId: uuid("contact_method_id")
      .notNull()
      .references(() => contactMethods.id, { onDelete: "cascade" }),
    /** sha256 of the one-time code; never store the code itself. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("verification_challenges_cm_idx").on(t.contactMethodId)],
);

// ---------- properties ----------
export const properties = pgTable(
  "properties",
  {
    id: id(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("US"),
    lat: numeric("lat", { precision: 9, scale: 6 }),
    lng: numeric("lng", { precision: 9, scale: 6 }),
    /** Friendly label like "Essex Ave house" or "Lake cabin" - used to disambiguate in chat. */
    nickname: text("nickname"),
    /** Gate codes, lockbox etc. Only disclosed to a dispatched provider, never echoed in chat. */
    accessNotes: text("access_notes"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("properties_postal_idx").on(t.postalCode)],
);

export const propertyParties = pgTable(
  "property_parties",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: partyRole("role").notNull(),
    /** Who gets the invoice / approves spend. Usually the owner; may be a property manager. */
    isBillingResponsible: boolean("is_billing_responsible").notNull().default(false),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when a tenant moves out or an owner sells. Ended relationships grant no access. */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("property_parties_active_uq")
      .on(t.propertyId, t.personId, t.role)
      .where(sql`${t.endsAt} IS NULL`),
    index("property_parties_person_idx").on(t.personId),
  ],
);

/**
 * Append-only knowledge about a property. Superseding a fact sets `supersededById` on the old row
 * rather than editing it, so history (and who said what, when) is preserved.
 */
export const propertyFacts = pgTable(
  "property_facts",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    category: factCategory("category").notNull(),
    /** e.g. "roof.installed_year", "hvac.brand", "water_heater.type" */
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    source: factSource("source").notNull(),
    /** 0..1 */
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    recordedAt: createdAt(),
    recordedByPersonId: uuid("recorded_by_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    supersededById: uuid("superseded_by_id"),
  },
  (t) => [index("property_facts_prop_key_idx").on(t.propertyId, t.key)],
);

export const appliances = pgTable(
  "appliances",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // water_heater, furnace, ac, fridge, range, dishwasher, washer, dryer...
    manufacturer: text("manufacturer"),
    model: text("model"),
    serialNumber: text("serial_number"),
    locationInHome: text("location_in_home"),
    installedAt: timestamp("installed_at", { withTimezone: true }),
    source: factSource("source").notNull().default("user_stated"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.50"),
    notes: text("notes"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("appliances_property_idx").on(t.propertyId)],
);

export const warranties = pgTable(
  "warranties",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    applianceId: uuid("appliance_id").references(() => appliances.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    policyNumber: text("policy_number"),
    covers: text("covers").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    documentUrl: text("document_url"),
    source: factSource("source").notNull().default("user_stated"),
    createdAt: createdAt(),
  },
  (t) => [index("warranties_property_idx").on(t.propertyId)],
);

export const maintenanceRecords = pgTable(
  "maintenance_records",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    applianceId: uuid("appliance_id").references(() => appliances.id, { onDelete: "set null" }),
    workOrderId: uuid("work_order_id"),
    kind: maintenanceKind("kind").notNull(),
    category: factCategory("category").notNull().default("general"),
    description: text("description").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    costCents: integer("cost_cents"),
    vendorName: text("vendor_name"),
    source: factSource("source").notNull().default("user_stated"),
    createdAt: createdAt(),
  },
  (t) => [index("maintenance_property_idx").on(t.propertyId)],
);

// ---------- conversations ----------
export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    channel: conversationChannel("channel").notNull(),
    /** Chatwoot conversation id (or demo id). */
    externalId: text("external_id"),
    externalAccountId: text("external_account_id"),
    /** The raw inbound identifier (E.164 phone or web identifier) before identity resolution. */
    inboundIdentifier: text("inbound_identifier"),
    contactMethodId: uuid("contact_method_id").references(() => contactMethods.id, {
      onDelete: "set null",
    }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    workOrderId: uuid("work_order_id"),
    status: conversationStatus("status").notNull().default("open"),
    /** Agent working memory (confirmed property, verification state, gathered facts). */
    state: jsonb("state").notNull().default({}),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_external_uq").on(t.channel, t.externalAccountId, t.externalId),
    index("conversations_person_idx").on(t.personId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: messageDirection("direction").notNull(),
    body: text("body").notNull(),
    externalId: text("external_id"),
    /** Full Claude content blocks for assistant turns (tool_use etc.), so history can be replayed. */
    llmContent: jsonb("llm_content"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("messages_external_uq")
      .on(t.conversationId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  ],
);

// ---------- work orders ----------
export const workOrders = pgTable(
  "work_orders",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    /** Who raised it (tenant/resident/owner). */
    reportedByPersonId: uuid("reported_by_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** Who pays / approves. Derived from property_parties.is_billing_responsible at creation. */
    billingPersonId: uuid("billing_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    trade: trade("trade").notNull(),
    urgency: urgency("urgency").notNull().default("routine"),
    status: workOrderStatus("status").notNull().default("intake"),
    title: text("title").notNull(),
    /** Factual summary written by the agent - symptoms and observations, not the reporter's demands. */
    description: text("description").notNull(),
    symptoms: jsonb("symptoms").notNull().default([]),
    troubleshootingPerformed: jsonb("troubleshooting_performed").notNull().default([]),
    /** Roof leaks, structural issues, anything likely >$ threshold - needs extra scrutiny. */
    isLargeProject: boolean("is_large_project").notNull().default(false),
    /** True when reporter != billing party (typical rental). */
    requiresOwnerApproval: boolean("requires_owner_approval").notNull().default(false),
    ownerApprovedAt: timestamp("owner_approved_at", { withTimezone: true }),
    ownerApprovedByPersonId: uuid("owner_approved_by_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    assignedProviderId: uuid("assigned_provider_id"),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_orders_property_idx").on(t.propertyId),
    index("work_orders_status_idx").on(t.status),
  ],
);

/** Append-only audit log of everything that happens to a work order. */
export const workOrderEvents = pgTable(
  "work_order_events",
  {
    id: id(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // created, status_changed, offer_sent, offer_accepted, scheduled, ...
    actor: text("actor").notNull(), // "agent", "system", "person:<id>", "provider:<id>", "demo"
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("work_order_events_wo_idx").on(t.workOrderId, t.createdAt)],
);

// ---------- providers ----------
export const providers = pgTable(
  "providers",
  {
    id: id(),
    businessName: text("business_name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    trades: jsonb("trades").$type<string[]>().notNull().default([]),
    /** Postal codes served. (PostGIS radius can replace this later.) */
    servicePostalCodes: jsonb("service_postal_codes").$type<string[]>().notNull().default([]),
    licenseNumber: text("license_number"),
    licenseVerifiedAt: timestamp("license_verified_at", { withTimezone: true }),
    licenseExpiresAt: timestamp("license_expires_at", { withTimezone: true }),
    insuranceCarrier: text("insurance_carrier"),
    insuranceVerifiedAt: timestamp("insurance_verified_at", { withTimezone: true }),
    insuranceExpiresAt: timestamp("insurance_expires_at", { withTimezone: true }),
    status: providerStatus("status").notNull().default("onboarding"),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    jobsCompleted: integer("jobs_completed").notNull().default(0),
    /** Where dispatch offers are POSTed. Demo receivers use this. */
    offerWebhookUrl: text("offer_webhook_url"),
    /** Prefer providers that take emergencies etc. */
    acceptsEmergencies: boolean("accepts_emergencies").notNull().default(false),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("providers_status_idx").on(t.status)],
);

export const providerAvailability = pgTable(
  "provider_availability",
  {
    id: id(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("provider_availability_idx").on(t.providerId, t.startsAt)],
);

export const dispatchOffers = pgTable(
  "dispatch_offers",
  {
    id: id(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    round: integer("round").notNull().default(1),
    status: offerStatus("status").notNull().default("pending"),
    offeredAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    responseNote: text("response_note"),
    /** Provider's proposed arrival windows, if any. */
    proposedWindows: jsonb("proposed_windows").notNull().default([]),
  },
  (t) => [
    index("dispatch_offers_wo_idx").on(t.workOrderId),
    uniqueIndex("dispatch_offers_wo_provider_round_uq").on(t.workOrderId, t.providerId, t.round),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatus("status").notNull().default("hold"),
    /** While status = hold, the slot is reserved until this time. */
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    requestedByPersonId: uuid("requested_by_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    confirmedBy: text("confirmed_by"), // "provider:<id>" | "dispatcher" | "system"
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("appointments_provider_time_idx").on(t.providerId, t.startsAt),
    index("appointments_wo_idx").on(t.workOrderId),
  ],
);

// ---------- money ----------
export const estimates = pgTable("estimates", {
  id: id(),
  workOrderId: uuid("work_order_id")
    .notNull()
    .references(() => workOrders.id, { onDelete: "cascade" }),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => providers.id, { onDelete: "restrict" }),
  status: estimateStatus("status").notNull().default("draft"),
  lineItems: jsonb("line_items").notNull().default([]),
  totalCents: integer("total_cents").notNull().default(0),
  notes: text("notes"),
  /** Only the billing-responsible party (owner/PM) may approve. */
  approvedByPersonId: uuid("approved_by_person_id").references(() => people.id, {
    onDelete: "set null",
  }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    workOrderId: uuid("work_order_id")
      .notNull()
      .references(() => workOrders.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    billToPersonId: uuid("bill_to_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    status: invoiceStatus("status").notNull().default("draft"),
    lineItems: jsonb("line_items").notNull().default([]),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("invoices_wo_idx").on(t.workOrderId)],
);

export const payments = pgTable("payments", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(), // stripe, check, cash, demo
  reference: text("reference"),
  receivedAt: createdAt(),
});

export const disputes = pgTable("disputes", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  raisedByPersonId: uuid("raised_by_person_id").references(() => people.id, {
    onDelete: "set null",
  }),
  status: disputeStatus("status").notNull().default("open"),
  reason: text("reason").notNull(),
  resolution: text("resolution"),
  /** For rentals the owner is looped in; record when that happened. */
  ownerNotifiedAt: timestamp("owner_notified_at", { withTimezone: true }),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ---------- DEMO ONLY ----------
/** Tracks generated fake problems for A/B testing. Drop this table before production. */
export const demoScenarios = pgTable("demo_scenarios", {
  id: id(),
  label: text("label").notNull(),
  /** "A" / "B" arm for intake-prompt experiments. */
  variant: text("variant").notNull().default("A"),
  scenario: jsonb("scenario").notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  workOrderId: uuid("work_order_id").references(() => workOrders.id, { onDelete: "set null" }),
  outcome: jsonb("outcome"),
  createdAt: createdAt(),
});

// ---------- relations (for db.query.*) ----------
export const peopleRelations = relations(people, ({ many }) => ({
  contactMethods: many(contactMethods),
  parties: many(propertyParties),
}));
export const contactMethodsRelations = relations(contactMethods, ({ one, many }) => ({
  person: one(people, { fields: [contactMethods.personId], references: [people.id] }),
  challenges: many(verificationChallenges),
}));
export const verificationChallengesRelations = relations(verificationChallenges, ({ one }) => ({
  contactMethod: one(contactMethods, {
    fields: [verificationChallenges.contactMethodId],
    references: [contactMethods.id],
  }),
}));
export const propertiesRelations = relations(properties, ({ many }) => ({
  parties: many(propertyParties),
  facts: many(propertyFacts),
  appliances: many(appliances),
  warranties: many(warranties),
  maintenance: many(maintenanceRecords),
  workOrders: many(workOrders),
}));
export const propertyPartiesRelations = relations(propertyParties, ({ one }) => ({
  property: one(properties, { fields: [propertyParties.propertyId], references: [properties.id] }),
  person: one(people, { fields: [propertyParties.personId], references: [people.id] }),
}));
export const propertyFactsRelations = relations(propertyFacts, ({ one }) => ({
  property: one(properties, { fields: [propertyFacts.propertyId], references: [properties.id] }),
}));
export const appliancesRelations = relations(appliances, ({ one, many }) => ({
  property: one(properties, { fields: [appliances.propertyId], references: [properties.id] }),
  warranties: many(warranties),
}));
export const warrantiesRelations = relations(warranties, ({ one }) => ({
  property: one(properties, { fields: [warranties.propertyId], references: [properties.id] }),
  appliance: one(appliances, { fields: [warranties.applianceId], references: [appliances.id] }),
}));
export const maintenanceRecordsRelations = relations(maintenanceRecords, ({ one }) => ({
  property: one(properties, { fields: [maintenanceRecords.propertyId], references: [properties.id] }),
}));
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  person: one(people, { fields: [conversations.personId], references: [people.id] }),
  property: one(properties, { fields: [conversations.propertyId], references: [properties.id] }),
  contactMethod: one(contactMethods, {
    fields: [conversations.contactMethodId],
    references: [contactMethods.id],
  }),
  messages: many(messages),
}));
export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));
export const workOrdersRelations = relations(workOrders, ({ one, many }) => ({
  property: one(properties, { fields: [workOrders.propertyId], references: [properties.id] }),
  reportedBy: one(people, { fields: [workOrders.reportedByPersonId], references: [people.id] }),
  billingPerson: one(people, { fields: [workOrders.billingPersonId], references: [people.id] }),
  events: many(workOrderEvents),
  offers: many(dispatchOffers),
  appointments: many(appointments),
  estimates: many(estimates),
  invoices: many(invoices),
}));
export const workOrderEventsRelations = relations(workOrderEvents, ({ one }) => ({
  workOrder: one(workOrders, { fields: [workOrderEvents.workOrderId], references: [workOrders.id] }),
}));
export const providersRelations = relations(providers, ({ many }) => ({
  availability: many(providerAvailability),
  offers: many(dispatchOffers),
  appointments: many(appointments),
}));
export const providerAvailabilityRelations = relations(providerAvailability, ({ one }) => ({
  provider: one(providers, { fields: [providerAvailability.providerId], references: [providers.id] }),
}));
export const dispatchOffersRelations = relations(dispatchOffers, ({ one }) => ({
  workOrder: one(workOrders, { fields: [dispatchOffers.workOrderId], references: [workOrders.id] }),
  provider: one(providers, { fields: [dispatchOffers.providerId], references: [providers.id] }),
}));
export const appointmentsRelations = relations(appointments, ({ one }) => ({
  workOrder: one(workOrders, { fields: [appointments.workOrderId], references: [workOrders.id] }),
  provider: one(providers, { fields: [appointments.providerId], references: [providers.id] }),
  property: one(properties, { fields: [appointments.propertyId], references: [properties.id] }),
}));
export const estimatesRelations = relations(estimates, ({ one }) => ({
  workOrder: one(workOrders, { fields: [estimates.workOrderId], references: [workOrders.id] }),
  provider: one(providers, { fields: [estimates.providerId], references: [providers.id] }),
}));
export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  workOrder: one(workOrders, { fields: [invoices.workOrderId], references: [workOrders.id] }),
  provider: one(providers, { fields: [invoices.providerId], references: [providers.id] }),
  billTo: one(people, { fields: [invoices.billToPersonId], references: [people.id] }),
  payments: many(payments),
  disputes: many(disputes),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
}));
export const disputesRelations = relations(disputes, ({ one }) => ({
  invoice: one(invoices, { fields: [disputes.invoiceId], references: [invoices.id] }),
}));
