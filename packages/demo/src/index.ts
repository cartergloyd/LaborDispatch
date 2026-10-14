// DEMO ONLY - remove before production
/**
 * @labordispatch/demo - fake problem generator + fake dispatch receivers.
 * Delete this whole package (and the /demo/* API routes, and the demo_scenarios table)
 * before production. See packages/demo/README.md.
 */
export { DEMO_TAG } from "@labordispatch/shared";
export {
  generateScenario,
  listScenarioTemplates,
  mulberry32,
  recordOutcome,
  recordScenario,
  SEED_PHONES,
  type DemoPersona,
  type DemoScenario,
  type DemoScenarioRow,
  type DemoVariant,
} from "./scenarios.js";
export {
  buildReceiversServer,
  offerPayloadSchema,
  parseBehaviorEnv,
  RECEIVER_BEHAVIORS,
  type OfferPayload,
  type ReceiverBehavior,
  type ReceiversDemoState,
  type ReceiversServerOptions,
} from "./receivers.js";
