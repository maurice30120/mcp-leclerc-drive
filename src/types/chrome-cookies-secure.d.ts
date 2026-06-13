/** Minimal ambient types for chrome-cookies-secure (no official @types). */
declare module "chrome-cookies-secure" {
  export type CookieFormat = "object" | "header" | "jar" | "set-cookie" | "puppeteer";

  /** With format "header", resolves to a `name=value; ...` Cookie header string. */
  export function getCookiesPromised(
    url: string,
    format?: CookieFormat,
    profile?: string,
  ): Promise<string>;

  export function getCookies(
    url: string,
    format: CookieFormat,
    callback: (err: Error | null, cookies: string) => void,
    profile?: string,
  ): void;
}
