# Changelog

## 1.0.0 — WebMCP / opencode refactor

Complete rearchitecture to the **WebMCP** model (MCP-B): the Leclerc Drive
catalogue and cart are now driven from inside a real Chrome tab via a tiny MV3
extension, instead of a Node stdio server that extracted cookies from the local
browser profile.

### Added

- **`extension/`** — a Manifest V3 Chrome extension (`scripting` +
  `activeTab` only, host-permission restricted to `*.leclercdrive.fr`) that
  injects the WebMCP runtime (`@mcp-b/global`) and our 8 tools into the live
  Leclerc Drive tab in the page's `MAIN` world, where the session cookies and
  DataDome fingerprint are authentic and auto-refreshed by the browser.
- **`src/leclerc/api.ts`** — the Leclerc business logic (URL building, HTML/JSON
  parsing, cart assembly, store-finder URLs, formatting) extracted as pure,
  Node-free, fetch-free functions, shared by the extension injector and
  type-checkable in isolation.
- **`opencode.example.jsonc`** — drop-in MCP config for opencode (and any stdio
  MCP client) launching `@mcp-b/webmcp-local-relay` with `--widget-origin`
  pinned to a Leclerc origin.
- **`docs/security.md`** — updated threat model (loopback-only relay, Leclerc
  origin whitelist, no cookie extraction on the Node side, the live tab is the
  only credential surface).
- **`scripts/build-extension.mjs`** — esbuild-based build producing
  `dist/extension/` (manifest + background + inject + vendored relay embed).
- All 9 tools: `search_product`, `add_to_cart`, `remove_from_cart`,
  `update_quantity`, `get_cart`, `find_stores`, `set_store`, `get_store`,
  `list_habitual_products`.

### Removed

- The Node stdio MCP server (`src/index.ts`) — the local relay bridges tools
  from the browser to any stdio MCP client; no binary is published anymore.
- `src/auth/cookies.ts` and the `chrome-cookies-secure` dependency (plus the
  `sqlite3`/`better-sqlite3` chain it pulled in) — **eliminates all the
  transitive CVEs** the legacy cookie-extraction path carried.
- `src/config.ts`, `src/store.ts` — config is now the live tab; store selection
  lives in the page's `localStorage`.
- `src/leclerc/client.ts`, `src/leclerc/locator.ts`, `src/leclerc/throttle.ts`
  in their Node form — the fetch lives in the tab now; locator URLs and the
  throttle policy were folded into `api.ts` and `extension/inject.ts`.
- `LECLERC_COOKIE` / `LECLERC_CHROME_PROFILE` / `LECLERC_HOST` /
  `LECLERC_STORE_ID` env vars — auth is simply "be logged into Leclerc Drive
  in Chrome"; no secret transits a config file or a process environment.
- The legacy `scripts/smoke-test.mjs` Node harness (a new relay-driven harness
  is described in `CONTRIBUTING.md`).
- `package.json` `bin`/`files`, and the native-build `overrides` block
  (`tar`, `node-gyp`, `cacache`, `make-fetch-happen`, `http-proxy-agent`).

### Security

- **SSRF closure:** every host passed to `fetch` is validated with
  `isLeclercHost(/^fd\d+-courses\.leclercdrive\.fr$/)`. `set_store` refuses a
  non-Leclerc host.
- **Prompt-injection hardening:** store/product names are scrubbed of
  `<system>`/`<|im_start|>`-style sequences before being returned to the LLM,
  and tool descriptions warn that Leclerc-side labels are untrusted.
- **Minimum permissions:** Leclerc-only `host_permissions`, no `cookies`
  permission, no `<all_urls>`.
- **Relay lockdown:** `--widget-origin` restricts tool registration to the
  Leclerc page origin; a non-Leclerc page cannot push tools to the relay.
- **No secret in env:** dropping `LECLERC_COOKIE` removes the fuite-via-`ps` /
  versioned-config vector entirely.

### Notes

- `engines.node` raised to `>=22` (the relay requires it).
- Leclerc currently ships no page CSP; `chrome.scripting` `MAIN`-world injection
  works as-is. Should they add a blocking CSP later, the fallback is a
  user-script runner (also `MAIN`-world, CSP-exempt) — the isolated `api.ts`
  makes that swap ~1 file.