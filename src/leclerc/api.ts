/**
 * Pure logic for the Leclerc Drive backend, shared between:
 *  - the (legacy) Node stdio client (src/leclerc/client.ts),
 *  - the browser content-script injector (extension/inject.ts).
 *
 * No `fetch`, no Node APIs, no storage — only URL building, HTML/JSON parsing,
 * and type mapping. Safe to bundle into an MV3 content script.
 *
 * Endpoints reverse-engineered and validated live against store 053701 on
 * 2026-06-13 — see docs/api-capture.md for the full capture.
 */

import { Cart, CartItem, Product } from "../types.js";

/** Cart mutation discriminator (see capture doc §2). */
export const ACTION_ADD = 1; // add / increase to target qty
export const ACTION_SUB = 2; // decrease / remove (qty 0)

/** HTTP statuses that indicate a DataDome challenge / rate-limit worth retrying. */
export const RETRYABLE_STATUSES = new Set([403, 429]);

/**
 * Marker embedded in the chrome of every real Leclerc store page (the cart
 * summary). The two non-store responses we can get back with HTTP 200 — DataDome's
 * soft JS-challenge interstitial and the "session expirée" page — don't contain
 * it. Used as a DataDome/session-expiry guard on HTML fetched by the caller.
 */
export const STORE_PAGE_MARKER = "lstProduitsLight";

/** Query token that returns no search results, so a fetched page carries only cart data. */
export const NO_MATCH_QUERY = "zzzznomatchzzz";

/** Leclerc store-finder REST API base (DataDome-protected but CORS-open). */
export const STORE_FINDER_API_BASE =
  "https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1";

/** User-Agent used by the legacy Node client. The browser fetcher ignores it. */
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RawProduct {
  iIdProduit: number | string;
  sLibelleLigne1?: string;
  sLibelleLigne2?: string;
  nrPVUnitaireTTC?: number;
  sPrixUnitaire?: string;
  sPrixPromo?: string;
  nrPVParUniteDeMesureTTC?: number;
  sPrixParUniteDeMesure?: string;
  iQteDisponible?: number;
  iQuantitePanier?: number;
  iQtePanier?: number;
  rTotalAPayer?: number;
  sTotalAPayer?: string;
  sUrlVignetteProduit?: string;
  sType?: string;
}

export interface CartEvent {
  eTypeEvenement?: number;
  sIdUnique?: string;
  objElement?: Record<string, unknown> & Partial<RawProduct>;
}

export interface AutocompletePlace {
  id: string;
  postalCode?: string;
  city?: string;
}

export interface NearbyPoint {
  noPL?: string | number;
  noPR?: string | number;
  name?: string;
  postalCode?: string;
  serviceType?: string;
  type?: string;
  distance?: number;
  urlSiteCourse?: string;
  urlBase?: string;
}

// ---- URLs -----------------------------------------------------------------

/** Store path segment used by the backend (no cosmetic slug). */
export function storePath(storeId: string, noPR: string = storeId): string {
  // Leclerc store URLs embed the delivery point + retrieval point plus a slug,
  // e.g. /magasin-053701-053701-La-Ville-aux-Dames/. The slug is cosmetic; the
  // backend keys off the ids. For drives the two ids are equal; for piéton
  // relays they differ (noPL-noPR).
  return `magasin-${storeId}-${noPR}`;
}

export function searchUrl(host: string, storeId: string, noPR: string, query: string): string {
  return `https://${host}/${storePath(storeId, noPR)}/recherche.aspx?TexteRecherche=${encodeURIComponent(
    query,
  )}`;
}

export function cartUrl(host: string, storeId: string, noPR: string): string {
  return `https://${host}/${storePath(storeId, noPR)}/panier.aspx?op=1`;
}

/** True when `name` is one of the DataDome retryable statuses. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

// ---- HTML / JSON parsing --------------------------------------------------

/**
 * Guard against silently treating a block page as "no results". A real store
 * page always carries STORE_PAGE_MARKER; if it's missing, the response is a
 * DataDome interstitial or an expired session — surface that with an
 * actionable message instead of returning an empty list.
 *
 * Throws on block/expiry; returns silently on a real store page.
 */
