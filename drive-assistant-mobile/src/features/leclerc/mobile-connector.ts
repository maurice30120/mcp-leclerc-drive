/**
 * Fabrique de LeclercConnector à partir de la session WebView courante.
 *
 * Par défaut, on utilise le fetch React Native et le cookie jar natif partagé
 * avec la WebView (`sharedCookiesEnabled`). Le fetch reste injectable pour les
 * tests et pour remplacer ce comportement par un adaptateur cookies dédié.
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
