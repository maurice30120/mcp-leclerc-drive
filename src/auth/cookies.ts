/**
 * Cookie resolution.
 *
 * A CookieProvider returns the `Cookie` header string to replay against Leclerc
 * Drive. Two sources:
 *
 *  - env override (LECLERC_COOKIE): returned as-is, static.
 *  - Chrome (default): reads the live session from your local Chrome cookie
 *    store, scoped to the Leclerc host (so the `datadome` cookie comes along).
 *    On macOS this triggers a one-time Keychain prompt ("Chrome Safe Storage").
 *
 * The Chrome read is cached briefly so we don't hit the Keychain on every tool
 * call, while still picking up a refreshed session within a minute.
 * `invalidate()` drops the cache so the next `get()` re-reads Chrome — used by
 * the client after a DataDome challenge, since a real browser refreshes its
 * `datadome` cookie on its own.
 */

import { getCookiesPromised } from "chrome-cookies-secure";
import { LeclercConfig } from "../config.js";

export interface CookieProvider {
  get(): Promise<string>;
  invalidate(): void;
}

const CACHE_TTL_MS = 60_000;

export function createCookieProvider(config: LeclercConfig): CookieProvider {
  if (config.cookie) {
    const fixed = config.cookie;
    return { get: async () => fixed, invalidate: () => {} };
  }

  const url = `https://${config.host}/`;
  const profile = config.chromeProfile; // undefined → lib default "Default"
  let cache: { value: string; at: number } | null = null;

  return {
    invalidate() {
      cache = null;
    },

    async get() {
      const now = Date.now();
      if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

      let header: string;
      try {
        header = await getCookiesPromised(url, "header", profile);
      } catch (err) {
        throw new Error(
          `Could not read cookies from Chrome for ${config.host}: ` +
            `${(err as Error).message}. Is Chrome installed and the "${profile ?? "Default"}" ` +
            `profile logged into Leclerc Drive? On a headless host, set LECLERC_COOKIE instead.`,
        );
      }

      if (!header || !header.trim()) {
        throw new Error(
          `No Leclerc Drive cookies found in Chrome for ${config.host}. ` +
            `Log into Leclerc Drive in Chrome first (profile "${profile ?? "Default"}").`,
        );
      }

      cache = { value: header, at: now };
      return header;
    },
  };
}
