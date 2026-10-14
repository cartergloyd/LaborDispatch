# Architecture

LaborDispatch is a TypeScript monorepo (npm workspaces). Everything talks to one PostgreSQL schema
through Drizzle ORM. For local development and tests the database is an embedded Postgres
(PGlite) so nothing has to be installed; setting `DATABASE_URL` switches to a real server.

```
                SMS / web chat                      External AI agents
                      │                                    │
                 ┌────▼─────┐                        ┌─────▼──────┐
                 │ Chatwoot │ (hosted or self-hosted) │ MCP client │
                 └────┬─────┘                        └─────┬──────┘
          webhook     │     reply via API                  │ stdio
                 ┌────▼─────────────────┐            ┌─────▼──────────────┐
                 │ apps/api  (Fastify)  │            │ apps/mcp-server    │
                 │  /webhooks/chatwoot  │            │  search_contractors│
                 │  /chat/:key/messages │            │  request_service   │
                 │  REST: people, props,│            │  request_booking…  │
                 │  work orders, offers,│            └─────┬──────────────┘
                 │  appointments, money │                  │
                 │  /demo/* (DEMO_MODE) │                  │
                 └──┬─────────────┬─────┘                  │
                    │             │                        │
       ┌────────────▼──┐   ┌──────▼──────────────────────────▼──┐
       │ intake-agent  │   │ core: identity, properties,        │
       │ Claude + tools│──▶│ work-orders, scheduling, dispatch, │
       └───────────────┘   │ invoicing                          │
                           └──────────────┬─────────────────────┘
                                   ┌──────▼──────┐
                                   │ db (Drizzle)│  PGlite locally, Postgres in prod
                                   └─────────────┘
```

