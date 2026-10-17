/**
 * Logique pure du connecteur Leclerc Drive mobile.
 *
 * Recopie minimale et isolée du reverse engineering de mcp-leclerc-drive
 * (src/leclerc/api.ts), validé le 2026-06-13 contre le magasin 053701 — voir
 * docs/api-capture.md du projet de référence. Aucun `fetch`, aucune API Node,
 * aucun stockage : seulement construction d'URL, parsing HTML/JSON et mapping
 * de types. Sûr à bundler côté React Native (pas d'accès chrome.*).
 *
 * Différences volontaires avec la version web :
 *  - le client fetch concret vit dans connector.ts (le fetch viendra de
 *    RNFetchBlob/RN en mobile), ici on reste pure.
 */

import type { Cart, CartItem, Product } from '../../shared/types.ts';

/** Discriminateur de mutation panier (capture doc §2). */
export const ACTION_ADD = 1; // ajouter / augmenter vers qté cible
export const ACTION_SUB = 2; // diminuer / retirer (qté 0)

/** Statuts HTTP indiquant un challenge DataDome / rate-limit à retenter. */
export const RETRYABLE_STATUSES = new Set([403, 429]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Marqueur embarqué dans le chrome de toute vraie page magasin Leclerc
 * (le résumé panier). Les deux réponses non-magasin à HTTP 200 — interstitiel
 * JS-challenge DataDome et page "session expirée" — ne le contiennent pas.
 */
export const STORE_PAGE_MARKER = 'lstProduitsLight';

/** Token de recherche sans résultat, pour qu'une page ne porte que le panier. */
export const NO_MATCH_QUERY = 'zzzznomatchzzz';

/** Base de l'API REST de recherche de magasins (DataDome-protégée, CORS-ouverte). */
export const STORE_FINDER_API_BASE =
  'https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1';

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
  rMarque?: string;
  sMarque?: string;
}

export interface CartEvent {
  eTypeEvenement?: number;
  sIdUnique?: string;
  objElement?: Record<string, unknown> & Partial<RawProduct>;
}

// ---- URLs -----------------------------------------------------------------

export function storePath(storeId: string, noPR: string = storeId): string {
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

export function listHabitualUrl(host: string, storeId: string, noPR: string): string {
  return `https://${host}/${storePath(storeId, noPR)}/produits-habituels.aspx`;
}

/** Endpoint de mutation panier : panier.aspx?op=1 en POST. */
export function cartMutationUrl(host: string, storeId: string, noPR: string): string {
  return cartUrl(host, storeId, noPR);
}

// ---- Garde page magasin --------------------------------------------------

export function assertStorePage(html: string): void {
  if (html.includes(STORE_PAGE_MARKER)) return;
  const expired = /session a expir|sessionexpiree/i.test(html);
  throw new Error(
    expired
      ? 'Session Leclerc Drive expirée. Rouvre Leclerc Drive dans la WebView et reconnecte-toi, puis réessaye.'
      : 'Bloqué par Leclerc Drive (challenge DataDome). Rouvre Leclerc Drive dans la WebView et recharge le magasin une fois pour rafraîchir la session, puis réessaye.',
  );
}

// ---- Mapping produit -----------------------------------------------------

export function mapProduct(rp: RawProduct): Product {
  const label = decodeEntities(
    [rp.sLibelleLigne1, rp.sLibelleLigne2].filter(Boolean).join(' ').trim(),
  );
  const price = num(rp.nrPVUnitaireTTC) ?? parseEuro(rp.sPrixUnitaire) ?? 0;
  const brand = (rp.sMarque ?? num(rp.rMarque)?.toString()) || undefined;
  return {
    id: String(rp.iIdProduit),
    label: label || `Produit ${rp.iIdProduit}`,
    price,
    pricePerUnit: rp.sPrixParUniteDeMesure || undefined,
    available: (num(rp.iQteDisponible) ?? 0) > 0,
    imageUrl: rp.sUrlVignetteProduit || undefined,
    ...(brand ? { brand } : {}),
  };
}

// ---- Extraction depuis HTML/JS -------------------------------------------

export function extractArrayNamed(html: string, name: string): string | null {
  const marker = `"${name}":[`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length - 1;
  let depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  return null;
}

export function extractCartTotal(html: string): string | undefined {
  const anchor = html.indexOf('lstProduitsLight');
  const scope = anchor >= 0 ? html.slice(anchor, anchor + 1500) : html;
  const m = scope.match(/"sTotalAPayer":"([^"]+)"/);
  return m?.[1];
}

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
        /* enregistrements avec membres fonction ignorés */
      }
    }
  }
  return out;
}

