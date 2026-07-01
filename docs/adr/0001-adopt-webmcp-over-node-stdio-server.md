# Adopt the WebMCP (browser-tab) model over a Node stdio MCP server

**Status:** accepted (supersedes the v0.x Node stdio design).

The Node stdio server (v0.x) read Chrome cookies from the local profile via
`chrome-cookies-secure` and replayed them with Node `fetch`. We move to the
WebMCP model (MCP-B): a tiny MV3 extension registers the Leclerc tools inside
the logged-in Chrome tab and `@mcp-b/webmcp-local-relay` bridges them to any
stdio MCP client. The deciding factor is that DataDome and the session live
naturally inside a real browser tab — the browser refreshes `datadome` on its
own and presents a genuine fingerprint — so the fragility, the credentialed
config surface (`LECLERC_COOKIE`, on-disk Chrome cookies), and the entire
`sqlite3` dependency tree (and its CVEs) all disappear.

**Considered options.** Keep the stdio server + cookie extraction; or a
Playwright/CDP automation server. Both keep credentials on the Node side and
stay at DataDome's mercy.

**Consequences.** No headless / VPS deploy (a real logged-in Chrome tab is
required). No published npm binary — the MCP client launches the relay, the
extension is loaded manually. Heavy lock-in to `@mcp-b/*`; the `registerTool` /
`embed.js` surface may evolve (changes confined to `extension/inject.ts` and
the build script). See `docs/comparison-origin.md` §1–2.