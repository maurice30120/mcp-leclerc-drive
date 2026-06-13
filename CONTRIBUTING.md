# Contributing to mcp-leclerc-drive

Thanks for wanting to improve this! It's an early, community-driven tool — bug
reports, fixes, new tools, and support for other stores are all welcome.

## Ground rules

- Be respectful and constructive.
- This is an **unofficial** tool. Only ever test against **your own** Leclerc
  Drive account, at a personal request volume. Don't build anything that targets
  other people's accounts or hammers the site — that's both against the spirit
  of the project and a fast way to get blocked by DataDome.
- Keep changes focused; one logical change per pull request.

## Project layout

```
src/
  index.ts          # MCP server: declares the 5 tools (the public contract)
  config.ts         # env-based config (store, host, cookie source)
  types.ts          # Product / CartItem / Cart
  auth/cookies.ts   # cookie provider: auto-read from Chrome, env override
  leclerc/client.ts # Leclerc Drive backend client (search + cart)
docs/
  api-capture.md    # the reverse-engineered Leclerc Drive API — read this first
```

Two layers matter:

1. **Tool contracts** (`src/index.ts`) — what the model sees. Stable; change with care.
2. **Backend client** (`src/leclerc/client.ts`) — how we talk to Leclerc Drive.
   Most contributions live here.

## Dev setup

Prerequisites: **Node 18+**, and **Chrome logged into Leclerc Drive** (the tool
borrows that session for auth).

```bash
git clone https://github.com/skunkobi/mcp-leclerc-drive.git
cd mcp-leclerc-drive
npm install
npm run build        # or: npm run dev   (tsc --watch)
npm run typecheck    # must pass before you open a PR
```

## Testing your changes

There's no mocked test suite yet (contributions welcome!). For now, verify
against the live site with **your own** account and store:

```bash
# configure your store if it isn't the default 053701
export LECLERC_STORE_ID=053701
export LECLERC_HOST=fd9-courses.leclercdrive.fr

npm run build
npm run smoke        # runs scripts/smoke-test.mjs
```

`npm run smoke` exercises all five tools end-to-end: it searches, **adds one
item to your real cart, reads it, updates it, then removes it** (it cleans up
after itself). Read `scripts/smoke-test.mjs` before running so you know what it
does.

You can also drive the server interactively with the MCP Inspector:

```bash
npm run inspect
```

## Reverse-engineering a new endpoint

This is the heart of the project. To add a capability (e.g. checkout, delivery
slots, "mes listes"), capture how the website does it, then replay it:

1. Open Leclerc Drive in Chrome with **DevTools → Network** open.
2. Perform the action on the site (book a slot, etc.).
3. Inspect the request: URL, method, headers, and the **request payload**. On
   this site, cart actions POST to `panier.aspx?op=1` with a single form field
   `d=<URL-encoded JSON>`; other widgets embed data in the server-rendered HTML.
4. Note the **response** shape (it's usually a JSON event array).
5. Document your findings in [`docs/api-capture.md`](docs/api-capture.md).
6. Wire it into `src/leclerc/client.ts`, and expose a tool in `src/index.ts` if
   it's user-facing.

Tip: cookies (incl. `datadome`) must be replayed or you'll get HTTP 403. The
`CookieProvider` already handles this — reuse `authHeaders()`.

## Coding conventions

- TypeScript, ESM, `strict` mode. Match the style of the surrounding code.
- Comments in English so the project stays broadly contributable.
- Run `npm run typecheck` and `npm run build` before pushing.

## Opening a pull request

1. Fork, branch (`git checkout -b my-change`).
2. Make the change; keep it focused.
3. Ensure typecheck/build pass and you've smoke-tested if you touched the client.
4. Open the PR describing **what** changed and **how you verified** it.

Ideas to pick up are tracked in the README's status checklist and the issues
list. Good first contributions: clearer error messages on a DataDome challenge,
auto-detecting the `fdN` host from the store id, or an automated test harness.
