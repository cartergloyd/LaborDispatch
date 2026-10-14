export * from "./enums.js";
export * from "./phone.js";
export * from "./schemas.js";

/** Marker put on every demo-generated record so it can be purged before production. */
export const DEMO_TAG = "DEMO ONLY - remove before production";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
