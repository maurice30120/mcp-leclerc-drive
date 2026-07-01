# Architecture

How `mcp-leclerc-drive` is put together under the **WebMCP** model (v1.0.0).

## Components

### 1. The Chrome MV3 extension (`extension/`)

The shipped artifact lives in `dist/extension/` after `npm run build:extension`.

- **`manifest.json`** — Manifest V3. Permissions: `scripting`, `activeTab`,
  `storage`; host permissions restricted to `*://*.leclercdrive.fr/*` only. No
  `cookies`, no `tabs`, no `<all_urls>`.
- **`background.ts`** (service worker) — listens to `chrome.tabs.onUpdated` for
  Leclerc Drive navigations (`hostSuffix: leclercdrive.fr`) and, on `complete`,
  injects `["inject.js", "embed.js"]` into the tab's **MAIN world** via
  `chrome.scripting.executeScript`. Also re-injects into already-open Leclerc
  tabs on `onStartup` / `onInstalled`. Sets a badge (`ON` green / `ERR` red).
- **`inject.ts`** (runs in the page's MAIN world) — installs
  `document.modelContext` via `@mcp-b/global` (`initializeWebModelContext`,
  auto-init for the Tab + Iframe transports), then registers the 9 Leclerc
  tools on it. Guarded by `window.__mcpLeclercDriveInjected` so it's idempotent.
  Owns the in-page **throttle** (serialize + space + jitter + retry/backoff on
  403/429) and the only `fetch` calls in the project.
- **`embed.js`** — vendored from `@mcp-b/webmcp-local-relay/dist/browser/embed.js`
  at build time ([`scripts/build-extension.mjs`](../scripts/build-extension.mjs)).
  Opens the WebSocket to the local relay and forwards the registered tools as
  first-class MCP tools. Injected *after* `inject.js` so it sees a ready
  `document.modelContext`.

> MAIN-world scripts cannot use `chrome.*` APIs, so anything chrome-related
> (the relay embed) is driven purely through the **list ordering** in the
> background worker. `inject.ts` never injects `embed.js` itself.

### 2. Pure business logic (`src/leclerc/api.ts`)

URL building, HTML/JSON parsing, cart assembly, store-finder URL helpers,
formatting. **No `fetch`, no Node, no browser storage.** This is what makes it
bundleable into the MV3 content script and unit-testable in isolation. The
extension's tsconfig (`tsconfig.extension.json`) includes this file plus
`src/types.ts`.

Highlights:
- `searchUrl` / `cartUrl` / `storePath` — drive URL construction (slug is
  cosmetic, backend keys off `magasin-{storeId}-{noPR}`).
- `assertStorePage` — DataDome / expired-session guard: every real store page
  carries `lstProduitsLight`; if missing, throw an actionable message.
- `extractArrayNamed` / `scanProductRecords` / `smallestEnclosingObject` —
  tolerant extraction of product records from JS literals that may contain
  non-JSON members.
- `cartFromHtml` / `cartFromEvents` — assemble a `Cart` either from a search
  page (POST-event JSON array) or a no-match search page (HTML scrape).
- `cartMutationBody` — build the `d=<URL-encoded JSON>` form body.
- `autocompleteUrl` / `coordinatesUrl` / `nearbyUrl` — store-finder REST URLs.
- `isLeclercHost` (`/^fd\d+-courses\.leclercdrive\.fr$/`) — the SSRF gate.

### 3. Domain types (`src/types.ts`)

`Product`, `CartItem`, `Cart` — the shapes the tools expose to the model. The
raw backend shapes (`RawProduct`, `CartEvent`) live in `api.ts` and are mapped
into these by `mapProduct` / `cartFrom*`.

### 4. The local relay (`@mcp-b/webmcp-local-relay`, dev dependency)

A local Node process launched by the MCP client (opencode / Claude Code) over
stdio. It listens on `127.0.0.1:9333` and bridges WebSocket ↔ stdio JSON-RPC.
Configured per-drive with `--widget-origin https://fdN-courses.leclercdrive.fr`
so only your Leclerc page can register tools.

### 5. Registry + config metadata

- [`server.json`](../server.json) — MCP registry metadata (`io.github.skunkobi/leclerc-drive`).
  Explicitly advertises that this is a *WebMCP relay*, not a classic stdio server.
- [`opencode.example.jsonc`](../opencode.example.jsonc) — drop-in MCP config
  template. [`opencode.jsonc`](../opencode.jsonc) is the local dev copy.

## Data flow (a search_product call)

1. MCP client sends `tools/call search_product { query: "lait" }` over stdio.
2. Relay forwards it over the WebSocket to the connected Leclerc tab (the source).
3. `embed.js` delivers it to `document.modelContext`, which dispatches to the
   registered `search_product` executor in `inject.ts`.
4. `inject.ts` resolves the active store (`loadStore` → URL `localStorage` ↔
   `window.location`), builds `searchUrl(…)` via `api.ts`, and calls
   `getHtml` — the page's own `fetch` with `credentials: "include"`, throttled.
5. `assertStorePage` guards the HTML; `productsFromHtml` parses product records.
6. Labels are passed through `scrubUntrusted` (strip `<system>` /
   `<|im_start|>`-style sequences) and `formatProduct`-rendered.
7. The `CallToolResult` text returns the same path back to the MCP client.

## Build

`scripts/build-extension.mjs` (esbuild, no Vite):
- substitutes `{{EXTENSION_VERSION}}` in the manifest from `package.json`,
- bundles `extension/inject.ts` and `extension/background.ts` as IIFE (MV3
  classic scripts can't be ESM-as-module in the service worker without care),
- vendors `embed.js` from the relay package so the extension works offline,
  with no CDN dependency at runtime.

Outputs land in `dist/extension/`. `npm run build:all` also runs `tsc` for the
dist types.