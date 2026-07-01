# Publish no npm binary — bridge to stdio clients via the local relay

v0.x published a `bin.mcp-leclerc-drive` stdio server (you `npx`'d it). v1.0
publishes nothing runnable: the package holds the built extension + types; the
MCP client `npx`es `@mcp-b/webmcp-local-relay` (a *dev* dependency here), and
the user loads `dist/extension/` into Chrome. `server.json` retains
`transport: stdio` but carries a `transportHint` explaining this.

Why: the tools live in the browser tab, so there is nothing for a stdio binary
to *do* except be the relay — and the relay is already published as its own
package. Publishing our own no-op binary would only mislead registry consumers.

**Consequence.** Install instructions must cover two artifacts (extension +
client config) instead of one `npx` line; the README and `server.json` carry
that load.