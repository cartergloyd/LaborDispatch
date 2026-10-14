# Data model

Source of truth: `packages/db/src/schema.ts`. Generated SQL: `packages/db/drizzle/`.

## Identity
| Table | Purpose | Key columns |
|---|---|---|
| `people` | A human. | `display_name`, `is_demo` |
| `contact_methods` | Phones (E.164) and emails belonging to a person. One **active** owner per value (partial unique index where `revoked_at IS NULL`). | `kind`, `value`, `status` (unverified/pending/verified/revoked), `last_verified_at`, `revoked_at` |
| `verification_challenges` | One-time codes (sha256 hashed) for web-chat verification. | `code_hash`, `expires_at`, `consumed_at`, `attempts` |

## Properties
| Table | Purpose | Key columns |
|---|---|---|
| `properties` | A home. | address fields, `nickname`, `access_notes` (never shown in chat) |
| `property_parties` | Person ↔ property relationship. Ended rows grant nothing. | `role`, `is_billing_responsible`, `starts_at`, `ends_at` |
| `property_facts` | Append-only facts with provenance. | `category`, `key`, `value` (jsonb), `source`, `confidence`, `observed_at`, `recorded_by_person_id`, `superseded_by_id` |
| `appliances` | Equipment inventory. | `kind`, `manufacturer`, `model`, `serial_number`, `installed_at`, `source`, `confidence` |
| `warranties` | Coverage, optionally tied to an appliance. | `provider`, `covers`, `starts_at`, `ends_at` |
| `maintenance_records` | Past, scheduled and recommended maintenance. | `kind` (completed/scheduled/recommended), `performed_at`, `due_at`, `cost_cents` |

## Conversations
| Table | Purpose | Key columns |
|---|---|---|
| `conversations` | One chat thread (Chatwoot conversation, demo run, or API key). | `channel`, `external_id`, `inbound_identifier`, `person_id`, `property_id`, `work_order_id`, `status`, `state` (agent memory) |
| `messages` | Every turn, including Claude content blocks for replay. | `direction` (inbound/outbound/system), `body`, `llm_content`, `external_id` (idempotency) |

## Work
| Table | Purpose | Key columns |
|---|---|---|
| `work_orders` | The job. | `trade`, `urgency`, `status`, `reported_by_person_id`, `billing_person_id`, `requires_owner_approval`, `owner_approved_at`, `is_large_project`, `assigned_provider_id` |
| `work_order_events` | Append-only audit trail. | `type`, `actor`, `payload` |

Status machine (see `ALLOWED_TRANSITIONS` in `packages/core/src/work-orders.ts`):
`intake → needs_info | pending_owner_approval | ready_to_dispatch → offered → accepted → scheduled → in_progress → completed → invoiced → paid`, with `disputed`, `cancelled`, `no_provider_available` side states.

## Providers and dispatch
| Table | Purpose | Key columns |
|---|---|---|
| `providers` | Contractor network. | `trades[]`, `service_postal_codes[]`, license/insurance verified + expiry, `status`, `rating`, `offer_webhook_url`, `accepts_emergencies` |
| `provider_availability` | Declared working windows. | `starts_at`, `ends_at` |
| `dispatch_offers` | One offer to one provider in one round. | `round`, `status` (pending/accepted/declined/expired/withdrawn), `expires_at`, `proposed_windows` |
| `appointments` | Holds and confirmed visits. | `status` (hold/requested/confirmed/cancelled/completed/no_show), `hold_expires_at`, `confirmed_by` |

## Money
| Table | Purpose |
|---|---|
| `estimates` | Provider quote; approved only by the billing party. |
| `invoices` | Billed to `bill_to_person_id`; `stripe_payment_intent_id` reserved for Stripe. |
| `payments` | Partial/full payments. |
| `disputes` | Raised by anyone involved; `owner_notified_at` set when the raiser is not the payer. |

## Demo only
| Table | Purpose |
|---|---|
| `demo_scenarios` | Generated fake problems, A/B `variant`, linked conversation/work order, recorded `outcome`. Drop before production. |
