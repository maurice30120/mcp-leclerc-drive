# Local working tree vs. `origin/main`

State at the time of writing. `origin/main` HEAD = commit `9ec88a8`
("Add store locator… (0.2.0)"). The **local working tree is ahead** but
**uncommitted**: the v1.0.0 WebMCP refactor exists only as unstaged changes
(deleted files + untracked new files) on top of `origin/main`. `git status`
reports "up to date with origin/main" because none of the refactor is committed
yet.

## TL;DR

`origin/main` = a **Node stdio MCP server** that reads Chrome cookies from the
local browser profile and replays them with Node-side `fetch`. The local tree
= a **WebMCP** refactor where the tools run inside the logged-in Chrome tab via
an MV3 extension, bridged to stdio clients by `@mcp-b/webmcp-local-relay`. The
cookie-extraction stack and every `LECLERC_*` env var are gone.

## File-level diff vs. `origin/main`

### Deleted (the legacy Node server)

| File | Role in v0.2.0 | Where it went |
| --- | --- | --- |
| `src/index.ts` | MCP stdio server entry (`@modelcontextprotocol/sdk` + `zod`) | Replaced by the extension + relay; no binary published. |
| `src/auth/cookies.ts` | Read Chrome session cookies via `chrome-cookies-secure` | Eliminated — credentials never leave the tab. |
| `src/config.ts` | `LECLERC_*` env loading, defaults, `storePath` | Removed; `host`/`storeId` come from the tab URL + `localStorage`. |
| `src/store.ts` | Persisted store selection in `~/.mcp-leclerc-drive/config.json` | Now in page `localStorage` (`inject.ts`). |
| `src/leclerc/client.ts` | Node-side throttled fetch + HTML/JSON parsing + cart assembly | Parsing folded into `src/leclerc/api.ts` (pure), fetch into `inject.ts`. |
| `src/leclerc/locator.ts` | Store-finder REST client (Node) | URL builders + response shapes moved to `src/leclerc/api.ts`. |
| `src/leclerc/throttle.ts` | `Throttler` class used by client/locator | Re-implemented inline in `inject.ts` (works in the page). |
| `src/types/chrome-cookies-secure.d.ts` | Type shim for the cookie lib | Gone with the lib. |
| `scripts/smoke-test.mjs` | Node smoke harness | Removed; relay-driven smoke flow described in `CONTRIBUTING.md`. |

### Added (the WebMCP architecture)

| File | Role |
| --- | --- |
| `extension/manifest.json` | MV3 manifest, Leclerc-only permissions. |
| `extension/background.ts` | Service worker: inject `[inject.js, embed.js]` into the Leclerc tab (MAIN world). |
| `extension/inject.ts` | Registers the 9 tools on `document.modelContext`; in-page fetch + throttle. |
| `src/leclerc/api.ts` | Pure business logic (URLs, parsing, cart assembly, formatting); shared. |
| `scripts/build-extension.mjs` | esbuild build → `dist/extension/`. |
| `tsconfig.extension.json` | Type-check the extension bundle (chrome types, DOM lib). |
| `opencode.example.jsonc` / `opencode.jsonc` | MCP-client config launching the relay. |
| `CHANGELOG.md` | 1.0.0 changelog. |
| `docs/security.md` | Updated threat model. |
| `.agents/`, `skills-lock.json` | Local agent tooling (not project runtime). |

### Modified

| File | Change |
| --- | --- |
| `README.md` | Rewritten for the WebMCP flow (install, config, 9 tools). |
| `CONTRIBUTING.md` | Extension dev flow, relay smoke test, purity rule for `api.ts`. |
| `package.json` | Version 0.2.0 → 1.0.0; deps swap (`@modelcontextprotocol/sdk`/`zod`/`chrome-cookies-secure` → `@mcp-b/global` + `@mcp-b/webmcp-local-relay`); `engines.node` 18 → 22; `bin`/`start`/`inspect`/`smoke`/`prepublishOnly` scripts and the CVE `overrides` block removed; `build:extension`/`build:all` added. |
| `server.json` | v1.0.0; advertises the WebMCP-relay transport + extension path. |
| `tsconfig.json` | Excludes `extension`; the extension has its own tsconfig. |

## Behavior parity (what survived the refactor)

Same set of user-facing operations, same backend endpoints, same response
parsing:
- `find_stores` / `set_store` / `get_store` — same 3-call store-finder REST API.
- `search_product` — same `recherche.aspx?TexteRecherche=` HTML scrape, same
  `iIdProduit`-record extraction.
- `add_to_cart` / `remove_from_cart` / `update_quantity` — same
  `POST panier.aspx?op=1`, `d=<URL-encoded JSON>`, `eTypeAction` 1/2, absolute
  target quantity. `update_quantity` still reads current qty to pick ADD vs SUB.
