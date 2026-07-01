# Tools reference

The 9 MCP tools registered on `document.modelContext` by `extension/inject.ts`.
All run **inside the logged-in Leclerc Drive tab**, using the page's own `fetch`.

Tool names are stable. Inputs are JSON-Schema. Annotations follow the
`@modelcontextprotocol` hints.

## Store selection

### `find_stores(query)`
Find drives near a postal code or city.
- Chained calls to the store-finder REST API: `/autocomplete` →
  `/autocomplete/coordinates` → `/MapPoint/nearby`.
- Returns one line per drive: `name — serviceType (id=… @ host)`.
- Caches results on `window.__leclercFoundStores` for `set_store`.
- Annotations: `readOnlyHint`, `untrustedContentHint` (store names come from
  Leclerc), `openWorldHint`.

### `set_store(store_id, host?)`
Select & persist the active drive.
- Resolves the host from the `find_stores` cache, or accepts an explicit `host`.
- Validates `isLeclercHost` → refuses non-Leclerc hosts (SSRF gate).
- Persists in `localStorage` under `mcp-leclerc-drive:active-store`, scoped to
  the Leclerc host.
- Annotations: `openWorldHint` (mutates selection; not destructive to cart).

> ⚠️ Session is bound to one drive. The store you set must be the one the
> browser tab is logged into, or cart/search calls return "session expirée".

### `get_store()`
Show the currently selected store (`id @ host`).
- Resolution: tab's own URL → persisted `localStorage` → error.
- Annotations: `readOnlyHint`.

## Catalogue

### `search_product(query)`
Search the catalogue of the active store.
- `GET recherche.aspx?TexteRecherche=…` → parse `iIdProduit` records via
  `productsFromHtml`.
- Returns `label (brand) — price € [pricePerUnit] Nutri-Score … id=…`.
- Annotations: `readOnlyHint`, `untrustedContentHint`, `openWorldHint`.

### `list_habitual_products()`
List your « produits habitués » (the drive's `produits-habituels.aspx` page).
- Derives the store path prefix from the **current tab URL**
  (`/magasin-<id>-<id>-<slug>/`), so the tab must be on a store page.
- Annotations: `readOnlyHint`, `untrustedContentHint`, `openWorldHint`.

## Cart

### `add_to_cart(product_id, quantity?)`
Add a product (uses `search_product`'s `id`). Default `quantity=1`, integer ≥ 1.
- `POST panier.aspx?op=1` with `cartMutationBody(…, ACTION_ADD=1, target qty)`.
- Parses the event array with `cartFromEvents` → returns the full cart.
- Annotations: `destructiveHint: false`, `idempotentHint: true`, `openWorldHint`.

### `remove_from_cart(product_id)`
Remove a line entirely.
- `eTypeAction=2`, `iQuantite=0` (validated against the live cart).
- Annotations: `destructiveHint: true`, `openWorldHint`.

### `update_quantity(product_id, quantity)`
Set a line's absolute quantity (0 = remove).
- Reads the current quantity (`currentQuantity` → `get_cart` HTML) to pick
  `ACTION_ADD` vs `ACTION_SUB` (Leclerc's `iQuantite` is the absolute target).
- Annotations: `destructiveHint: true`, `openWorldHint`.

### `get_cart()`
Read the full cart with total.
- `GET recherche.aspx?TexteRecherche=<no-match>` so the page carries only cart
  records, then `cartFromHtml`.
- Annotations: `readOnlyHint`, `openWorldHint`.

## Cross-cutting behavior

- **Anti-DataDome throttle** (`inject.ts`): serialize + `MIN_INTERVAL_MS=600`
  + `JITTER_MS=250` jitter + `MAX_RETRIES=3` with exponential backoff on
  `403`/`429`. Every fetch is the page's own fetch, so the fingerprint is real
  and strikes are rare.
- **Block guard**: `assertStorePage` throws an actionable "recharge l'onglet"
  message on a DataDome / expired-session page instead of returning empty.
- **Prompt-injection scrubbing**: `search_product`, `find_stores`,
  `list_habitual_products` output is passed through `scrubUntrusted` (decode
  entities + strip `<system>` / `<|im_start|>` / `[tool]`-style markers).
- **Errors**: returned as `CallToolResult` with `isError: true` and a French
  actionable message.