## Packages

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@labordispatch/shared` | Enums, Zod schemas, phone normalization, env helpers. No runtime deps besides Zod. |
| `packages/db` | `@labordispatch/db` | Drizzle schema (`src/schema.ts`), client factory, migrator, seed. Migrations live in `packages/db/drizzle`. |
| `packages/core` | `@labordispatch/core` | All business rules. Pure functions over a `Db`. No HTTP, no LLM. |
| `packages/intake-agent` | `@labordispatch/intake-agent` | The chatbot: system prompt, tool definitions bound to core, conversation engine. |
| `packages/demo` | `@labordispatch/demo` | **DEMO ONLY.** Fake problem generator for A/B tests and fake contractor "receivers". |
| `apps/api` | `@labordispatch/api` | Fastify HTTP server: Chatwoot webhook, direct chat API, internal REST, housekeeping timers. |
| `apps/mcp-server` | `@labordispatch/mcp-server` | Model Context Protocol server exposing dispatch capabilities to other agents. |

## Request flow: an SMS arrives

1. Chatwoot receives the text (Twilio/Bandwidth/etc. inbox) and POSTs `message_created` to
   `POST /webhooks/chatwoot?token=…`. The API validates the token and returns 200 immediately.
2. `findOrCreateConversation` keys the conversation on `(channel, chatwoot account, chatwoot conversation id)`.
   The inbound phone number is stored as `inbound_identifier`.
3. `handleInboundMessage` (intake-agent):
   - Re-resolves identity every turn: phone → active `contact_methods` row → `people` row, and computes the
     trust state (`trusted` if verified within `VERIFICATION_TRUST_DAYS`, else `needs_verification`; `unknown` if no row).
   - Loads history (full Claude content blocks, including thinking and tool blocks) and appends the new user
     message plus a **mid-conversation system message** carrying `caller_context` (identity, trust, redacted
     property labels, confirmed property id). The texter's words are never placed in a system slot.
   - Calls Claude (`claude-opus-5-5`, server-side fallback to `claude-opus-4-8`) with strict-schema tools.
     Tool inputs are re-validated with Zod before execution. Tools run with the conversation's identity only.
   - Loops until `end_turn`; handles `refusal` (safe reply + handoff), `pause_turn`, `max_tokens`.
   - Persists every assistant turn and tool result so history is append-only.
4. The API posts the reply back to Chatwoot. Escalations post a private note and reopen the
   conversation for a human agent.

## Identity and household authorization

- A phone number is a *contact method*, not a person. `people` ↔ `contact_methods` (1:n, with
  `revoked_at` so a reassigned number can be re-registered to someone else).
- `property_parties` is the explicit person ↔ property relationship with a `role`
  (owner, resident, tenant, property_manager, authorized_contact), `is_billing_responsible`, and an
  `ends_at` so access stops when a tenant moves out or an owner sells.
- Before disclosure the caller must be `trusted`. Verification is knowledge-based on SMS: the caller
  *states* the street address and we match it against their own properties
  (`verifyByAddressClaim`). The bot never reads an address first. On web chat, a one-time code is
  texted to the number on file (`startCodeChallenge` / `completeCodeChallenge`).
- `redactedPropertyLabel` ("Essex Ave house", or "Harbor View Dr in Branson" with no house number)
  is the only thing shown to help a multi-home caller pick.
- Access notes (gate codes, lockboxes) are stored on `properties.access_notes` and are excluded
  from everything the agent can read.

## Landlords and tenants

- `createWorkOrder` derives `billing_person_id` from the property's parties (explicit
  `is_billing_responsible`, else owner, else property manager) and sets `requires_owner_approval`
  when the reporter is not that person, or when `is_large_project` is true.
- `finalizeIntake` moves such work orders to `pending_owner_approval`; emergencies skip approval for
  dispatch but log `owner_notified`. Only the billing party can call `approveByOwner`.
- The agent's system prompt treats tenant text as symptom reports, not authorization. Estimates are
  approved only by the billing party (`approveEstimate`). Disputes on rentals set `owner_notified_at`.

## Scheduling rules

- Homeowners **request** a window; the system places a `hold` that expires after
  `APPOINTMENT_HOLD_MINUTES`; the provider or a dispatcher **confirms**.
- `placeHold` runs in a transaction with `SELECT … FOR UPDATE` on the provider row so two callers
  cannot take the same slot; the loser gets a 409.
- `freeSlots` = declared `provider_availability` minus blocking appointments (confirmed/requested or
  unexpired holds), sliced into fixed-length windows.
- `expireHolds` runs from the API's housekeeping timer every 30 s.

## Dispatch

- `findCandidates`: active providers with the trade (or general handyman fallback), serving the
  postal code, verified and unexpired license and insurance (unverified only with
  `ALLOW_UNVERIFIED_PROVIDERS=true`), `accepts_emergencies` for emergencies. Ranked by exact trade,
  rating, jobs completed, credentials.
- `runDispatchRound` offers to the next best provider(s) not yet offered, with an expiry. Delivery is
  a POST to `providers.offer_webhook_url` carrying only coarse location (city + postal code) until
  accepted. `respondToOffer` is transactional; the first acceptance wins and withdraws the rest.
- `expireOffersAndAdvance` moves to the next round; when candidates are exhausted (or `maxRounds`
  reached) the work order becomes `no_provider_available` and a `needs_human_dispatcher` event is
  written. That is the "nobody accepted" procedure: a human picks it up from the event stream.

## Property knowledge with provenance

`property_facts` is append-only: each row has `source` (user_stated, owner_stated,
technician_observed, document, public_record, system_derived, demo_generated), `confidence` 0–1,
`observed_at`, `recorded_at`, `recorded_by_person_id`. A new value for the same key sets
`superseded_by_id` on the old row. `propertyKnowledge()` returns only recorded rows, never defaults,
so "unknown stays unknown".

## Demo surfaces (remove before production)

Everything demo is marked: `is_demo` columns, `DEMO_TAG`, `// DEMO ONLY` file headers, the
`demo_scenarios` table, `/demo/*` routes behind `DEMO_MODE`, and `packages/demo`. The removal
checklist is in `packages/demo/README.md`.

## Not yet built

- Web chat widget UI (Chatwoot's widget can be used directly; the bot works on any Chatwoot inbox).
- SMS delivery of verification codes and provider offers without a webhook (currently logged / webhook only).
- Stripe checkout for invoices (`stripe_payment_intent_id` column exists; no integration yet).
- Dispatcher/admin UI. All operations are available via the REST API.
- Provider onboarding workflow beyond the REST `/providers` + `/providers/:id/verify` endpoints.
- Multi-tenant SaaS boundaries (organizations). The schema is single-operator today.