- `get_cart` — same no-match-query HTML scrape + `lstProduits`/`lstProduitsLight`
  parsing.
- Throttle behavior (serialize + space + jitter + retry/backoff on 403/429)
  survives, just relocated from a `Throttler` class into `inject.ts`.

**New tool:** `list_habitual_products` (the `produits-habituels.aspx` page) was
not in `origin/main`.

## Critical behavioral differences vs. the additions

Things that are not just "same logic, new host" — they change how the project
behaves or what it can do:

1. **Auth model flip — biggest risk.** v0.2.0 could run headless
   (`LECLERC_COOKIE` on a VPS/CI). v1.0.0 **requires** a logged-in Chrome tab +
   the extension loaded + the relay running. There is no headless path. This
   is the main regression to flag to anyone Deploying differently.
2. **One-drive-at-a-time is now a runtime constraint, not a persisted choice.**
   v0.2.0 persisted the store in `~/.mcp-leclerc-drive/config.json` and the
   Node fetch could target any host it had cookies for. v1.0.0 persists in
   page `localStorage` but the tab itself is bound to one drive; `set_store` to
   a drive the tab isn't on returns "session expirée" (no server-side rebinding
   — this was already an open item in `api-capture.md`, now structural).
3. **`list_habitual_products` depends on the tab URL, not the saved store.**
   It derives the store prefix from `/magasin-<id>-<id>-<slug>/` in
   `window.location`, so it only works while the user is literally on a store
   page. The other tools work from `localStorage` + tab host. This asymmetry is
   a footgun: a user who ran `set_store` hours ago but navigated away from the
   store page will get a clean error from this one tool only.
4. **No published npm binary anymore.** v0.2.0 shipped `bin.mcp-leclerc-drive`
   (a stdio server you `npx`'d). v1.0.0 publishes nothing runnable; the MCP
   client `npx`es the **relay**, and you load the extension manually. The
   `server.json` transport is `stdio` but the `transportHint` explains this —
   downstream consumers must read it or they'll be confused.
5. **`objContexteProvenanceArticle` is dropped from the mutation body.**
   v0.2.0's `client.ts` sent analytics context; `api.ts`'s
   `cartMutationBody` omits it entirely (confirmed optional on remove, *not*
   verified on add — see `api-capture.md` open item). Functionally the cart
   ops work, but this is an unverified fidelity gap vs. the browser's own
   requests.
6. **Throttle constants differ.** `MIN_INTERVAL_MS` 1000→600, `BACKOFF_BASE_MS`
   1500→1200. Tuned for the page's real fingerprint (DataDome strikes are
   rarer in-tab), but if a user *does* get struck, the backoff is slightly
   less conservative than the old Node path. Low risk, worth noting.
7. **Persisted store no longer has a per-host fallback `LECLERC_HOST`/`STORE_ID`.**
   First-run now *requires* the tab to be open on a Leclerc store page
   (`currentStoreFromUrl`) or a prior `set_store`; there's no env default.
   Cleaner, but zero-config headlessness is gone (see #1).

## What remains to do (from `api-capture.md` open items + status)

Still open in v1.0.0, carried over from v0.2.0:
- Confirm `objContexteProvenanceArticle` is fully omittable on **add** (only
  verified on remove).
- Find a clean read-only cart endpoint (today we scrape a no-match search page).
- DataDome cookie lifetime / refresh behaviour for long-lived sessions.
- **Reverse-engineer the "switch drive" call** so `set_store` can rebind the
  session server-side — today `set_store` to a drive the tab isn't on fails.
  This is now the single biggest usability gap of the new architecture.

Newly introduced TODOs by the refactor:
- A reusable `npm run smoke` wrapper for the relay-driven smoke test (described
  in `CONTRIBUTING.md` but not scripted).
- A real test suite — there is currently no mocked test harness, only a manual
  relay smoke flow. `api.ts` being pure makes adding unit tests cheap.
- Document/decide what happens if Leclerc ships a Content-Security-Policy that
  blocks MAIN-world scripts (the documented fallback is a CSP-exempt
  `chrome.scripting` user-script runner — not implemented).

## How to verify the refactor is complete

- `git diff --numstat origin/main` should show only the files above.
- `npm run typecheck` (`tsc --noEmit` + extension tsconfig) must pass.
- `npm run build:extension` must produce `dist/extension/{manifest,background,
  inject,embed}.js`.
- Load `dist/extension/` in Chrome, open a Leclerc Drive tab → badge `ON`; via
  the relay, `webmcp_list_tools` lists all 9 tools and the cart ops round-trip
  on your own account.

## See also

- [`adr/`](adr/) — the *why* behind the WebMCP flip, the pure-logic split, the
  MAIN-world injection, the host-validation gate, etc.
- [`security.md`](security.md) — threat model delta from the cookie-extraction
  era.