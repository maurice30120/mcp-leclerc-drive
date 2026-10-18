/**
 * Report sanitizer (ticket #46, spec issue #40).
 *
 * Every artifact a campaign writes (results.json, summary.md, CSV, JSONL)
 * passes through this function first: no Mistral key, no Bearer token, no
 * Authorization/cookie header value and no passed-in secret (e.g. the
 * MISTRAPI_KEY used for a run) may ever appear in a produced file.
 *
 * Pure: returns a new structure, never mutates the input. Works on any
 * JSON-serializable value (objects, arrays, primitives).
 */

/** Placeholder substituted for every redacted secret. */
export const SANITIZED_PLACEHOLDER = "[masqué]";

/**
 * Secret-shaped patterns redacted even when no secret list is provided:
 * Mistral-style keys (sk-…), Bearer tokens, basic credentials in URLs.
 */
const SECRET_SHAPED_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi,
  /(?<=:\/\/)[A-Za-z0-9._~+-]+:[A-Za-z0-9._~+-]+@/g,
];

/**
 * Object keys whose VALUE is always a secret, whatever it contains
 * (case-insensitive, dashes/underscores equivalent).
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "mistralapikey",
  "mistralkey",
  "accesstoken",
  "refreshtoken",
  "apitoken",
  "secret",
  "password",
  "sessiontoken",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(normalizeKey(key));
}

function redactString(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const pattern of SECRET_SHAPED_PATTERNS) {
    result = result.replace(pattern, SANITIZED_PLACEHOLDER);
  }
  for (const secret of secrets) {
    if (secret.length >= 3) {
      result = result.split(secret).join(SANITIZED_PLACEHOLDER);
    }
  }
  return result;
}

function sanitizeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] =
        typeof inner === "string" && (isSecretKey(key) || secrets.includes(inner))
          ? SANITIZED_PLACEHOLDER
          : sanitizeValue(inner, secrets);
    }
    return sanitized;
  }
  return value;
}

/**
 * Recursively redacts secrets from any JSON-serializable structure:
 * passed-in secret values (exact strings and substrings), secret-shaped
 * patterns (sk-…, Bearer/Basic tokens, URL credentials), and the values of
 * sensitive keys (Authorization, Cookie, api_key, access_token, …).
 */
export function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
  const usable = secrets.filter((secret) => typeof secret === "string" && secret.length >= 3);
  return sanitizeValue(value, usable);
}
