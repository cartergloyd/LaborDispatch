export interface ApiConfig {
  port: number;
  host: string;
  publicUrl: string;
  apiToken: string;
  intakeModel: string;
  trustDays: number;
  holdMinutes: number;
  offerMinutes: number;
  chatwoot: { baseUrl: string; accountId: string; apiToken: string; webhookToken: string } | null;
  demoMode: boolean;
  allowUnverifiedProviders: boolean;
}

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (env: NodeJS.ProcessEnv, name: string, fallback = false) => {
  const v = env[name];
  return v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = int(env, "PORT", 3000);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`,
    apiToken: env.API_TOKEN ?? "",
    intakeModel: env.INTAKE_MODEL ?? "claude-opus-5-5",
    trustDays: int(env, "VERIFICATION_TRUST_DAYS", 90),
    holdMinutes: int(env, "APPOINTMENT_HOLD_MINUTES", 15),
    offerMinutes: int(env, "DISPATCH_OFFER_MINUTES", 20),
    chatwoot: env.CHATWOOT_API_TOKEN
      ? {
          baseUrl: (env.CHATWOOT_BASE_URL ?? "https://app.chatwoot.com").replace(/\/$/, ""),
          accountId: env.CHATWOOT_ACCOUNT_ID ?? "1",
          apiToken: env.CHATWOOT_API_TOKEN,
          webhookToken: env.CHATWOOT_WEBHOOK_TOKEN ?? "",
        }
      : null,
    demoMode: bool(env, "DEMO_MODE", false),
    // Never true in production: lets providers without verified license/insurance receive offers.
    allowUnverifiedProviders: bool(env, "ALLOW_UNVERIFIED_PROVIDERS", false),
  };
}
