/**
 * Canonical enums shared by the database, API, intake agent, and MCP server.
 * Keep these as `as const` tuples so Drizzle `pgEnum` and Zod `z.enum` can both consume them.
 */

export const CONTACT_METHOD_KINDS = ["phone", "email"] as const;
export type ContactMethodKind = (typeof CONTACT_METHOD_KINDS)[number];

export const VERIFICATION_STATUSES = ["unverified", "pending", "verified", "revoked"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Relationship between a person and a property. A person may hold several roles
 * (e.g. owner + resident of their own home), and a property may have many parties.
 */
export const PARTY_ROLES = [
  "owner",
  "resident",
  "tenant",
  "property_manager",
  "authorized_contact",
] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** Where a recorded fact about a property came from. Never "guessed". */
export const FACT_SOURCES = [
  "user_stated",
  "owner_stated",
  "technician_observed",
  "document",
  "public_record",
  "system_derived",
  "demo_generated",
] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export const FACT_CATEGORIES = [
  "roof",
  "gutters",
  "hvac",
  "water_heater",
  "plumbing",
  "electrical",
  "appliance",
  "structure",
  "access",
  "general",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const TRADES = [
  "plumbing",
  "electrical",
  "hvac",
  "roofing",
  "appliance_repair",
  "general_handyman",
  "pest_control",
  "locksmith",
  "landscaping",
  "cleaning",
  "other",
] as const;
export type Trade = (typeof TRADES)[number];

export const URGENCIES = ["emergency", "urgent", "routine", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const WORK_ORDER_STATUSES = [
  "intake",
  "needs_info",
  "pending_owner_approval",
  "ready_to_dispatch",
  "offered",
  "accepted",
  "scheduled",
  "in_progress",
  "completed",
  "invoiced",
  "paid",
  "cancelled",
  "disputed",
  "no_provider_available",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const OFFER_STATUSES = ["pending", "accepted", "declined", "expired", "withdrawn"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/**
 * Booking rule: a homeowner *requests* a window; the system places a short-lived `hold`;
 * the provider (or dispatcher) `confirm`s. Holds expire automatically.
 */
export const APPOINTMENT_STATUSES = [
  "hold",
  "requested",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const PROVIDER_STATUSES = ["onboarding", "active", "suspended", "offboarded"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const ESTIMATE_STATUSES = ["draft", "sent", "approved", "rejected", "expired"] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "partially_paid",
  "paid",
  "disputed",
  "void",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const DISPUTE_STATUSES = [
  "open",
  "under_review",
  "resolved_for_customer",
  "resolved_for_provider",
  "withdrawn",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const CONVERSATION_CHANNELS = ["sms", "web_chat", "demo", "api"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_STATUSES = [
  "open",
  "awaiting_user",
  "awaiting_owner",
  "handed_off",
  "closed",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ["inbound", "outbound", "system"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MAINTENANCE_KINDS = ["completed", "scheduled", "recommended"] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
