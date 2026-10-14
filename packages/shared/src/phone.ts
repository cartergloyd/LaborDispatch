/**
 * Phone normalization to E.164. Deliberately simple (US-first) with no external dependency.
 * Anything we cannot confidently normalize is rejected rather than guessed.
 */
export function normalizePhone(raw: string, defaultCountry: "US" = "US"): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) {
    const rest = digits.slice(1);
    if (!/^\d{8,15}$/.test(rest)) return null;
    return `+${rest}`;
  }
  if (defaultCountry === "US") {
    if (/^\d{10}$/.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  }
  return null;
}

/** Mask a phone for logs/UI: +1******1234 */
export function maskPhone(e164: string): string {
  if (e164.length <= 4) return "****";
  return `${e164.slice(0, 2)}${"*".repeat(Math.max(0, e164.length - 6))}${e164.slice(-4)}`;
}
