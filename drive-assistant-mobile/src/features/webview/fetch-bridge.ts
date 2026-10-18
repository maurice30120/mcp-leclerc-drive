/**
 * Pont fetch via la WebView Leclerc — l'« injecteur MAIN-world » mobile.
 *
 * Problème : appeler Leclerc depuis le runtime React Native (OkHttp sur
 * Android, NSURLSession sur iOS) casse la session DataDome. Le client HTTP
 * natif a une empreinte TLS/HTTP distincte du Chromium WebView qui a passé le
 * challenge, et `sharedCookiesEnabled` ne partage les cookies ni de façon
 * fiable (iOS) ni suffisante pour tromper le fingerprinting DataDome (Android).
 *
 * Solution : exécuter le `fetch` *à l'intérieur* de la WebView Leclerc déjà
 * authentifiée, via `injectJavaScript`. C'est l'équivalent mobile de
 * `extension/inject.ts` (MCP, MAIN-world) : même client HTTP, mêmes cookies
 * de session, même empreinte DataDome que la page qui a passé le challenge.
 *
 * Flux :
 *  1. Le connecteur (`FetchLike`) appelle `bridge.request(url, init)`.
 *  2. Le bridge génère un id de corrélation, injecte un script autonome dans
 *     la WebView. Ce script vérifie l'origin, exécute
 *     `fetch(url, { credentials: 'include', ... })` dans le contexte de la
 *     page, lit `.text()`, puis `postMessage` le résultat.
 *  3. Le `onMessage` de la WebView route le message vers
 *     `bridge.handleMessage`, qui résout la promesse pending.
 *
 * Garde-fous :
 *  - origin guard : le script vérifie `location.host === host attendu` avant
 *    de fetcher (sinon CORS + cookies perdus) et poste une erreur claire ;
 *  - timeout : si la WebView ne répond pas (démontée, naviguée, plantée),
 *    on rejette avec un message actionnable ;
 *  - plusieurs pending concurrents gérés via une map id→resolver (le
 *    connecteur sérialise déjà via son throttle, mais on reste sûr).
 *
 * Le bridge ne dépend d'aucune API React Native : il reçoit la fonction
 * `inject` (typiquement `ref.current.injectJavaScript`) et les messages
 * bruts depuis l'écran WebView. Testable sans RN.
 */

import type { FetchLike } from '../leclerc/connector.ts';

/** Réponse renvoyée au connecteur (sous-ensemble de la Response WHATWG). */
export interface FetchResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}

/** Fonction d'injection fournie par l'écran WebView. */
export type InjectFn = (js: string) => void;

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';
const DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (r: FetchResponse) => void;
  reject: (e: Error) => void;
  url: string;
  timer: ReturnType<typeof setTimeout>;
  /** Descripteur de la requête d'origine, pour ré-injection après navigation. */
  request?: { input: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
  /** Déjà re-tenté après auto-navigation (évite la boucle). */
  retried?: boolean;
  /** En attente d'un onLoadEnd pour re-tenter après navigation vers le drive. */
  awaitingLoad?: boolean;
}

/**
 * Message posté par le script injecté. `type` discriminateur pour que
 * `handleMessage` le distingue des messages de sonde de session.
 */
export interface FetchResponseMessage {
  type: 'fetch_response';
  id: string;
  status?: number;
  ok?: boolean;
  body?: string;
  error?: string;
  /** True si la page injectée n'était pas sur le host attendu (origin guard). */
  originMismatch?: boolean;
  currentHost?: string;
  expectedHost?: string;
}

export interface WebViewFetchBridgeOptions {
  /** Délai avant rejet si la WebView ne répond pas (défaut 30s). */
  timeoutMs?: number;
  /** Horloge/sleep injectables pour les tests. */
  now?: () => number;
}

export class WebViewFetchBridge {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private inject: InjectFn | null = null;
  private expectedHost: string | null = null;
  /** URL racine du drive (https://{host}/magasin-{storeId}-{storeId}/) pour auto-navigation. */
  private driveUrl: string | null = null;
  private seq = 0;

