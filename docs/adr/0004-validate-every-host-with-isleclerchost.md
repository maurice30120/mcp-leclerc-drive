# Validate every host with `isLeclercHost` before any fetch (SSRF gate)

Every `host` that reaches a tool's `fetch` must match
`/^fd\d+-courses\.leclercdrive\.fr$/`. `set_store` refuses a non-matching host
and `saveStore` refuses to persist one; by default the host is derived from the
tab's own `location.host`, already a Leclerc origin by construction.

Why: `set_store` accepts a `host` parameter (so users can target their drive
without `find_stores`), which would otherwise make the catalogue/cart surface a
server-side request forwarder to an arbitrary origin. A single regex gate makes
the attack surface closed rather than advisory. See `security.md` §SSRF.