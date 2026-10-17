/**
 * Connecteur Leclerc mobile — adaptateur `fetch` autour de api.ts.
 *
 * Le `fetch` est injectable pour rester testable avec un mock (voir
 * tests/leclerc-connector.test.ts). En production on branche le fetch RN
 * porteur des cookies de session WebView (voir features/webview/session.ts).
 *
 * Garde-fous repris du projet de référence :
 *  - throttle anti-DataDome (sérialisation + intervalle + jitter + retries),
 *  - `assertStorePage` contre les pages bloc / session expirée,
 *  - `scrubUntrusted` sur les libellés remontés au modèle,
 *  - `isLeclercHost` sur tout hôte de mutation (porte SSRF).
 */

import {
  ACTION_ADD,
  assertStorePage,
  autocompleteUrl,
  cartFromEvents,
  cartFromHtml,
  cartMutationBody,
  cartMutationUrl,
  coordinatesUrl,
  decodeEntities,
  formatCart,
  formatProduct,
  isLeclercHost,
  isRetryableStatus,
  listHabitualUrl,
  nearbyUrl,
  NO_MATCH_QUERY,
  productsFromHtml,
  searchUrl,
  type CartEvent,
} from './api.ts';
import type { Cart, Product } from '../../shared/types.ts';

/** Shape attendue d'un fetch injectable (sous-ensemble de WHATWG fetch). */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

export interface LeclercSession {
  /** Hôte backend du drive, ex. "fd9-courses.leclercdrive.fr". */
  host: string;
  /** Identifiant du drive (noPR = noPL pour les drives). */
  storeId: string;
  /** User-Agent de la WebView connectée (emprunte l'empreinte réelle). */
  userAgent: string;
}

export interface ConnectorOptions {
  fetch: FetchLike;
  session: LeclercSession;
  /** Sérialise + espace les appels (anti-DataDome). */
  minIntervalMs?: number;
  jitterMs?: number;
  maxRetries?: number;
  /** Horloge injectable (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Logs d'action MCP (tests / historique). */
  log?: (entry: ConnectorLogEntry) => void;
}

export interface ConnectorLogEntry {
  at: number;
  command: string;
  host: string;
  storeId: string;
  ok: boolean;
  status?: number;
  attempts?: number;
  error?: string;
  productId?: string;
  quantity?: number;
}

const DEFAULT_MIN_INTERVAL = 600;
const DEFAULT_JITTER = 250;
const DEFAULT_MAX_RETRIES = 3;

export class LeclercConnector {
  private readonly fetch: FetchLike;
  private readonly session: LeclercSession;
  private readonly minIntervalMs: number;
  private readonly jitterMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log?: (e: ConnectorLogEntry) => void;

