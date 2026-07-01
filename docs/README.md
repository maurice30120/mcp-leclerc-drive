# Documentation index

Entry point for everything you need to understand `mcp-leclerc-drive`. Read in
this order on a first pass.

| Document | What it covers |
| --- | --- |
| [../README.md](../README.md) | Project pitch, install, the 9 tools at a glance — start here. |
| [architecture.md](architecture.md) | The WebMCP runtime shape: extension, relay, MVP-B, data flow, layers. |
| [tools.md](tools.md) | Reference for the 9 MCP tools: contracts, inputs, behavior, annotations. |
| [security.md](security.md) | Threat model: trust boundaries, SSRF closure, prompt-injection hardening, permissions. |
| [api-capture.md](api-capture.md) | The reverse-engineered Leclerc Drive HTTP API (read this before touching `src/leclerc/api.ts`). |
| [comparison-origin.md](comparison-origin.md) | Local working tree vs. `origin/main` (v0.2.0 Node stdio): what changed, what remains, critical diffs. |
| [adr/](adr/) | Architecture Decision Records — the *why* behind the hard-to-reverse choices. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Dev setup, extension build/reload flow, reverse-engineering a new endpoint, PR checklist. |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed in each release (current: 1.0.0 WebMCP refactor). |

## Quick mental model

```
opencode / Claude Code            stdio client
   │  JSON-RPC over stdio
   ▼
@mcp-b/webmcp-local-relay         local Node, 127.0.0.1:9333, --widget-origin pinned
   │  WebSocket (loopback)
   ▼
Chrome MV3 extension              background.ts injects [inject.js, embed.js] into the tab (MAIN world)
   │  chrome.scripting.executeScript
   ▼
Leclerc Drive tab (logged in)     inject.ts registers 9 tools on document.modelContext;
                                   fetch = the page's own fetch (cookies + datadome authentic)
```

Key invariant: **no credential ever leaves the logged-in tab.** Business logic
is pure in [`src/leclerc/api.ts`](../src/leclerc/api.ts) so it bundles into the
content script and stays unit-testable; the only place that calls `fetch` is
[`extension/inject.ts`](../extension/inject.ts), using the page's fetch.