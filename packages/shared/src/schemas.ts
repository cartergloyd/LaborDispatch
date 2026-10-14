import { z } from "zod";
import {
  CONTACT_METHOD_KINDS,
  FACT_CATEGORIES,
  FACT_SOURCES,
  PARTY_ROLES,
  TRADES,
  URGENCIES,
  WORK_ORDER_STATUSES,
} from "./enums.js";

export const uuid = z.string().uuid();

export const AddressInput = z.object({
  line1: z.string().min(1),
  line2: z.string().optional().nullable(),
  city: z.string().min(1),
  state: z.string().min(2).max(2),
  postalCode: z.string().min(3),
  country: z.string().length(2).default("US"),
  nickname: z.string().optional().nullable(),
});
export type AddressInput = z.infer<typeof AddressInput>;

export const PersonInput = z.object({
  displayName: z.string().min(1),
  contactMethods: z
    .array(
      z.object({
        kind: z.enum(CONTACT_METHOD_KINDS),
        value: z.string().min(3),
      }),
    )
    .default([]),
});
export type PersonInput = z.infer<typeof PersonInput>;

export const PartyInput = z.object({
  personId: uuid,
  role: z.enum(PARTY_ROLES),
  isBillingResponsible: z.boolean().default(false),
});

export const PropertyFactInput = z.object({
  category: z.enum(FACT_CATEGORIES),
  key: z.string().min(1),
  value: z.unknown(),
  source: z.enum(FACT_SOURCES),
  confidence: z.number().min(0).max(1),
  observedAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});
export type PropertyFactInput = z.infer<typeof PropertyFactInput>;

export const WorkOrderCreateInput = z.object({
  propertyId: uuid,
  reportedByPersonId: uuid.optional().nullable(),
  trade: z.enum(TRADES),
  urgency: z.enum(URGENCIES),
  title: z.string().min(3).max(140),
  description: z.string().min(3),
  symptoms: z.array(z.string()).default([]),
  troubleshootingPerformed: z.array(z.string()).default([]),
  isLargeProject: z.boolean().default(false),
  conversationId: uuid.optional().nullable(),
});
export type WorkOrderCreateInput = z.infer<typeof WorkOrderCreateInput>;

export const WorkOrderStatusInput = z.object({
  status: z.enum(WORK_ORDER_STATUSES),
  note: z.string().optional(),
});

export const TimeWindowInput = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
});

/** Chatwoot webhook payload - only the fields we rely on; everything else is passed through. */
export const ChatwootWebhook = z
  .object({
    event: z.string(),
    id: z.union([z.number(), z.string()]).optional(),
    content: z.string().nullable().optional(),
    message_type: z.union([z.literal("incoming"), z.literal("outgoing"), z.literal("template"), z.number()]).optional(),
    private: z.boolean().optional(),
    account: z.object({ id: z.union([z.number(), z.string()]) }).passthrough().optional(),
    inbox: z.object({ id: z.union([z.number(), z.string()]) }).passthrough().optional(),
    conversation: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        display_id: z.union([z.number(), z.string()]).optional(),
        inbox_id: z.union([z.number(), z.string()]).optional(),
        channel: z.string().optional(),
        meta: z
          .object({
            sender: z
              .object({
                id: z.union([z.number(), z.string()]).optional(),
                name: z.string().nullable().optional(),
                phone_number: z.string().nullable().optional(),
                email: z.string().nullable().optional(),
                identifier: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    sender: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        name: z.string().nullable().optional(),
        type: z.string().optional(),
        phone_number: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        identifier: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    contact: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        name: z.string().nullable().optional(),
        phone_number: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        identifier: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ChatwootWebhook = z.infer<typeof ChatwootWebhook>;