  constructor(opts: WebViewFetchBridgeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Attache le bridge à une WebView vivante. L'écran WebView appelle ceci
   * via un callback ref (à l'attachement ET au détachement avec `null`).
   */
  attach(inject: InjectFn | null, host: string | null): void {
    this.inject = inject;
    if (host !== undefined) this.expectedHost = host;
  }

  /** Met à jour l'hôte Leclerc attendu (depuis la session courante). */
  setExpectedHost(host: string | null): void {
    this.expectedHost = host;
    this.recomputeDriveUrl();
  }

  /** Met à jour le storeId (avec le host attendu) pour bâtir l'URL d'auto-navigation. */
  setStoreId(storeId: string | null): void {
    this.storeId = storeId;
    this.recomputeDriveUrl();
  }
  private storeId: string | null = null;

  /**
   * URL racine du drive vers laquelle naviguer quand la WebView a dérivé.
   * `https://{host}/magasin-{storeId}-{storeId}/` — le slug est cosmétique.
   */
  private recomputeDriveUrl(): void {
    if (this.expectedHost && this.storeId) {
      this.driveUrl = `https://${this.expectedHost}/magasin-${this.storeId}-${this.storeId}/`;
    } else {
      this.driveUrl = null;
    }
  }

  /**
   * Appelé par l'écran WebView sur `onLoadEnd`. Si une requête est en attente
   * de re-tente après navigation vers le drive, on ré-injecte le fetch
   * (même id → le resolver existant consommera la réponse).
   */
  notifyLoadEnded(): void {
    for (const [id, p] of this.pending.entries()) {
      if (!p.awaitingLoad) continue;
      p.awaitingLoad = false;
      const req = p.request;
      if (!req) continue;
      const js = buildFetchScript({
        id,
        url: req.input,
        method: req.init?.method ?? 'GET',
        headers: req.init?.headers ?? {},
        body: req.init?.body,
        expectedHost: this.expectedHost,
      });
      try {
        this.inject?.(js);
      } catch {
        /* le timeout reprendra si l'injection échoue */
      }
      break; // au plus une requête en attente (connecteur sérialisé)
    }
  }

  /** True ssi le bridge peut émettre des fetch (WebView attachée). */
  isAttached(): boolean {
    return this.inject !== null;
  }

  /**
   * Route un message brut venant du `onMessage` de la WebView.
   * Retourne true ssi le message était une réponse fetch (consommée) ;
   * false sinon (l'appelant peut alors le passer à d'autres handlers, ex. la
   * sonde de session).
   */
  handleMessage(raw: string): boolean {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as { type?: string; id?: string };
    if (m.type !== 'fetch_response' || typeof m.id !== 'string') return false;

    const p = this.pending.get(m.id);
    if (!p) return false; // réponse orpheline (timeout écoulé) — on ignore
    const r = msg as FetchResponseMessage;

    // Origin mismatch : si on connaît l'URL racine du drive et qu'on n'a pas
    // encore retry, on navigue la WebView vers le drive puis on attend le
    // onLoadEnd (notifyLoadEnded) pour ré-injecter le fetch. Sinon on rejette.
    if (r.originMismatch) {
      if (this.driveUrl && this.inject && !p.retried) {
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        const id = `fetch-${++this.seq}`;
        p.retried = true;
        p.awaitingLoad = true;
        p.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          p.reject(
            new Error(
              `Auto-navigation vers le drive Leclerc échouée (timeout). Rouvre la WebView ` +
                'et reste sur la page magasin, puis réessaye.',
            ),
          );
        }, this.timeoutMs);
        this.pending.set(id, p);
        try {
          this.inject(`location.replace(${JSON.stringify(this.driveUrl)});`);
        } catch (e) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new Error(`Navigation WebView impossible : ${(e as Error).message}`));
        }
        return true;
      }
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.reject(new Error(r.error ?? 'La WebView n est pas sur le drive Leclerc attendu.'));
      return true;
    }

    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (typeof r.error === 'string' && r.error) {
      p.reject(new Error(r.error));
      return true;
    }
    const status = typeof r.status === 'number' ? r.status : 0;
    const body = typeof r.body === 'string' ? r.body : '';
    p.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(body),
    });
    return true;
  }

  /**
   * Exécute un fetch à l'intérieur de la WebView Leclerc. Implémente `FetchLike`
   * pour que le connecteur l'utilise à la place du fetch RN natif.
   */
  request: FetchLike = async (input, init) => {
    const inject = this.inject;
    if (!inject) {
      throw new Error(
        'WebView Leclerc non attachée. Ouvre la WebView Leclerc, connecte-toi et ' +
          'reste sur la page magasin, puis reviens ici.',
      );
    }
    const id = `fetch-${++this.seq}`;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (!hasHeader(headers, 'Accept')) headers['Accept'] = DEFAULT_ACCEPT;

    const js = buildFetchScript({
      id,
      url: input,
      method,
      headers,
      body: init?.body,
      expectedHost: this.expectedHost,
    });

    return new Promise<FetchResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(
            new Error(
              `Timeout fetch Leclerc (${method} ${shortUrl(input)}). La WebView ne répond pas : ` +
                'vérifie qu elle reste ouverte sur la page magasin du drive.',
            ),
          );
        },
        this.timeoutMs,
      );
      this.pending.set(id, {
        resolve,
        reject,
        url: input,
        timer,
        request: { input, init: { method, headers, body: init?.body } },
      });
      try {
        inject(js);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Injection WebView impossible : ${(e as Error).message}`));
      }
    });
  };

  /** Pour tests / debug : nombre de requêtes en attente. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === expected);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Construit le script injecté. Autonome (pas de dépendance externe) : il
 * vérifie l'origin, exécute le fetch dans le contexte de la page, lit
 * `.text()`, puis `postMessage` le résultat avec l'id de corrélation.
 *
 * Toutes les valeurs dynamiques (url, body, headers) sont sérialisées via
 * `JSON.stringify` pour éviter toute injection de guillemets/fin-de-script.
 */
export function buildFetchScript(opts: {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  expectedHost: string | null;
}): string {
  const { id, url, method, headers, body, expectedHost } = opts;
  const idLit = JSON.stringify(id);
  const urlLit = JSON.stringify(url);
  const methodLit = JSON.stringify(method);
  const headersLit = JSON.stringify(headers);
  const bodyLit = body === undefined ? 'null' : JSON.stringify(body);
  const expectedHostLit = expectedHost ? JSON.stringify(expectedHost) : 'null';

  return `
(function() {
  var id = ${idLit};
  var url = ${urlLit};
  var expectedHost = ${expectedHostLit};
  var post = function(obj) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(
        Object.assign({ type: 'fetch_response', id: id }, obj)
      ));
    } catch (e) { /* dernier recours : silencieux */ }
  };
  if (expectedHost && location.host !== expectedHost) {
    post({ originMismatch: true, currentHost: location.host, expectedHost: expectedHost,
           error: 'La WebView n est pas sur le drive Leclerc attendu (host courant : ' +
             location.host + ', attendu : ' + expectedHost + ').' });
    return;
  }
  var headers = ${headersLit};
  var init = { method: ${methodLit}, credentials: 'include', redirect: 'follow', headers: headers };
  var body = ${bodyLit};
  if (body !== null) init.body = body;
  fetch(url, init).then(function(res) {
    return res.text().then(function(txt) {
      return { status: res.status, ok: res.ok, body: txt };
    });
  }).then(function(r) {
    post({ status: r.status, ok: r.ok, body: r.body });
  }).catch(function(e) {
    post({ error: 'fetch Leclerc échoué : ' + (e && e.message ? e.message : String(e)) });
  });
})();
true;
`;
}
