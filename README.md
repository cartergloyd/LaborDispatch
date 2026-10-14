# LaborDispatch
An automated maintenance in-take chatbot, with access to a database connecting phone numbers to their home addresses details about their home, and scheduling &amp; dispatching proper laborer to home.

Decent Starting point is Open Field Pro 
https://github.com/niko4244/openfieldpro 
This is particularly relevant because its documented functionality includes customers, properties, equipment history, technician scheduling, work orders, estimates, invoices, and Stripe checkout.
Missing: Customer-facing AI chatbot, SMS conversation workflow, external agent integrations, and contractor discovery.
Caution: The developer explicitly describes it as being in release-candidate hardening, not fully production-ready.

# In-take
We are taking Task Rabbit and putting a thin layer of innovation on top of it: A chatbot, accessible via text and website with access to a database connecting phone numbers to their names, home addresses details about their home.
The chatbot will be trained to understand the first message, clarify the address, understand the issue, obtain other relevant information.

Chatwoot - https://github.com/chatwoot/chatwoot
Best for customer messaging
Website chat widget, SMS through supported providers, shared inboxes, customer profiles, webhooks, and APIs. It's a complete messaging platform, not just a demo.

Dify - https://github.com/langgenius/dify
Best for AI reasoning and database-connected workflows
Builds AI assistants that retrieve information and call tools or APIs. Supports self-hosting, workflows, knowledge retrieval, and model integrations. Structured customer records would be retrieved through controlled database queries or API tools.

# Database
- Phone Numbers =& Names
- Address(es)
- Warranties
- Appliance Models, Manufacturers
- HVAC replacement
- Roof, Gutters, degradation
- Past maintenance & future maintenance needed

Homebox — Best appliance and warranty tracker - https://github.com/sysadminsmedia/homebox
Tracks household items, purchase information, warranties, documents, custom fields, and maintenance schedules. Particularly useful for appliance inventory. 
Limit: Designed around home inventory, not a business managing thousands of customers.

webcasa — Best home-maintenance-specific data model - https://github.com/goeric/webcasa
Includes appliances, incidents, warranties, vendor contacts, recurring maintenance, service visits, quotes, attachments, and an API. 
Limit: A smaller project that would need additional work for multi-homeowner SaaS use.

# Dispatch
LabourLink - https://github.com/Meenakshihosagouda/LabourLink-Smart-Worker-Hiring-Platform
A Django application designed for finding and hiring local workers. Its documented features include contractor profiles, ratings, location-aware matching, availability, job management, bookings, and a chatbot. Caution: Tiny project, with no visible software license. Useful as an architectural reference, not something I'd assume is commercially reusable.

LocalHands - https://github.com/prachi246/localhands-service-marketplace
A service-provider marketplace with customer accounts, contractor registration, service listings, provider discovery, and booking requests.
Caution: Educational project. Payments, real-time chat, and ratings are listed as future improvements, and commercial reuse rights are not established.
For an existing network of contractors, it already supports service requests, quotes, technician assignment, dispatch, work completion, and invoicing within ERPNext.
Caution: It's a field-service application, not a public contractor marketplace.

Connecting external AI assistants
MCP TypeScript SDK	Build a server exposing your contractor search, quotes, and booking APIs to compatible agents
OpenAI Apps SDK Examples	Starter examples for creating ChatGPT-connected applications, including authenticated tools
n8n	Automate service requests, contractor notifications, follow-ups, and API workflows
These provide reusable infrastructure, not ready-made Muse/Dots/Grokbot contractor integrations. 
Meta's Muse Connectors developer program currently supports API/MCP integration but remains in limited preview; the provider says public publishing comes later. 
My selection: MCP SDK + n8n, together with your contractor management application. It is a practical foundation for AI agents to request work without committing to one agent company.
The unresolved piece is populating and maintaining a real contractor network with verified availability, coverage areas, insurance/licensing checks, and acceptance workflows.

# Invoicing
ERPNext - https://github.com/frappe/erpnext
ERPNext provides an established CRM, customer and asset records, maintenance visits, invoices, payment requests, and payment-gateway integrations. Beveren adds service requests, technician assignment, scheduling, and dispatch.
Beveren FSM - https://github.com/Beveren-Software-Inc/Field_Service_Management



