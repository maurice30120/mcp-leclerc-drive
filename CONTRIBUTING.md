# Contributing to mcp-leclerc-drive

Thanks for helping! This is an early, community-driven tool — bug reports,
fixes, new tools, and support for other stores are all welcome.

## Ground rules

- Be respectful and constructive.
- This is an **unofficial** tool. Only ever test against **your own** Leclerc
  Drive account, at a personal request volume. Don't build anything that
  targets other people's accounts or hammers the site — that's both against the
  spirit of the project and a fast way to get blocked by DataDome.
- Keep changes focused; one logical change per pull request.

## Project layout

```
src/
  leclerc/api.ts     # PURE business logic: URLs + parsing + formatting
  types.ts           # Product / CartItem / Cart (the model the tools expose)
extension/
  manifest.json      # MV3, Leclerc-only permissions
  background.ts      # service worker: injects the bridge into the Leclerc tab
  inject.ts          # runs in the tab MAIN world: registers the 8 tools, fetch
docs/
  api-capture.md     # reverse-engineered Leclerc Drive API — read this first
  security.md        # threat model
scripts/
  build-extension.mjs# esbuild build → dist/extension/
```

Two layers matter:

1. **Tool surface** (`extension/inject.ts`) — what the model sees: tool names,
   descriptions, JSON-Schema inputs, and the `execute` handlers. Stable.
2. **Business logic** (`src/leclerc/api.ts`) — URL building, HTML/JSON parsing,
   cart assembly. Most backend contributions live here. It is **pure** on
   purpose: no `fetch`, no Node, no storage — so it can be unit-tested in
   isolation and bundled into the extension.

`api.ts` must stay fetch-free and Node-free. The only place that calls `fetch`
is `inject.ts`, and it uses the page's own fetch (cookies, DataDome, fingerprint
all authentic).

## Dev setup

Prerequisites: **Node 22+** (the relay requires it), and **Chrome logged into
Leclerc Drive** (the tools run inside that tab).

```bash
git clone https://github.com/skunkobi/mcp-leclerc-drive.git
cd mcp-leclerc-drive
npm install
npm run typecheck        # must pass before you open a PR
npm run build:extension # produces dist/extension/
```

## Extension dev flow

1. `npm run build:extension` → `dist/extension/`.
2. `chrome://extensions` → **Load unpacked** → select `dist/extension/`.
3. Open (or reload) your Leclerc Drive tab. The badge should read `ON`.
4. After any code change: rebuild, then hit **Reload** on the extension card
   (`chrome://extensions`) and reload the Leclerc tab so the bridge re-injects.

### Debugging

- **Background worker:** `chrome://extensions` → the extension's **"Inspect
  views: service worker"** link opens its DevTools (console + badge errors).
- **In-tab bridge:** the Leclerc tab's normal DevTools console (`Cmd/Ctrl+Opt+J`).
  Look for `[mcp-leclerc-drive]` logs and `document.modelContext.listTools()`.
- **Relay:** start it standalone to see its logs up front:
  `npx @mcp-b/webmcp-local-relay --widget-origin https://<your-drive-origin>`.

## Smoke test (relay-driven)

There's no mocked test suite (contributions welcome). For now, verify end-to-end
against your own logged-in tab:

1. Build the extension and load it in Chrome; open your Leclerc Drive tab;
   badge `ON`. Keep Chrome running.
2. Start the relay: `npx @mcp-b/webmcp-local-relay --widget-origin https://<your-drive-origin>`.
3. From your MCP client (or directly via the relay's MCP stdio), call:
   - `webmcp_list_sources` — should show the Leclerc tab as a connected source.
   - `webmcp_list_tools` — should list the 8 `search_product`, …, `get_store`.
   - `search_product`, `add_to_cart`, `get_cart`, `update_quantity`,
     `remove_from_cart` in sequence to exercise the live cart
     (**on your own account**: it adds one item, then cleans up).

A reusable `npm run smoke` wrapper for this is a good first contribution — see
the README's status checklist and the issues.

## Reverse-engineering a new endpoint

This is the heart of backend contributions (checkout, delivery slots, "mes
listes"…). Capture how the website does it, then replay it from `inject.ts`:

1. Open Leclerc Drive in Chrome with **DevTools → Network** open.
2. Perform the action on the site.
3. Inspect the request: URL, method, headers, and **request payload**. Cart
   actions POST to `panier.aspx?op=1` with a single form field
   `d=<URL-encoded JSON>`; other widgets embed data in the server-rendered HTML.
4. Note the **response** shape (usually a JSON event array).
5. Document your findings in [`docs/api-capture.md`](docs/api-capture.md).
6. Add the URL/parsing helpers to `src/leclerc/api.ts` as **pure** functions
   (no `fetch`), then call them from `inject.ts` using the page's `fetch`.

Tip: because the in-tab `fetch` carries your real session, you don't need to
replay cookies manually — DataDome is handled by the browser.

## Coding conventions

- TypeScript, ESM, `strict` mode. Match the style of the surrounding code.
- `api.ts` stays pure — no `fetch`, no Node/browser-only globals beyond standard
  JS. Submit fetch/navigation/storage code in `extension/inject.ts`.
- Comments in English so the project stays broadly contributable.
- Run `npm run typecheck` and `npm run build:extension` before pushing.

## Opening a pull request

1. Fork, branch (`git checkout -b my-change`).
2. Make the change; keep it focused.
3. Ensure `npm run typecheck` and `npm run build:extension` pass, and that you've
   smoke-tested if you touched the tool surface or `api.ts`.
4. Open the PR describing **what** changed and **how you verified** it.