export function assertStorePage(html: string): void {
  if (html.includes(STORE_PAGE_MARKER)) return;
  const expired = /session a expir|sessionexpiree/i.test(html);
  throw new Error(
    expired
      ? "Session Leclerc Drive expirée. Ouvre Leclerc Drive dans Chrome et reconnecte-toi, puis réessaye."
      : "Bloqué par Leclerc Drive (challenge DataDome). Ouvre Leclerc Drive dans Chrome et " +
          "recharge le magasin une fois pour rafraîchir la session, puis réessaye.",
  );
}

export function mapProduct(rp: RawProduct): Product {
  const label = decodeEntities(
    [rp.sLibelleLigne1, rp.sLibelleLigne2].filter(Boolean).join(" ").trim(),
  );
  const price = num(rp.nrPVUnitaireTTC) ?? parseEuro(rp.sPrixUnitaire) ?? 0;
  return {
    id: String(rp.iIdProduit),
    label: label || `Produit ${rp.iIdProduit}`,
    price,
    pricePerUnit: rp.sPrixParUniteDeMesure || undefined,
    available: (num(rp.iQteDisponible) ?? 0) > 0,
    imageUrl: rp.sUrlVignetteProduit || undefined,
  };
}

/**
 * Extract the balanced array literal that follows a `"name":[` key in an
 * HTML/JS blob (exact key match, so `lstProduits` does not match
 * `lstProduitsLight`). Returns the `[...]` substring, or null.
 */
export function extractArrayNamed(html: string, name: string): string | null {
  const marker = `"${name}":[`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length - 1; // position of '['
  let depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
}

/** Read the cart grand total string (e.g. "18,18 €") from the Panier context. */
export function extractCartTotal(html: string): string | undefined {
  const anchor = html.indexOf("lstProduitsLight");
  const scope = anchor >= 0 ? html.slice(anchor, anchor + 1500) : html;
  const m = scope.match(/"sTotalAPayer":"([^"]+)"/);
  return m?.[1];
}

/**
 * Tolerant extraction of product records from a JS literal that may contain
 * non-JSON members (functions). Finds each `"iIdProduit"` occurrence and parses
 * the smallest enclosing `{...}` object, skipping any that fail to parse.
 */
export function scanProductRecords(raw: string): RawProduct[] {
  const out: RawProduct[] = [];
  const re = /"iIdProduit"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const obj = smallestEnclosingObject(raw, m.index);
    if (obj) {
      try {
        out.push(JSON.parse(obj) as RawProduct);
      } catch {
        /* skip records with function members etc. */
      }
    }
  }
  return out;
}

export function smallestEnclosingObject(raw: string, at: number): string | null {
  // walk backwards to the opening brace of this object
  let start = -1;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = raw[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  // forward to the matching close, respecting strings
  depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, j + 1);
    }
  }
  return null;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/** Parse a French-formatted euro string like "11,88 €" → 11.88. */
