# Decisions

Short records of choices that are not obvious from the code.

## 1. Build our own core instead of forking Open Field Pro
Open Field Pro (AGPL) covers customers, properties, work orders, scheduling and invoices, and its
stack (TypeScript, Fastify, Drizzle, Zod, Postgres) is a good fit, so we adopted the **stack** and
the entity shapes. We did not vendor its code: AGPL would bind LaborDispatch's license, the project
is self-described as release-candidate hardening, and our identity/authorization and landlord
models are different enough that adapting would cost more than writing. The same reasoning
applies to webcasa (Go + SQLite): we borrowed its home-maintenance entities (appliances,
warranties, incidents, maintenance, service visits, quotes) as tables in our schema.

## 2. Chatwoot stays an external service
Chatwoot provides SMS and web-chat transport, inboxes, contact profiles and human handoff. We
integrate via its webhook and Application API rather than embedding it. The bot therefore works
with any Chatwoot inbox, and a human can take over a conversation in Chatwoot's UI.

## 3. Postgres dialect everywhere, embedded PGlite for local/test
The schema is PostgreSQL (needed for partial unique indexes, `FOR UPDATE`, jsonb, and later
PostGIS). PGlite runs the same engine in-process, so `npm test` and `npm run dev` need no database
install. `DATABASE_URL` switches to a real server with no code change.

## 4. Knowledge-based verification on SMS, OTP on web chat
Texting a code to the same number proves only that the sender controls the number, which is the
thing we already know. A former holder of a reassigned number would pass it. Instead the caller
states the street address and we match it against the properties *they* are related to. On web
chat the caller is anonymous, so a one-time code to the number on file is the right first factor.
Trust expires after `VERIFICATION_TRUST_DAYS` (default 90).

## 5. Caller context as a mid-conversation system message
Claude Opus 5.5 supports `{role: "system"}` entries inside `messages`. We use that channel for
identity/trust/property context so the texter's words never share a slot with operator
instructions, and the top-level system prompt stays byte-stable for prompt caching.

## 6. Manual tool loop instead of the SDK tool runner
We need to persist every content block (for replay and audit), pass `fallbacks`, and enforce
per-tool identity checks. The loop is ~60 lines and keeps those explicit. Tool inputs use
`strict: true` schemas and are re-validated with Zod before execution.

## 7. Facts are append-only with provenance
Editing a fact in place would lose who said what and when. New values supersede old rows.
The agent records the caller's statements with moderate confidence; it never records a guess.

## 8. Holds, not bookings
A homeowner's pick is a hold with a TTL; the provider confirms. This resolves the README's
open questions: the provider confirms, holds last `APPOINTMENT_HOLD_MINUTES`, same-slot races are
serialized per provider, and cancellation returns the job to `accepted` with the provider still
assigned.

## 9. Demo code is quarantined
`packages/demo`, `/demo/*` routes, `demo_scenarios`, `is_demo` flags and `DEMO_TAG` make removal
mechanical. See `packages/demo/README.md`.
