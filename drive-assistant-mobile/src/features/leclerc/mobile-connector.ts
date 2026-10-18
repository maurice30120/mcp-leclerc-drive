/**
 * Fabrique de LeclercConnector à partir de la session WebView courante.
 *
 * EN PRODUCTION : passer `fetchImpl = services.webViewFetchBridge.request`.
 * Le fetch s'exécute alors *à l'intérieur* de la WebView Leclerc (pont par
 * `injectJavaScript`), ce qui réutilise le client HTTP, les cookies et
 * l'empreinte DataDome authentiques de la page qui a passé le challenge —
 * équivalent mobile de l'injecteur MAIN-world du MCP. Voir
 * `features/webview/fetch-bridge.ts`.
 *
 * Par défaut (sans `fetchImpl`), on retombe sur le fetch React Native natif
 * (OkHttp/NSURLSession). CE CHEMIN EST CASSÉ EN PROD : empreinte TLS
 * distincte du Chromium WebView et `sharedCookiesEnabled` peu fiable (surtout
 * iOS) → challenge DataDome systématique. Il ne subsiste que pour les tests
 * unitaires (mock fetch global) et comme garde-fou si aucune WebView n'est
 * attachée.
 */

import { LeclercConnector, type FetchLike } from './connector.ts';
import type { WebSession } from '../webview/session.ts';

export function createMobileConnector(
  session: WebSession,
  fetchImpl?: FetchLike,
): LeclercConnector {
  const fetch: FetchLike = fetchImpl ?? createReactNativeFetch(session);
  return new LeclercConnector({
    fetch,
    session: { host: session.host, storeId: session.storeId, userAgent: session.userAgent },
  });
}

function createReactNativeFetch(session: WebSession): FetchLike {
  return async (input, init) => {
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch React Native indisponible.');
    }

    const headers: Record<string, string> = {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(init?.headers ?? {}),
    };
    if (session.userAgent && !hasHeader(headers, 'User-Agent')) {
      headers['User-Agent'] = session.userAgent;
    }

    const response = await fetchImpl(input, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body,
      credentials: 'include',
    } as RequestInit);

    return {
      status: response.status,
      ok: response.ok,
      text: () => response.text(),
    };
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}
