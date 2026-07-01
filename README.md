# mcp-leclerc-drive

> Expose your **E.Leclerc Drive** as MCP tools via [WebMCP](https://docs.mcp-b.ai) — search products, manage your cart and refresh natively, from any MCP client (opencode, Claude Code, Cursor…). Tools run **inside your logged-in Chrome tab**, so authentication is just "be logged in" — no cookie copy-paste, no extracted credentials.

> 🟢 **v1.0 — WebMCP architecture.** Nine tools, validated live against the site. A tiny Chrome extension registers the tools in the Leclerc Drive tab; `@mcp-b/webmcp-local-relay` bridges them to your MCP client over stdio. See [`CHANGELOG.md`](CHANGELOG.md) for what changed from the old Node stdio server.

## Tools

| Tool | Description |
| --- | --- |
| `find_stores(query)` | Find drives near a postal code or city → name, id, service type, distance, host. |
| `set_store(store_id, host?)` | Select & remember the active store. Host must be a Leclerc Drive backend (`fdN-courses.leclercdrive.fr`). |
| `get_store()` | Show the currently selected store. |
| `search_product(query)` | Search the catalogue → products with price, price/kg, Nutri-Score, availability, and an `id`. |
| `add_to_cart(product_id, quantity?)` | Add a product to the cart. |
| `remove_from_cart(product_id)` | Remove a line from the cart. |
| `update_quantity(product_id, quantity)` | Set a line's quantity (0 removes it). |
| `get_cart()` | Read the full cart with total. |
| `list_habitual_products()` | List your « produits habitués » (the store's produits-habituels.aspx page). |

## How it works

```
opencode / Claude Code / any stdio MCP client
   │  stdio JSON-RPC
   ▼
@mcp-b/webmcp-local-relay        local Node process, 127.0.0.1:9333
   │  WebSocket, --widget-origin pinned to a Leclerc origin
   ▼
Chrome MV3 extension (background worker)
   │  chrome.scripting injects the bridge into the Leclerc tab (MAIN world)
   ▼
Leclerc Drive tab (open, logged in)   ← cookies + datadome are authentic,
                                        refreshed by the browser itself
```

There is no Node-side fetch, no cookie extraction, no on-disk secret. The whole
credential surface is the tab you're already logged into. See
[`docs/security.md`](docs/security.md) for the full threat model.

## Install

### 1. Build the extension

```bash
git clone https://github.com/skunkobi/mcp-leclerc-drive.git
cd mcp-leclerc-drive
npm install
npm run build:extension
```

This produces `dist/extension/` (a Chrome MV3 extension: manifest, background
service worker, the injected tool bridge, and the vendored relay embed script).

### 2. Load it in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select `dist/extension/`.
4. Open your Leclerc Drive tab and make sure you're **logged in** to your store.
   The extension's badge turns green (`ON`) once the tools are injected.

### 3. Wire up your MCP client

Use [`opencode.example.jsonc`](opencode.example.jsonc) as a template (opencode
reads `opencode.jsonc`). **Replace** the `--widget-origin` value with **your
own drive's origin** — the `fdN` prefix genuinely varies per store
(`fd8-`, `fd9-`, `fd14-`, …):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "leclerc-drive": {
      "type": "local",
      "command": [
        "npx", "-y", "@mcp-b/webmcp-local-relay@latest",
        "--widget-origin", "https://fd9-courses.leclercdrive.fr"
      ]
    }
  }
}
```

For other stdio MCP clients (Claude Code, Cursor, …), adapt the same
`command` into your client's `mcpServers` block. Then restart the client.

## Configuration & auth

**Auth = "be logged into Leclerc Drive in Chrome."** That's it.

- No `LECLERC_COOKIE`, no `LECLERC_CHROME_PROFILE`, no `LECLERC_HOST`/
  `LECLERC_STORE_ID` env vars anymore — they were all removed.
- The relay's `--widget-origin` is the one piece of config that matters: pin it
  to your drive's origin so only your Leclerc page can register tools.

Optional throttle tuning (rarely needed — the tab's fetch carries a real
fingerprint, so DataDome strikes are uncommon):

| Env / flag | Default | Description |
| --- | --- | --- |
| relay `--port` | `9333` | WebSocket port (must match the extension's `data-relay-port`). |
| relay `--widget-origin` | — (set it!) | Allowed Leclerc page origin(s). |

### Choosing your store

Just ask, in the conversation:

```
> "trouve mon drive vers 44000"     → find_stores lists nearby drives
> "prends Rezé Atout Sud"           → set_store remembers it (host is validated)
> "cherche du lait"                  → runs on that store
```

`set_store` persists the choice in the page's `localStorage`, scoped to the
Leclerc host. The host is validated against `fd\d+-courses.leclercdrive.fr`,
so a non-Leclerc host is refused (no SSRF).

> ⚠️ **One drive at a time.** Leclerc binds your session to a single drive. The
> store you `set_store` to must be the one your browser session is logged into.
> Switching to a drive your tab isn't on will return a "session expired" error
> — just open that drive's URL in Chrome and reload.

### If you hit a 403 (DataDome)

Open Leclerc Drive in Chrome and reload the page once to refresh the session,
then retry. The browser re-obtains its own DataDome cookie automatically; the
extension needs nothing from you.

## Development

```bash
npm run dev              # tsc --watch on the shared logic
npm run typecheck        # type-check src + extension (must pass before PR)
npm run build:extension  # build dist/extension/ (load into Chrome)
npm run build:all        # typecheck output + extension
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the extension dev flow (reload
after rebuild, debug the background worker and the in-tab console) and the
relay-driven smoke test.

## Architecture

```
src/
  leclerc/api.ts     # pure business logic: URLs + parsing + formatting (no fetch, no Node)
  types.ts           # Product / CartItem / Cart
extension/
  manifest.json      # MV3, Leclerc-only permissions
  background.ts      # injects the bridge into the Leclerc tab (MAIN world)
  inject.ts          # registers the 8 tools on document.modelContext + throttle/retry
scripts/
  build-extension.mjs# esbuild → dist/extension/
docs/
  api-capture.md     # the reverse-engineered Leclerc Drive API
  security.md        # threat model
opencode.example.jsonc
server.json          # MCP registry metadata
```

Business logic (`src/leclerc/api.ts`) is intentionally pure — it builds URLs
and parses HTML/JSON, with zero `fetch` and zero Node APIs — so it bundles
cleanly into the MV3 content script and stays unit-testable. The only place
that calls `fetch` is `extension/inject.ts`, and it uses the page's own fetch.

## Contributing

Community tool — contributions welcome (bug fixes, new capabilities: checkout,
delivery slots, saved lists…). See **[CONTRIBUTING.md](CONTRIBUTING.md)**, and
read [`docs/api-capture.md`](docs/api-capture.md) first if you're touching the
backend.

## Feedback & contact

- **Issues / PRs:** [open an issue](https://github.com/skunkobi/mcp-leclerc-drive/issues) on the repo.
- **Email:** alexandreyagoubi@gmail.com

## Disclaimer

Unofficial. Not affiliated with or endorsed by E.Leclerc. Use with your own
account, at your own risk, in line with the site's terms of service. Intended
for personal automation of your own grocery shopping.

## License

MIT