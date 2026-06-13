# Leclerc Drive — Reverse-engineered API (validated 2026-06-13)

Captured live against store **053701** (La Ville-aux-Dames) on host
`fd9-courses.leclercdrive.fr`. All endpoints below were observed AND replayed
successfully from the page context with `credentials: 'include'` (cookies,
incl. DataDome, replayed).

> Path note: the store path is `magasin-{id}-{id}` for the API (e.g.
> `magasin-053701-053701`). The trailing `-La-Ville-aux-Dames` slug appears in
> the HTML page URLs but is **cosmetic** — the backend keys off the id.

## 0. Auth / anti-bot

- Session is cookie-based. Replay the full `Cookie` header from a logged-in
  browser.
- ⚠️ **DataDome** bot protection is active (`api-js.datadome.co/js/`). A
  `datadome` cookie is part of the session and **must** be replayed, or requests
  will be challenged. Confirmed: a cold Node `fetch` (no cookies) gets **HTTP
  403** with a DataDome challenge; replaying the browser cookies (incl.
  `datadome`) returns the real **HTTP 200** page. This is the main fragility of
  the cookie-replay approach.
- The MCP reads these cookies straight from the local Chrome profile
  (`chrome-cookies-secure`), so no manual copy-paste is needed — see
  `src/auth/cookies.ts`.
- Mutating requests send header `X-Requested-With: XMLHttpRequest` and
  `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.

## 1. search_product — `GET .../recherche.aspx?TexteRecherche={query}`

- Server-rendered HTML (ASP.NET). **No separate search XHR.**
- Needs the session cookie (DataDome blocks anonymous fetches), but no account
  is required beyond a valid browser session.
- In the **raw HTML**, products are passed to widget init calls as
  `Utilitaires.widget.initOptions('..._pnlElementProduit', {"objContenu":{"lstElements":[{"objElement":{ ...iIdProduit... }}]}})`.
  (The `_objDataSourceGroupeTrieFiltre` name only exists as a client-side global
  built from this — don't key off it server-side.) The client extracts products
  by scanning the HTML for the smallest JSON object enclosing each `iIdProduit`
  (= `objElement`, pure JSON). Validated live: `search("café")` → 200 products.
  Each product object exposes:

  | Field | Meaning |
  | --- | --- |
  | `iIdProduit` | **product id** (used for all cart ops), e.g. `2612` |
  | `sLibelleLigne1`, `sLibelleLigne2` | label (2 lines) |
  | `nrPVUnitaireTTC` / `sPrixUnitaire` | unit price (numeric / formatted) |
  | `sPrixPromo` | promo price when applicable |
  | `nrPVParUniteDeMesureTTC` / `sPrixParUniteDeMesure` | price per L/kg |
  | `iQteDisponible` | stock available (0 → unavailable) |
  | `iQuantitePanier` | quantity currently in cart |
  | `sUrlVignetteProduit` | thumbnail URL |
  | `iIdRayon`, `iIdFamille`, `niIdSousFamille` | category ids |

- Product images also load from
  `fd9-photos.leclercdrive.fr/image.ashx?id={photoId}&use=l&cat=p` and
  Nutri-Score from `...&use=nsc` (note: photo id ≠ `iIdProduit`).

## 2. add / update / remove — `POST .../panier.aspx?op=1`

Single endpoint for all cart mutations. `op=1` constant.

- **Body**: `d=<URL-encoded JSON>` (one form field named `d`).
- **JSON payload**:

  ```json
  {
    "eTypeAction": 1,
    "iIdProduit": "2612",
    "iQuantite": 2,
    "sNoPointLivraison": "053701",
    "objContexteProvenanceArticle": {
      "eOrigine": 4, "eTypePage": 3,
      "sTexteRecherche": "lait", "eVue": 0,
      "sInformationsComplementaires": "uni-2"
    }
  }
  ```

  - `eTypeAction`: **1** = add / increase, **2** = decrease / remove.
  - `iQuantite`: the **new absolute target quantity** (NOT a delta).
  - **Remove** = `eTypeAction: 2`, `iQuantite: 0`. ✅ validated (cart went to 0).
  - `objContexteProvenanceArticle` is analytics context and is **optional** —
    removals succeeded without it.

- **Response**: JSON array of events. Relevant ones, keyed by `sIdUnique`:
  - `Produit{id}` (`eTypeEvenement` 101/103/104): per-line state —
    `iQuantitePanier`, `rTotalAPayer`/`sTotalAPayer` (line total).
  - `Rayon{id}` (503): aisle rollup.
  - **`Panier{store}` (`eTypeEvenement` 1): cart grand total** —
    `iQuantitePanier` (total items), `rTotalAPayer`/`sTotalAPayer`,
    `sTotalHorsReductions`, `sMontantEconomies`, `fQuantiteDisponibleDepassee`.

  → Read the `Panier{store}` event for the authoritative cart total after any op.

## 3. get_cart

- `GET .../panier.aspx` (no `op`) → **404**. There is no plain cart page at that
  path.
- Instead, **every store page embeds the cart** in the "Panier" context:
  - `"lstProduits":[ {full product records} ]` — full `objElement`s with labels,
    `iQuantitePanier`, and per-line `rTotalAPayer`/`sTotalAPayer`.
  - `"lstProduitsLight":[ {"iIdProduit","iQtePanier","rTotalAPayer",...} ]` —
    a lightweight summary (no labels), immediately followed by the cart totals
    `"iQuantitePanier"`, `"sTotalHorsReductions"`, **`"sTotalAPayer"`** (grand total).
- Implementation (validated live): fetch `recherche.aspx?TexteRecherche=<no-match
  token>` so the page carries only cart records, extract the `lstProduits` array
  (exact key, so it doesn't match `lstProduitsLight`), map each record, and read
  the grand total from the `sTotalAPayer` next to `lstProduitsLight`.
- Note: cart line records use `iQuantitePanier` (full list) / `iQtePanier`
  (light list) — the client accepts either.

## Open items / to refine

- Confirm `objContexteProvenanceArticle` can be fully omitted on **add** (only
  verified omittable on remove).
- Find a clean read-only cart endpoint if one exists (avoid HTML scrape).
- DataDome cookie lifetime / refresh behaviour for long-lived sessions.
- Checkout / slot-booking flow (out of scope for v0.1).
