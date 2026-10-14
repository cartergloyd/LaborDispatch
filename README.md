# LaborDispatch
An automated maintenance in-take chatbot, with access to a database connecting phone numbers to their home addresses details about their home, and scheduling &amp; dispatching proper laborer to home.

Decent Starting point is Open Field Pro 
https://github.com/niko4244/openfieldpro 
This is particularly relevant because its documented functionality includes customers, properties, equipment history, technician scheduling, work orders, estimates, invoices, and Stripe checkout. Use this for the Customer/property records, work orders, scheduling, dispatch, invoices.
Missing: Customer-facing AI chatbot, SMS conversation workflow, external agent integrations, and contractor discovery.
Caution: The developer explicitly describes it as being in release-candidate hardening, not fully production-ready.

# DEMO: Pre Intake
we need to code some way to generate some fake problems for A/B testing, clearly labeled as demo only so we can take it off once we are prod ready.

# In-take
We are taking Task Rabbit and putting a thin layer of innovation on top of it: A chatbot, accessible via text and website with access to a database connecting phone numbers to their names, home addresses details about their home.
The chatbot will be trained to understand the first message, clarify the address, understand the issue, obtain other relevant information.

Chatwoot - https://github.com/chatwoot/chatwoot
Best for customer messaging, use this for theSMS, website chat, conversation history, human handoff
Website chat widget, SMS through supported providers, shared inboxes, customer profiles, webhooks, and APIs. It's a complete messaging platform, not just a demo.

# Property and Customer Database
- Phone Numbers =& Names (Account for: One person can have multiple homes; one home can have multiple occupants.)
- Address(es)
- Warranties
- Appliance Models, Manufacturers
- HVAC replacement
- Roof, Gutters, degradation
- Past maintenance & future maintenance needed

webcasa — Best home-maintenance-specific data model - https://github.com/goeric/webcasa
Use for property data model, appliances, warranties, maintenance history
Includes appliances, incidents, warranties, vendor contacts, recurring maintenance, service visits, quotes, attachments, and an API. 
Limit: A smaller project that would need additional work for multi-homeowner SaaS use.

The property and customer database need not know everything about the house on day one. It should be designed to acquire facts over time, with a recorded source, date and confidence. Missing information must stay unknown rather than being guessed by AI.

# Pre-Dispatch Notes on the Above
Identity and household authorization
A phone number cannot safely be treated as proof of ownership or access. A stranger or former number holder must not be able to retrieve addresses, access codes or service history.
We need people, verified contact methods, properties, and explicit relationships between them. If someone's recently been verified they should be considered safe, but we dont want a phone number texting years later asking about work on a different house. The user should be able to change their address and info in the house.

Booking and scheduling rules
Define whether a homeowner requests a time or books a confirmed slot. Decide who confirms appointments, how long availability holds last, what happens when two people choose the same slot, and how cancellations work.

We need to consider and include scalability when it comes to Landlords and Larger projects. 

Considerations for Landlords: 
- They are the homeowner, and the person who pays the invoice for property maintenance, but not the person raising the issue, that is the tenant. 
- The tenant may be pushing for a new water heater when one is not needed, the chatbot should avoid prompt injection and influence from the tenant, and focus on the facts of getting a specialist there.
- Total list of involved people could the resident(s) (tenant, occupier of home, person texting the chat bot they are having an issue), the homeowner (in many circumstances this could be the same person as the resident), the specialist being dispatched, may or may not applicable: property manager, contractors, administrator?

Example Edge Cases
1. I live at 11483 Essex Ave, but I also own two rental properties. Logan lives in one of the rental properties. If Logan texts the chatbot with a problem it would come to me for the financials, but it would also come to me for the financials of my home.
2. My dad owns his home and a vacation home, he would need to verify the address he is referring to to the chatbot.

We need the AI chat bot to be contextually aware and ask the user to run some extremely basic troubleshooting and diagnostics if it will save a trip and money.

Consider larger projects, if there is a leak in the roof, this would demand more scrutiny as the home may need a whole new roof.

