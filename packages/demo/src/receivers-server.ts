// DEMO ONLY - remove before production
/**
 * Entry point: `npm run demo:receivers`. Starts the fake contractor receivers on
 * DEMO_RECEIVERS_PORT (default 3100). Point each demo provider's `offerWebhookUrl` at
 * http://localhost:3100/demo/receive-offer.
 */
import { DEMO_TAG, envInt } from "@labordispatch/shared";
import { buildReceiversServer, parseBehaviorEnv } from "./receivers.js";

const port = envInt("DEMO_RECEIVERS_PORT", 3100);
const host = process.env.HOST ?? "0.0.0.0";
const behavior = parseBehaviorEnv(process.env.DEMO_RECEIVER_BEHAVIOR);

console.log("==========================================================");
console.log(`  ${DEMO_TAG}`);
console.log("  Fake dispatch receivers (pretend contractors)");
console.log("==========================================================");
console.log(`[DEMO RECEIVER] behavior map: ${JSON.stringify(behavior)} (default: accept)`);
if (!process.env.API_TOKEN) console.log("[DEMO RECEIVER] WARNING: API_TOKEN not set; responses will send an empty bearer token");

const app = buildReceiversServer({ behavior });
await app.listen({ port, host });
console.log(`[DEMO RECEIVER] listening on http://${host}:${port}  (POST /demo/receive-offer, GET /demo/health)`);

const shutdown = async () => {
  console.log("[DEMO RECEIVER] shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
