/** Dispatch, offers, scheduling, availability, invoices and disputes. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { providerAvailability } from "@labordispatch/db";
import {
  cancelAppointment,
  confirmAppointment,
  createEstimate,
  approveEstimate,
  createInvoice,
  DomainError,
  findCandidates,
  freeSlots,
  openDispute,
  placeHold,
  recordPayment,
  resolveDispute,
  respondToOffer,
  runDispatchRound,
  listPendingOffersForProvider,
} from "@labordispatch/core";
import { TimeWindowInput } from "@labordispatch/shared";
import type { ApiContext } from "../app.js";
import { bearerAuth } from "../auth.js";
import { dispatchOptions } from "../dispatcher.js";

export async function dispatchRoutes(app: FastifyInstance, ctx: ApiContext) {
  app.addHook("preHandler", bearerAuth(ctx.config.apiToken));
  const db = ctx.db;
  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
    const r = schema.safeParse(body);
    if (!r.success) throw new DomainError(JSON.stringify(r.error.flatten()), "validation", 400);
    return r.data as z.infer<S>;
  };
  const opts = dispatchOptions(db, ctx.config, ctx.fetchImpl);

  app.get<{ Params: { id: string } }>("/work-orders/:id/candidates", async (req) =>
    (await findCandidates(db, req.params.id, { allowUnverifiedProviders: ctx.config.allowUnverifiedProviders })).map((c) => ({
      providerId: c.provider.id,
      businessName: c.provider.businessName,
      score: c.score,
      reasons: c.reasons,
    })),
  );
  app.post<{ Params: { id: string } }>("/work-orders/:id/dispatch", async (req) => {
    const offers = await runDispatchRound(db, req.params.id, opts);
    return { offers, exhausted: offers.length === 0 };
  });

  const LineItems = z.array(z.object({ description: z.string(), quantity: z.number().positive(), unitCents: z.number().int() }));

  /** Providers (or demo receivers) respond here. */
  app.post<{ Params: { id: string } }>("/offers/:id/respond", async (req) => {
    const input = parse(
      z.object({ accept: z.boolean(), note: z.string().optional(), proposedWindows: z.array(TimeWindowInput).optional() }),
      req.body,
    );
    return respondToOffer(db, req.params.id, input);
  });
  app.get<{ Params: { id: string } }>("/providers/:id/offers", async (req) => listPendingOffersForProvider(db, req.params.id));

  app.post<{ Params: { id: string } }>("/providers/:id/availability", async (req, reply) => {
    const input = parse(z.array(TimeWindowInput).min(1), req.body);
    const rows = await db.insert(providerAvailability).values(input.map((w) => ({ providerId: req.params.id, ...w }))).returning();
    return reply.code(201).send(rows);
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; slotMinutes?: string } }>("/providers/:id/free-slots", async (req) => {
    const from = req.query.from ? new Date(req.query.from) : new Date();
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 7 * 86_400_000);
    return freeSlots(db, req.params.id, from, to, req.query.slotMinutes ? Number(req.query.slotMinutes) : 120, 12);
  });

  app.post<{ Params: { id: string } }>("/work-orders/:id/appointments", async (req, reply) => {
    const input = parse(TimeWindowInput.extend({ providerId: z.string().uuid(), requestedByPersonId: z.string().uuid().optional() }), req.body);
    const appt = await placeHold(db, {
      workOrderId: req.params.id,
      providerId: input.providerId,
      window: { startsAt: input.startsAt, endsAt: input.endsAt },
      requestedByPersonId: input.requestedByPersonId ?? null,
      holdMinutes: ctx.config.holdMinutes,
    });
    return reply.code(201).send(appt);
  });
  app.post<{ Params: { id: string } }>("/appointments/:id/confirm", async (req) => {
    const input = parse(z.object({ confirmedBy: z.string().default("dispatcher") }), req.body ?? {});
    return confirmAppointment(db, req.params.id, input.confirmedBy);
  });
  app.post<{ Params: { id: string } }>("/appointments/:id/cancel", async (req) => {
    const input = parse(z.object({ reason: z.string().min(1), actor: z.string().default("dispatcher") }), req.body);
    return cancelAppointment(db, req.params.id, input.actor, input.reason);
  });

  // ----- money -----
  app.post<{ Params: { id: string } }>("/work-orders/:id/estimates", async (req, reply) => {
    const input = parse(z.object({ providerId: z.string().uuid(), lineItems: LineItems, notes: z.string().optional() }), req.body);
    return reply.code(201).send(await createEstimate(db, { workOrderId: req.params.id, ...input }));
  });
  app.post<{ Params: { id: string } }>("/estimates/:id/approve", async (req) => {
    const input = parse(z.object({ personId: z.string().uuid() }), req.body);
    return approveEstimate(db, req.params.id, input.personId);
  });
  app.post<{ Params: { id: string } }>("/work-orders/:id/invoices", async (req, reply) => {
    const input = parse(z.object({ providerId: z.string().uuid(), lineItems: LineItems, taxCents: z.number().int().optional(), dueInDays: z.number().int().optional() }), req.body);
    return reply.code(201).send(await createInvoice(db, { workOrderId: req.params.id, ...input }));
  });
  app.post<{ Params: { id: string } }>("/invoices/:id/payments", async (req, reply) => {
    const input = parse(z.object({ amountCents: z.number().int().positive(), method: z.string(), reference: z.string().optional() }), req.body);
    return reply.code(201).send(await recordPayment(db, { invoiceId: req.params.id, ...input }));
  });
  app.post<{ Params: { id: string } }>("/invoices/:id/disputes", async (req, reply) => {
    const input = parse(z.object({ raisedByPersonId: z.string().uuid().optional(), reason: z.string().min(3) }), req.body);
    return reply.code(201).send(await openDispute(db, { invoiceId: req.params.id, ...input }));
  });
  app.post<{ Params: { id: string } }>("/disputes/:id/resolve", async (req) => {
    const input = parse(z.object({ outcome: z.enum(["resolved_for_customer", "resolved_for_provider", "withdrawn"]), resolution: z.string().min(1) }), req.body);
    return resolveDispute(db, req.params.id, input.outcome, input.resolution);
  });
}
