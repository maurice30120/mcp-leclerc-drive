# Inject the tool bridge into the page's MAIN world, not an isolated world

`background.ts` uses `chrome.scripting.executeScript({ world: "MAIN" })` to put
`inject.js` (and the relay `embed.js`) into the Leclerc tab's **MAIN** world, so
the registered tools call the page's own `fetch` with its live cookies and
DataDome fingerprint. An isolated-world injection would not share the page's
fetch context and would need to forward fetches back through the extension —
re-introducing a credentialed hop.

**Consequences.** MAIN-world scripts cannot use `chrome.*` APIs, so the relay
embed must be driven purely through the injection list ordering
(`["inject.js","embed.js"]`) rather than from `inject.ts` itself. Leclerc
currently ships no page CSP; if they add one that blocks MAIN-world scripts,
the documented (unimplemented) fallback is a CSP-exempt `chrome.scripting`
user-script runner — the isolated `api.ts` makes that swap ~1 file.