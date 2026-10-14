/** Internal CRUD for people, properties, facts, work orders, providers. Bearer-token protected. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { contactMethods, people, providers, workOrderEvents, workOrders } from "@labordispatch/db";
import {
  addAppliance,
  addContactMethod,
  addParty,
  approveByOwner,
  createPerson,
  createProperty,
  DomainError,
  endParty,
  getWorkOrder,
  listAppointmentsForWorkOrder,
  listAuthorizedProperties,
  listEvents,
  listOffers,
  listWorkOrders,
  propertyKnowledge,
  recordFact,
  revokeContactMethod,
  transition,
  createWorkOrder,
  finalizeIntake,
  getProperty,
} from "@labordispatch/core";
import {
  AddressInput,
  PartyInput,
  PersonInput,
  PropertyFactInput,
  WorkOrderCreateInput,
  WorkOrderStatusInput,
  TRADES,
  PROVIDER_STATUSES,
  CONTACT_METHOD_KINDS,
} from "@labordispatch/shared";
import type { ApiContext } from "../app.js";
import { bearerAuth } from "../auth.js";

export async function recordRoutes(app: FastifyInstance, ctx: ApiContext) {
  app.addHook("preHandler", bearerAuth(ctx.config.apiToken));
  const db = ctx.db;
  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
    const r = schema.safeParse(body);
    if (!r.success) throw new DomainError(JSON.stringify(r.error.flatten()), "validation", 400);
    return r.data as z.infer<S>;
  };

  // ----- people -----
  app.post("/people", async (req, reply) => {
    const input = parse(PersonInput, req.body);
    const person = await createPerson(db, input);
    return reply.code(201).send(person);
  });
  app.get<{ Params: { id: string } }>("/people/:id", async (req) => {
    const [p] = await db.select().from(people).where(eq(people.id, req.params.id)).limit(1);
    if (!p) throw new DomainError("person not found", "not_found", 404);
    const cms = await db.select().from(contactMethods).where(eq(contactMethods.personId, p.id));
    const props = await listAuthorizedProperties(db, p.id);
    return { ...p, contactMethods: cms, properties: props };
  });
  app.post<{ Params: { id: string } }>("/people/:id/contact-methods", async (req, reply) => {
    const input = parse(z.object({ kind: z.enum(CONTACT_METHOD_KINDS), value: z.string(), isPrimary: z.boolean().default(false) }), req.body);
    return reply.code(201).send(await addContactMethod(db, req.params.id, input.kind, input.value, input.isPrimary));
  });
  app.post<{ Params: { id: string } }>("/contact-methods/:id/revoke", async (req) => {
    await revokeContactMethod(db, req.params.id);
    return { revoked: true };
  });

  // ----- properties -----
  app.post("/properties", async (req, reply) => {
    const input = parse(AddressInput.extend({ accessNotes: z.string().optional() }), req.body);
    return reply.code(201).send(await createProperty(db, input));
  });
  app.get<{ Params: { id: string } }>("/properties/:id", async (req) => {
    const p = await getProperty(db, req.params.id);
    return { ...p, knowledge: await propertyKnowledge(db, p.id) };
  });
  app.post<{ Params: { id: string } }>("/properties/:id/parties", async (req, reply) => {
    const input = parse(PartyInput, req.body);
    return reply.code(201).send(await addParty(db, req.params.id, input.personId, input.role, input.isBillingResponsible));
  });
  app.post<{ Params: { partyId: string } }>("/parties/:partyId/end", async (req) => endParty(db, req.params.partyId));
  app.post<{ Params: { id: string } }>("/properties/:id/facts", async (req, reply) => {
    const input = parse(PropertyFactInput.extend({ recordedByPersonId: z.string().uuid().optional() }), req.body);
    return reply.code(201).send(await recordFact(db, req.params.id, input));
  });
  app.post<{ Params: { id: string } }>("/properties/:id/appliances", async (req, reply) => {
    const input = parse(
      z.object({
        kind: z.string(),
        manufacturer: z.string().optional(),
        model: z.string().optional(),
        serialNumber: z.string().optional(),
        locationInHome: z.string().optional(),
        installedAt: z.coerce.date().optional(),
        confidence: z.number().min(0).max(1).optional(),
        notes: z.string().optional(),
      }),
      req.body,
    );
    return reply.code(201).send(await addAppliance(db, req.params.id, input));
  });

  // ----- work orders -----
  app.get<{ Querystring: { propertyId?: string; status?: string } }>("/work-orders", async (req) =>
    listWorkOrders(db, { propertyId: req.query.propertyId, status: req.query.status as never }),
  );
  app.post("/work-orders", async (req, reply) => {
    const input = parse(WorkOrderCreateInput, req.body);
    const wo = await createWorkOrder(db, { ...input, actor: "api" });
    return reply.code(201).send(await finalizeIntake(db, wo.id, "api"));
  });
  app.get<{ Params: { id: string } }>("/work-orders/:id", async (req) => {
    const wo = await getWorkOrder(db, req.params.id);
    const [events, offers, appointments] = await Promise.all([listEvents(db, wo.id), listOffers(db, wo.id), listAppointmentsForWorkOrder(db, wo.id)]);
    return { ...wo, events, offers, appointments };
  });
  app.post<{ Params: { id: string } }>("/work-orders/:id/status", async (req) => {
    const input = parse(WorkOrderStatusInput, req.body);
    return transition(db, req.params.id, input.status, "dispatcher", input.note);
  });
  app.post<{ Params: { id: string } }>("/work-orders/:id/approve", async (req) => {
    const input = parse(z.object({ personId: z.string().uuid(), note: z.string().optional() }), req.body);
    return approveByOwner(db, req.params.id, input.personId, input.note);
  });
  app.post<{ Params: { id: string } }>("/work-orders/:id/events", async (req, reply) => {
    const input = parse(z.object({ type: z.string(), payload: z.record(z.unknown()).default({}) }), req.body);
    await db.insert(workOrderEvents).values({ workOrderId: req.params.id, type: input.type, actor: "dispatcher", payload: input.payload });
    return reply.code(201).send({ ok: true });
  });

  // ----- providers -----
  const ProviderInput = z.object({
    businessName: z.string().min(1),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    trades: z.array(z.enum(TRADES)).min(1),
    servicePostalCodes: z.array(z.string()).min(1),
    licenseNumber: z.string().optional(),
    licenseExpiresAt: z.coerce.date().optional(),
    insuranceCarrier: z.string().optional(),
    insuranceExpiresAt: z.coerce.date().optional(),
    offerWebhookUrl: z.string().url().optional(),
    acceptsEmergencies: z.boolean().default(false),
    isDemo: z.boolean().default(false),
  });
  app.get("/providers", async () => db.select().from(providers));
  app.post("/providers", async (req, reply) => {
    const input = parse(ProviderInput, req.body);
    const [row] = await db.insert(providers).values({ ...input, status: "onboarding" }).returning();
    return reply.code(201).send(row);
  });
  app.post<{ Params: { id: string } }>("/providers/:id/verify", async (req) => {
    const input = parse(z.object({ license: z.boolean().optional(), insurance: z.boolean().optional(), activate: z.boolean().optional() }), req.body);
    const patch: Partial<typeof providers.$inferInsert> = {};
    if (input.license) patch.licenseVerifiedAt = new Date();
    if (input.insurance) patch.insuranceVerifiedAt = new Date();
    if (input.activate) patch.status = "active";
    const [row] = await db.update(providers).set(patch).where(eq(providers.id, req.params.id)).returning();
    if (!row) throw new DomainError("provider not found", "not_found", 404);
    return row;
  });
  app.post<{ Params: { id: string } }>("/providers/:id/status", async (req) => {
    const input = parse(z.object({ status: z.enum(PROVIDER_STATUSES) }), req.body);
    const [row] = await db.update(providers).set({ status: input.status }).where(eq(providers.id, req.params.id)).returning();
    if (!row) throw new DomainError("provider not found", "not_found", 404);
    return row;
  });
  app.get<{ Params: { id: string } }>("/providers/:id/work-orders", async (req) =>
    db.select().from(workOrders).where(eq(workOrders.assignedProviderId, req.params.id)),
  );
}
