# Persist the active store in page `localStorage`, not a Node config file

v0.x wrote the selected store to `~/.mcp-leclerc-drive/config.json` on disk.
v1.0 stores it at `localStorage["mcp-leclerc-drive:active-store"]`, scoped to
the Leclerc host, and prefers the tab's own URL's `magasin-{id}-{id}` segment
when present.

Why: there is no Node process to own the config anymore — the tools live in the
tab — so the store selection belongs with the tab. Keeping it in `localStorage`
makes it survive reloads of the same drive tab; preferring the URL keeps the
tools honest about which drive the session is actually on (Leclerc binds a
session to one drive).

**Consequence.** First-run requires the tab to be open on a store page or a
prior `set_store`; there is no env-var default anymore (see
`comparison-origin.md` §7).