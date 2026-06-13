# mcp-leclerc-drive

> The first open-source **MCP server for E.Leclerc Drive** — let Claude search products, manage a cart, and prepare grocery orders natively, instead of clicking through the website.

> 🟢 **v0.1 — working.** All five tools are implemented and **validated end-to-end against the live site** (store 053701): search, add, read, update, remove. Auth reads your existing Chrome session automatically (no copy-paste). See [`docs/api-capture.md`](docs/api-capture.md) for the reverse-engineered API.

## Why

E.Leclerc Drive has no public API. Today the only way to automate it is browser automation — slow (~3–5 s per item) and fragile (blind clicks). This project exposes the underlying operations as proper MCP tools so any MCP client (Claude Desktop, Claude Code) can drive it directly.

## Tools

| Tool | Description |
| --- | --- |
| `search_product(query)` | Search the catalogue → products with price, price/kg, Nutri-Score, availability, and an `id`. |
| `add_to_cart(product_id, quantity?)` | Add a product to the cart. |
| `remove_from_cart(product_id)` | Remove a line from the cart. |
| `update_quantity(product_id, quantity)` | Set a line's quantity (0 removes it). |
| `get_cart()` | Read the full cart with total. |

## Status

- [x] MCP server scaffold (stdio, `@modelcontextprotocol/sdk`)
- [x] Tool contracts (`search_product`, `add_to_cart`, `remove_from_cart`, `update_quantity`, `get_cart`)
- [x] Cookie-based auth model
- [x] **Reverse-engineer Leclerc Drive endpoints** (validated live — see [`docs/api-capture.md`](docs/api-capture.md))
- [x] Wire endpoints into [`src/leclerc/client.ts`](src/leclerc/client.ts)
- [x] Auto-read auth cookie from the local Chrome session ([`src/auth/cookies.ts`](src/auth/cookies.ts))
- [x] **End-to-end validation of all five tools against the live store** ✅
- [ ] Test under Claude Desktop / Claude Code (MCP client integration)
- [ ] Handle DataDome cookie refresh / session expiry gracefully
- [ ] Publish to npm + submit to MCP registry

## Install (development)

```bash
git clone https://github.com/skunkobi/mcp-leclerc-drive.git
cd mcp-leclerc-drive
npm install
npm run build
```

## Configuration & auth

**Default (recommended): borrow your Chrome session.** Log into Leclerc Drive in
Chrome once. The server reads the session cookie (incl. the `datadome` cookie)
directly from your local Chrome profile — no copy-paste, and it refreshes itself
as your browser session does. On macOS the first read triggers a one-time
Keychain prompt ("Chrome Safe Storage"); approve it. The server must run on the
same machine as Chrome.

**Headless deploys (VPS / CI):** set `LECLERC_COOKIE` to a captured `Cookie`
header and it takes precedence over Chrome (note: a captured DataDome cookie
expires, so this needs periodic refreshing).

| Env var | Default | Description |
| --- | --- | --- |
| `LECLERC_STORE_ID` | `053701` | Store id (La Ville-aux-Dames). |
| `LECLERC_HOST` | `fd9-courses.leclercdrive.fr` | Backend host (the `fdN` prefix varies by store). |
| `LECLERC_CHROME_PROFILE` | `Default` | Chrome profile directory to read cookies from. |
| `LECLERC_COOKIE` | — | Optional raw `Cookie` override; skips Chrome when set. |

**Finding your store id and host:** open your Drive in a browser — the URL looks
like `https://fd9-courses.leclercdrive.fr/magasin-053701-053701-Your-Town/`. The
6-digit number is your `LECLERC_STORE_ID`; the `fdN-courses.leclercdrive.fr` part
is your `LECLERC_HOST` (the `fdN` prefix varies by region). The defaults point to
store 053701 (La Ville-aux-Dames).

### Claude Desktop / Claude Code (`mcp` config)

```json
{
  "mcpServers": {
    "leclerc-drive": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-leclerc-drive/dist/index.js"],
      "env": {
        "LECLERC_STORE_ID": "053701"
      }
    }
  }
}
```

(No cookie needed in the config — it comes from your Chrome session. Just be
logged into Leclerc Drive in Chrome.)

## Development

```bash
npm run dev        # tsc --watch
npm run typecheck  # type-check without emitting
npm run inspect    # run under the MCP Inspector
```

## Architecture

```
src/
  index.ts          # MCP server: registers the 5 tools over stdio
  config.ts         # env-based config (store, host, cookie source)
  types.ts          # Product / CartItem / Cart
  auth/
    cookies.ts      # cookie provider: auto-read from Chrome, env override
  leclerc/
    client.ts       # Leclerc Drive backend client (search + cart, validated)
docs/
  api-capture.md    # the reverse-engineered Leclerc Drive API
```

## Feedback & contact

Feedback, bug reports, and ideas are very welcome — this is an early v0.1.

- **Issues / PRs:** [open an issue](https://github.com/skunkobi/mcp-leclerc-drive/issues) on the repo.
- **Email:** alexandreyagoubi@gmail.com

## Disclaimer

Unofficial. Not affiliated with or endorsed by E.Leclerc. Use with your own account, at your own risk, in line with the site's terms of service. Intended for personal automation of your own grocery shopping.

## License

MIT