export function smallestEnclosingObject(raw: string, at: number): string | null {
  let start = -1;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = raw[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  let inStr: string | null = null;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, j + 1);
    }
  }
  return null;
}

// ---- Helpers scalaires ----------------------------------------------------

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))
    return Number(v);
  return undefined;
}

export function parseEuro(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const cleaned = v.replace(/[^\d,.-]/g, '').replace(',', '.');
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.')
    return undefined;
  const n = Number(cleaned);
  return Number.isNaN(n) ? undefined : n;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ---- Assemblage panier ----------------------------------------------------

export function cartFromHtml(html: string, storeId: string): Cart {
  const arr = extractArrayNamed(html, 'lstProduits');
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

export function cartFromEvents(events: CartEvent[], storeId: string): Cart {
  const items: CartItem[] = [];
  let total = 0;
  let itemCount = 0;
  for (const e of events) {
    const id = String(e.sIdUnique ?? '');
    const el = e.objElement ?? {};
    if (id.startsWith('Panier')) {
      total = num(el.rTotalAPayer) ?? parseEuro(el.sTotalAPayer) ?? total;
      itemCount = num(el.iQuantitePanier) ?? itemCount;
    } else if (id.startsWith('Produit') && el.sType === 'Produit') {
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

export function productsFromHtml(html: string): Product[] {
  const seen = new Set<string>();
  const products: Product[] = [];
  for (const rp of scanProductRecords(html)) {
    if (rp.sType && rp.sType !== 'Produit') continue;
    const id = String(rp.iIdProduit);
    if (seen.has(id)) continue;
    seen.add(id);
    products.push(mapProduct(rp));
  }
  return products;
}

// ---- Mutation panier -----------------------------------------------------

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
  return 'd=' + encodeURIComponent(JSON.stringify(payload));
}

// ---- Recherche de magasins ----------------------------------------------

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

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Vrai ssi host est un backend Leclerc Drive (forme fdN-courses.leclercdrive.fr). */
export function isLeclercHost(host: string): boolean {
  return /^fd\d+-courses\.leclercdrive\.fr$/i.test(host);
}

// ---- Formatage -----------------------------------------------------------

export function formatProduct(p: Product): string {
  const bits = [
    p.label,
    p.brand ? `(${p.brand})` : null,
    `— ${p.price.toFixed(2)} €`,
    p.pricePerUnit ? `[${p.pricePerUnit}]` : null,
    p.nutriScore ? `Nutri-Score ${p.nutriScore}` : null,
    p.available ? null : '⚠️ indisponible',
    `id=${p.id}`,
  ].filter(Boolean);
  return bits.join(' ');
}

export function formatCart(cart: Cart): string {
  if (cart.items.length === 0) return 'Panier vide.';
  const lines = cart.items.map(
    (it) =>
      `• ${it.quantity}× ${it.product.label} — ${it.lineTotal.toFixed(2)} € (id=${it.product.id})`,
  );
  return (
    `Panier (magasin ${cart.storeId}) — ${cart.itemCount} article(s) :\n` +
    lines.join('\n') +
    `\n\nTotal : ${cart.total.toFixed(2)} €`
  );
}