  private lastCallAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ConnectorOptions) {
    if (!isLeclercHost(opts.session.host)) {
      throw new Error(`Host non-Leclerc refusé : ${opts.session.host}`);
    }
    this.fetch = opts.fetch;
    this.session = opts.session;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL;
    this.jitterMs = opts.jitterMs ?? DEFAULT_JITTER;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.log = opts.log;
  }

  get host(): string {
    return this.session.host;
  }
  get storeId(): string {
    return this.session.storeId;
  }
  get userAgent(): string {
    return this.session.userAgent;
  }

  /** Recherche catalogue en lecture seule. */
  async searchProducts(query: string): Promise<Product[]> {
    const html = await this.getHtml(
      searchUrl(this.host, this.storeId, this.storeId, query),
      'search_products',
    );
    const products = productsFromHtml(html);
    return products.map((p) => scrubProduct(p));
  }

  /** Panier complet (page no-match pour ne porter que le cart). */
  async getCart(): Promise<Cart> {
    const html = await this.getHtml(
      searchUrl(this.host, this.storeId, this.storeId, NO_MATCH_QUERY),
      'get_cart',
    );
    return cartFromHtml(html, this.storeId);
  }

  /** Liste des produits habitués. */
  async listHabitualProducts(): Promise<Product[]> {
    const html = await this.getHtml(
      listHabitualUrl(this.host, this.storeId, this.storeId),
      'list_habitual_products',
    );
    return productsFromHtml(html).map((p) => scrubProduct(p));
  }

  /** Ajoute un produit (quantité cible absolue) — MUTATION. */
  async addToCart(productId: string, quantity: number): Promise<Cart> {
    return this.mutate('add_to_cart', productId, quantity, ACTION_ADD);
  }

  /** Met la quantité absolue (0 = retire). */
  async updateQuantity(productId: string, quantity: number): Promise<Cart> {
    // ACTION_SUB avec qté cible 0 retire ; sinon on走 ADD vers la cible.
    const action = quantity === 0 ? 2 : ACTION_ADD;
    return this.mutate('update_quantity', productId, quantity, action);
  }

  /** Retire une ligne entièrement (qté 0, SUB). */
  async removeFromCart(productId: string): Promise<Cart> {
    return this.mutate('remove_from_cart', productId, 0, 2);
  }

  // ---- Store finder (lecture) ----

  async findStores(
    query: string,
  ): Promise<{ name: string; serviceType?: string; host: string; storeId: string }[]> {
    const acJson = await this.getJson(autocompleteUrl(query), 'autocomplete');
    const place = (acJson as { postalCodes?: { id: string; postalCode?: string }[] })
      .postalCodes?.[0];
    if (!place) return [];
    const coord = (await this.getJson(coordinatesUrl(place.id), 'coordinates')) as {
      latitude?: number;
      longitude?: number;
    };
    const lat = coord.latitude!;
    const lng = coord.longitude!;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const nearby = (await this.getJson(
      nearbyUrl(lat, lng, place.postalCode ?? ''),
      'nearby',
    )) as { points?: { name?: string; serviceType?: string; urlBase?: string }[] };
    return (nearby.points ?? [])
      .map((p) => {
        const host = leclercHostFromUrl(p.urlBase);
        const storeId = leclercStoreIdFromUrl(p.urlBase);
        return host && storeId
          ? { name: p.name ?? 'Drive', serviceType: p.serviceType, host, storeId }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  // ---- internals ----------------------------------------------------------

  private async mutate(
    command: 'add_to_cart' | 'update_quantity' | 'remove_from_cart',
    productId: string,
    quantity: number,
    action: number,
  ): Promise<Cart> {
    if (!this.host || !isLeclercHost(this.host)) {
      const err = `Host refusé (non-Leclerc) : ${this.host}`;
      this.logCmd(command, false, { error: err, productId, quantity });
      throw new Error(err);
    }
    const url = cartMutationUrl(this.host, this.storeId, this.storeId);
    const body = cartMutationBody(productId, quantity, action, this.storeId);

    return this.serialize(async () => {
      let attempts = 0;
      let lastErr: string | undefined;
      for (let trial = 0; trial <= this.maxRetries; trial++) {
        attempts = trial + 1;
        try {
          const res = await this.fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest',
            },
            body,
          });
          if (res.status === 200) {
            const txt = await res.text();
            let events: CartEvent[];
            try {
              events = JSON.parse(txt) as CartEvent[];
            } catch {
              // Parfois Leclerc renvoie du HTML contenant un Array membre.
              const arrMatch = txt.match(/\[[\s\S]*\]/);
              events = arrMatch ? (JSON.parse(arrMatch[0]) as CartEvent[]) : [];
            }
            const cart = cartFromEvents(events, this.storeId);
            this.logCmd(command, true, { attempts, productId, quantity });
            return cart;
          }
          if (isRetryableStatus(res.status)) {
            lastErr = `HTTP ${res.status} (DataDome)`;
            await this.sleep(this.backoffMs(trial));
            continue;
          }
          lastErr = `HTTP ${res.status}`;
          break;
        } catch (e) {
          lastErr = (e as Error).message;
          await this.sleep(this.backoffMs(trial));
        }
      }
      this.logCmd(command, false, { attempts, error: lastErr, productId, quantity });
      throw new Error(`${command} échoué : ${lastErr ?? 'erreur inconnue'}`);
    });
  }

  private async getHtml(url: string, command: string): Promise<string> {
    return this.serialize(async () => {
      let attempts = 0;
      let lastErr: string | undefined;
      for (let trial = 0; trial <= this.maxRetries; trial++) {
        attempts = trial + 1;
        try {
          const res = await this.fetch(url, { method: 'GET' });
          if (res.status === 200) {
            const html = await res.text();
            try {
              assertStorePage(html);
            } catch (e) {
              this.logCmd(command, false, { attempts, error: (e as Error).message });
              throw e;
            }
            this.logCmd(command, true, { attempts });
            return html;
          }
          if (isRetryableStatus(res.status)) {
            lastErr = `HTTP ${res.status} (DataDome)`;
            await this.sleep(this.backoffMs(trial));
            continue;
          }
          lastErr = `HTTP ${res.status}`;
          break;
        } catch (e) {
          lastErr = (e as Error).message;
          if (!isRetryableStatusLike(e)) await this.sleep(this.backoffMs(trial));
        }
      }
      this.logCmd(command, false, { attempts, error: lastErr });
      throw new Error(`${command} échoué : ${lastErr ?? 'erreur inconnue'}`);
    });
  }

  private async getJson(url: string, command: string): Promise<unknown> {
    const html = await this.getHtmlJson(url, command);
    try {
      return JSON.parse(html);
    } catch {
      return {};
    }
  }

  private async getHtmlJson(url: string, command: string): Promise<string> {
    return this.serialize(async () => {
      const res = await this.fetch(url, { method: 'GET' });
      const txt = await res.text();
      if (res.status !== 200) {
        this.logCmd(command, false, { status: res.status, error: `HTTP ${res.status}` });
        throw new Error(`${command}: HTTP ${res.status}`);
      }
      this.logCmd(command, true, { status: res.status });
      return txt;
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => this.throttle(),
      () => this.throttle(),
    );
    return run as Promise<T>;
  }

  private async throttle(): Promise<void> {
    const elapsed = this.now() - this.lastCallAt;
    const wait = Math.max(0, this.minIntervalMs - elapsed) + Math.random() * this.jitterMs;
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = this.now();
  }

  private backoffMs(trial: number): number {
    return Math.min(4000, 400 * 2 ** trial) + Math.random() * this.jitterMs;
  }

  private logCmd(
    command: string,
    ok: boolean,
    extra: Partial<ConnectorLogEntry>,
  ): void {
    if (!this.log) return;
    this.log({
      at: this.now(),
      command,
      host: this.host,
      storeId: this.storeId,
      ok,
      ...extra,
    });
  }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Épure le texte non fiable remonté au modèle : décode les entités HTML et
 * retire les séquences pouvant mimer des frontières de chat/system/tool.
 */
export function scrubUntrusted(text: string): string {
  return decodeEntities(text)
    .replace(/<\/?system>/gi, '')
    .replace(/<\|im_start\|>|<\|im_end\|>/gi, '')
    .replace(/\[(?:system|tool|assistant|user)\]/gi, '')
    .replace(/\bproduct_id\b/gi, 'reference') // neutre : le modèle ne doit pas pousser d'id
    .trim();
}

function scrubProduct(p: Product): Product {
  const label = scrubUntrusted(p.label);
  const brand = p.brand ? scrubUntrusted(p.brand) : undefined;
  return { ...p, label, ...(brand ? { brand } : {}) };
}

function isRetryableStatusLike(e: unknown): boolean {
  return e instanceof Error && /HTTP 403|HTTP 429|DataDome/.test(e.message);
}

/** Extrait l'hôte fdN-courses… d'une URL magasin Leclerc. */
export function leclercHostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/https?:\/\/(fd\d+-courses\.leclercdrive\.fr)/i);
  return m ? m[1] : null;
}

/** Extrait le storeId depuis l'URL /magasin-<id>-<id>-…/ . */
export function leclercStoreIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/magasin-(\d+)-/i);
  return m ? m[1] : null;
}

export { formatCart, formatProduct };