export function parseEuro(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const cleaned = v.replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isNaN(n) ? undefined : n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Decode the HTML entities that appear in product labels (numeric + a few named). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ---- Cart assembly --------------------------------------------------------

/** Parse the HTML of a no-match search page into the current cart. */
export function cartFromHtml(
  html: string,
  storeId: string,
): Cart {
  const arr = extractArrayNamed(html, "lstProduits");
  const items: CartItem[] = [];
  if (arr) {
    const seen = new Set<string>();
    for (const rp of scanProductRecords(arr)) {
      const qty = num(rp.iQuantitePanier) ?? num(rp.iQtePanier) ?? 0;
      if (qty <= 0) continue;
      const id = String(rp.iIdProduit);
      if (seen.has(id)) continue;
      seen.add(id);
      const product = mapProduct(rp);
      const lineTotal =
        num(rp.rTotalAPayer) ?? parseEuro(rp.sTotalAPayer) ?? round2(product.price * qty);
      items.push({ product, quantity: qty, lineTotal });
    }
  }
  const grandTotal =
    parseEuro(extractCartTotal(html)) ?? round2(items.reduce((s, i) => s + i.lineTotal, 0));
  return {
    items,
    itemCount: items.reduce((s, i) => s + i.quantity, 0),
    total: round2(grandTotal),
    storeId,
  };
}

/** Build a Cart from a mutation event array (see capture doc §2). */
export function cartFromEvents(events: CartEvent[], storeId: string): Cart {
  const items: CartItem[] = [];
  let total = 0;
  let itemCount = 0;
  for (const e of events) {
    const id = String(e.sIdUnique ?? "");
    const el = e.objElement ?? {};
    if (id.startsWith("Panier")) {
      total = num(el.rTotalAPayer) ?? parseEuro(el.sTotalAPayer) ?? total;
      itemCount = num(el.iQuantitePanier) ?? itemCount;
    } else if (id.startsWith("Produit") && el.sType === "Produit") {
      const qty = num(el.iQuantitePanier) ?? 0;
      if (qty > 0) {
        const product = mapProduct(el as RawProduct);
        const lineTotal =
          num(el.rTotalAPayer) ?? parseEuro(el.sTotalAPayer) ?? round2(product.price * qty);
        items.push({ product, quantity: qty, lineTotal });
      }
    }
  }
  return { items, itemCount, total: round2(total), storeId };
}

/** Search the product records embedded in a search page, deduped by id. */
export function productsFromHtml(html: string): Product[] {
  const seen = new Set<string>();
  const products: Product[] = [];
  for (const rp of scanProductRecords(html)) {
    if (rp.sType && rp.sType !== "Produit") continue;
    const id = String(rp.iIdProduit);
    if (seen.has(id)) continue;
    seen.add(id);
    products.push(mapProduct(rp));
  }
  return products;
}

// ---- Cart mutation payload ------------------------------------------------

/** Build the URL-encoded body for a cart mutation (see capture doc §2). */
export function cartMutationBody(
  productId: string,
  quantity: number,
  action: number,
  storeId: string,
): string {
  const payload = {
    eTypeAction: action,
    iIdProduit: String(productId),
    iQuantite: quantity,
    sNoPointLivraison: storeId,
  };
  return "d=" + encodeURIComponent(JSON.stringify(payload));
}

// ---- Store finder URLs ----------------------------------------------------

export function autocompleteUrl(query: string): string {
  return `${STORE_FINDER_API_BASE}/autocomplete?search=${encodeURIComponent(
    query,
  )}&provider=Woosmap`;
}

export function coordinatesUrl(placeId: string): string {
  return `${STORE_FINDER_API_BASE}/autocomplete/coordinates?id=${encodeURIComponent(
    placeId,
  )}&provider=Woosmap`;
}

export function nearbyUrl(lat: number, lng: number, postalCode: string): string {
  return `${STORE_FINDER_API_BASE}/MapPoint/nearby?latitude=${lat}&longitude=${lng}&postalCode=${encodeURIComponent(
    postalCode,
  )}`;
}

/** Extract the host (e.g. "fd9-courses.leclercdrive.fr") from a Leclerc URL. */
export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** True iff host is a Leclerc Drive backend (the fdN-courses.leclercdrive.fr shape). */
export function isLeclercHost(host: string): boolean {
  return /^fd\d+-courses\.leclercdrive\.fr$/i.test(host);
}

export interface NearbyResponse {
  points?: NearbyPoint[];
}
export interface AutocompleteResponse {
  postalCodes?: AutocompletePlace[];
}
export interface CoordinatesResponse {
  latitude?: number;
  longitude?: number;
  coordinates?: { latitude?: number; longitude?: number };
}

// ---- Formatting helpers (for tool return text) ----------------------------

export function formatProduct(p: Product): string {
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    `— ${p.price.toFixed(2)} €`,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    p.nutriScore ? `Nutri-Score ${p.nutriScore}` : null,
    p.available ? null : "⚠️ indisponible",
    `id=${p.id}`,
  ].filter(Boolean);
  return bits.join(" ");
}

export function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return "Panier vide.";
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${it.lineTotal.toFixed(2)} € ` +
      `(id=${it.product.id})`,
  );
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join("\n") +
    `\n\nTotal : ${cart.total.toFixed(2)} €`
  );
}