/** Glue between transports (Chatwoot webhook, direct chat API, demo) and the intake engine. */
import type { Db } from "@labordispatch/db";
import { findOrCreateConversation, handleInboundMessage, type IntakeConfig } from "@labordispatch/intake-agent";
import type { ConversationChannel } from "@labordispatch/shared";
import type { ApiConfig } from "./config.js";

export interface IntakeDeps {
  db: Db;
  config: ApiConfig;
  intake: Pick<IntakeConfig, "client" | "onVerificationCode" | "onEscalate">;
}

export async function runIntake(
  deps: IntakeDeps,
  input: {
    channel: ConversationChannel;
    externalId: string;
    externalAccountId?: string | null;
    inboundIdentifier?: string | null;
    text: string;
    messageExternalId?: string | null;
    isDemo?: boolean;
    onEscalate?: IntakeConfig["onEscalate"];
  },
) {
  const convo = await findOrCreateConversation(deps.db, {
    channel: input.channel,
    externalId: input.externalId,
    externalAccountId: input.externalAccountId ?? null,
    inboundIdentifier: input.inboundIdentifier ?? null,
    isDemo: input.isDemo ?? false,
  });
  return handleInboundMessage(
    deps.db,
    { conversationId: convo.id, text: input.text, externalId: input.messageExternalId ?? null },
    {
      model: deps.config.intakeModel,
      trustDays: deps.config.trustDays,
      holdMinutes: deps.config.holdMinutes,
      client: deps.intake.client,
      onVerificationCode: deps.intake.onVerificationCode,
      onEscalate: input.onEscalate ?? deps.intake.onEscalate,
    },
  );
}
