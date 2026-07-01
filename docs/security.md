# Security model

> Threat model for the WebMCP (MCP-B) architecture, where Leclerc Drive tools
> run inside a real Chrome tab and are bridged to a stdio MCP client by
> `@mcp-b/webmcp-local-relay`.

## Trust boundaries

```
 opencode (or any stdio MCP client)
   │  stdio JSON-RPC
   ▼
 @mcp-b/webmcp-local-relay   (local Node process, 127.0.0.1:9333)
   │  --widget-origin pinned to a Leclerc origin
   │  WebSocket, loopback only
   ▼
 Chrome MV3 extension (background worker)
   │  chrome.scripting.executeScript into the Leclerc tab, MAIN world
   ▼
 Leclerc Drive tab (logged in)   ← sole credential surface
```

The **only** place credentials live is the Leclerc Drive tab the user is logged
into. The extension, the relay, and opencode never see a cookie, a token, or a
DataDome value. There is nothing to exfiltrate from a config file, a process
environment, or disk.

## What we removed (and why)

The legacy architecture read the user's Chrome session cookies (including the
DataDome cookie) out of the local Chrome profile via `chrome-cookies-secure`,
which transitively pulled `sqlite3`/`better-sqlite3` and several transitive
CVEs. That path is gone entirely:

- No `cookies` Chrome permission.
- No `chrome-cookies-secure`, no `LECLERC_COOKIE`, no on-disk config secret.
- No Node-side `fetch` carrying a stolen cookie.

Every tool `fetch` is now the **page's own fetch** in the logged-in tab —
cookies, DataDome fingerprint, and the browser's automatic DataDome refresh are
all handled by the browser itself.

## SSRF closure

`set_store` accepts a `host` parameter so users can target their own drive, but
every host is validated with `isLeclercHost`:

```ts
export function isLeclercHost(host: string): boolean {
  return /^fd\d+-courses\.leclercdrive\.fr$/i.test(host);
}
```

No tool will issue a request to a host that isn't a Leclerc Drive backend, so
the catalogue/cart surface cannot be abused as a server-side request forwarder
to an arbitrary origin. By default the host is derived from the tab's own
`window.location.hostname`, which is already a Leclerc origin by construction.

## Relay lockdown (`--widget-origin`)

The relay's `--widget-origin` flag restricts which page origins may register
tools on the relay. The example config pins it to a Leclerc origin:

```jsonc
"command": ["npx","-y","@mcp-b/webmcp-local-relay@latest",
            "--widget-origin","https://fd9-courses.leclercdrive.fr"]
```

A non-Leclerc page open in the browser therefore **cannot** push tools to the
relay. The relay is also bound to `127.0.0.1` by default, so only local
processes can connect regardless of origin checks.

> The `fdN` prefix genuinely varies per store (`fd8`, `fd9`, `fd14`…). The relay
> does not support DNS wildcards, so users override the origin with their own
> drive's URL. Listing multiple origins (comma-separated) also works. Leaving
> `--widget-origin` unset (`*`) is **not** recommended: any open page could then
> register tools.

## Prompt-injection hardening

Tool output that originates from Leclerc (product labels, store names) is
treated as untrusted:

- `search_product` and `find_stores` descriptions warn the model that
  Leclerc-side labels are not instructions.
- Text returned to the LLM is scrubbed of sequences that could break out of an
  LLM system prompt or mimic tool-result/chat boundaries (`</system>`,
  `<|im_start|>`, `[system]`, etc.) before being sent.

## Minimum permissions (MV3)

The extension requests only:

| Permission | Why |
| --- | --- |
| `scripting` | Inject the bridge into the Leclerc tab (`MAIN` world). |
| `activeTab` | Target the tab the user is on. |
| `storage` | (Reserved for future per-store prefs.) |
| host `*://*.leclercdrive.fr/*` | Only Leclerc Drive pages — no `<all_urls>`. |

No `cookies`, no `tabs`, no `webRequest`, no `<all_urls>`, no `history`.

## Residual risks

- **DataDome 403**: still possible on aggressive bursts. The in-page throttle
  serializes and spaces calls; on a persistent 403 the tool returns an
  actionable "recharge l'onglet Leclerc" message and the browser re-obtains its
  own DataDome cookie on the next navigation.
- **MV3 service-worker eviction**: the background worker may be stopped by
  Chrome. It only re-injects on navigation; once injected, the tool code runs
  in the tab, which persists.
- **Future page CSP**: Leclerc currently ships no Content-Security-Policy. Should
  they add one blocking `MAIN`-world injected scripts, the fallback is a
  user-script runner (CSP-exempt via `chrome.scripting`). Because business logic
  is isolated in `src/leclerc/api.ts`, that swap is ~1 file.
- **MCP-B maturity**: `@mcp-b/*@^1` is pinned; the `registerTool` / `embed.js`
  surface may evolve, but changes are confined to `extension/inject.ts` and the
  build script.