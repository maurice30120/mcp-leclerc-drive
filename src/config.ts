/**
 * Runtime configuration, sourced from environment variables.
 *
 * Auth model (v0.1): the cookie is normally read straight from your local
 * Chrome session (see src/auth/cookies.ts) — log into Leclerc Drive in Chrome
 * once and the server borrows that session, DataDome cookie included. For
 * headless deploys (VPS / CI) where there is no browser, set LECLERC_COOKIE to
 * a captured Cookie header and it takes precedence.
 */

export type CookieSource = "auto" | "chrome" | "env";

export interface LeclercConfig {
  /** Store identifier, e.g. "053701" (La Ville-aux-Dames). */
  storeId: string;
  /**
   * Host serving the drive backend for this store, e.g.
   * "fd9-courses.leclercdrive.fr". The "fdN" prefix varies by store/region.
   */
  host: string;
  /**
   * Explicit Cookie header override. When set, it is used as-is and Chrome is
   * not read. Leave empty to read from the local browser.
   */
  cookie: string;
  /** Chrome profile directory to read cookies from (default "Default"). */
  chromeProfile: string | undefined;

  // --- Anti-strike (DataDome) throttling ---
  /** Minimum delay between two requests, in ms. */
  minIntervalMs: number;
  /** Extra random jitter added between requests, in ms. */
  jitterMs: number;
  /** Retries on a 403/429 before giving up. */
  maxRetries: number;
  /** Base backoff for retries, in ms (doubles each attempt). */
  backoffBaseMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_STORE_ID = "053701";
const DEFAULT_HOST = "fd9-courses.leclercdrive.fr";

export function loadConfig(): LeclercConfig {
  return {
    storeId: process.env.LECLERC_STORE_ID?.trim() || DEFAULT_STORE_ID,
    host: process.env.LECLERC_HOST?.trim() || DEFAULT_HOST,
    cookie: process.env.LECLERC_COOKIE?.trim() || "",
    chromeProfile: process.env.LECLERC_CHROME_PROFILE?.trim() || undefined,
    minIntervalMs: intEnv("LECLERC_MIN_INTERVAL_MS", 1000),
    jitterMs: intEnv("LECLERC_JITTER_MS", 400),
    maxRetries: intEnv("LECLERC_MAX_RETRIES", 3),
    backoffBaseMs: intEnv("LECLERC_BACKOFF_BASE_MS", 1500),
  };
}

/** Which source the cookie will come from, for logging. */
export function cookieSourceOf(config: LeclercConfig): CookieSource {
  return config.cookie ? "env" : "chrome";
}

/** Store path segment used by the backend (no cosmetic slug). */
export function storePath(storeId: string): string {
  // Leclerc store URLs embed the id twice plus a slug, e.g.
  // /magasin-053701-053701-La-Ville-aux-Dames/. The slug is cosmetic; the
  // backend keys off the id, so a minimal path works for API calls.
  return `magasin-${storeId}-${storeId}`;
}
