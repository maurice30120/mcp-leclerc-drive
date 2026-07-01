# Keep Leclerc business logic pure and fetch-free in `src/leclerc/api.ts`

All URL building, HTML/JSON parsing, cart assembly, store-finder helpers and
formatting live in `src/leclerc/api.ts` as **pure functions** — no `fetch`, no
Node APIs, no `localStorage`. The only place `fetch` is called is
`extension/inject.ts`, using the page's own fetch.

Why: the same logic must bundle into an MV3 content script *and* stay
unit-testable in isolation. Mixing fetch into the logic forces either a
browser-only test or a mocked-fetch harness; keeping it pure means the parsing
and assembly can be tested with plain string fixtures, and the fetch path is a
single seam. This is the rule CONTRIBUTING.md enforces for any new tool.