# Provider Database
An actual contractor network Contractor discovery and contractor dispatch are different problems. You need onboarding, license and insurance checks, service areas, skills, availability, offer acceptance and procedures when nobody accepts a job.

# Dispatch
Connecting external AI assistants
MCP TypeScript SDK - https://github.com/modelcontextprotocol/typescript-sdk For Exposing LaborDispatch capabilities to other AI agents Build a server exposing your contractor search, quotes, and booking APIs to compatible agents
Meta's Muse Connectors developer program currently supports API/MCP integration but remains in limited preview; the provider says public publishing comes later. 

# Invoicing
Open field pro includes some infrastructure on this. We need motions for when there are disputes, optional landlord involvement when it is a rental property

# DEMO: Dispatch receivers
We need a way to have demo out, clearly labeled as demo so we can remove it when we are ready for prod.

---

# Getting started (implementation)

The sections above are the product vision. Below is how to run what has been built so far.
See `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md` and `docs/DECISIONS.md` for the design.

## Prerequisites
- Node.js 22+ (tested on 24). No database install needed: an embedded Postgres (PGlite) is used
  until you set `DATABASE_URL`.
- A Claude API key for the intake chatbot (`ANTHROPIC_API_KEY`). Everything except the chatbot
  works without it.

## Run it
```bash
npm install
cp .env.example .env            # edit API_TOKEN at minimum
npm run db:seed                 # creates ./.pglite with the README's example households
npm run dev                     # API on http://localhost:3000
```

In a second terminal, the demo contractors (fake dispatch receivers):
```bash
npm run demo:receivers          # http://localhost:3100
curl -X POST localhost:3000/demo/providers/wire-receivers \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"receiversUrl":"http://localhost:3100"}'
```

Talk to the intake bot without Chatwoot (uses the seeded owner's phone):
```bash
curl -X POST localhost:3000/chat/demo-1/messages \
  -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d '{"text":"my furnace at 11483 Essex Ave keeps shutting off","fromPhone":"+15555550101","channel":"sms"}'
```

Generate fake problems for A/B testing (demo only):
```bash
npm run demo:generate -- 5 --seed 42
API_URL=http://localhost:3000 API_TOKEN=... npm run demo:generate -- 3   # also records them via the API
```

Expose capabilities to other AI agents over MCP:
```bash
npm run dev:mcp                 # stdio server; see apps/mcp-server/README.md for client config
```

## Connect Chatwoot
1. In Chatwoot, create an SMS inbox (Twilio/Bandwidth) and/or a website inbox.
2. Set `CHATWOOT_BASE_URL`, `CHATWOOT_ACCOUNT_ID`, `CHATWOOT_API_TOKEN` (an agent bot or user
   access token) and a random `CHATWOOT_WEBHOOK_TOKEN` in `.env`.
3. Add a webhook in Chatwoot pointing to `https://<your-host>/webhooks/chatwoot?token=<CHATWOOT_WEBHOOK_TOKEN>`
   subscribed to `message_created`.
Replies are posted back into the same conversation; escalations add a private note and reopen the
conversation for a human agent.

## Develop
```bash
npm run typecheck   # tsc -b across all workspaces
npm test            # vitest, uses in-memory Postgres
npm run db:generate # regenerate SQL migrations after editing packages/db/src/schema.ts
```

## Status
| Area | State |
|---|---|
| Property & customer database with provenance, households, time-bounded trust | Built, tested |
| Intake chatbot (Claude, tools, prompt-injection safe, basic troubleshooting) | Built; needs an API key to exercise live |
| Chatwoot SMS/web-chat integration | Webhook + reply client built; not yet exercised against a live Chatwoot |
| Work orders, owner approval, landlord/tenant rules | Built, tested |
| Scheduling (holds, confirmation, conflicts, expiry) | Built, tested |
| Provider network, dispatch rounds, "nobody accepted" procedure | Built, tested |
| Invoicing, payments, disputes with owner involvement | Built, tested (no Stripe yet) |
| MCP server for external agents | Built, tested |
| DEMO: fake problem generator (A/B), fake dispatch receivers | Built, tested, quarantined |
| Admin/dispatcher UI, web chat widget, Stripe, SMS code delivery | Not started |
