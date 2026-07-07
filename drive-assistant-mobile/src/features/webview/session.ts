/**
 * Capture et maintien de la session Leclerc depuis la WebView.
 *
 * L'app embarque une WebView Leclerc officielle. À l'issue du login, on
 * extrait :
 *  - l'hôte backend du drive (`fdN-courses.leclercdrive.fr`),
 *  - le storeId (depuis le path `/magasin-<id>-<id>-…/`),
 *  - le User-Agent de la WebView (emprunte l'empreinte réelle).
 *
 * Les cookies ne sont jamais lus, stockés ni exfiltrés en clair : ils demeurent
 * dans le cookie jar de la WebView, et le connecteur (connector.ts) réutilise
 * le même fetch porteur de session. Aucun mot de passe n'est persisté.
 */

import { isLeclercHost } from '../leclerc/api.ts';
import { leclercHostFromUrl, leclercStoreIdFromUrl } from '../leclerc/connector.ts';

/** État de session sensible (jamais de mot de passe / données bancaires). */
export interface WebSession {
  host: string;
  storeId: string;
  /** User-Agent réel de la WebView. */
  userAgent: string;
  /** URL courante de la WebView (debug uniquement). */
  currentUrl: string;
  /** User connected (page panier accessible). */
  connected: boolean;
}

export function isWebSession(value: unknown): value is WebSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<WebSession>;
  return (
    typeof s.host === 'string' &&
    isLeclercHost(s.host) &&
    typeof s.storeId === 'string' &&
    /^\d+$/.test(s.storeId) &&
    typeof s.userAgent === 'string' &&
    typeof s.currentUrl === 'string' &&
    s.connected === true
  );
}

export function parseStoredWebSession(raw: string): WebSession | null {
  try {
    const parsed = JSON.parse(raw);
    return isWebSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Tente de bâtir une session Leclerc à partir de l'URL + UA de la WebView.
 * Retourne null tant qu'on n'est pas sur une page magasin Leclerc valide.
 */
export function deriveWebSession(
  currentUrl: string,
  userAgent: string,
): WebSession | null {
  const host = leclercHostFromUrl(currentUrl);
  const storeId = leclercStoreIdFromUrl(currentUrl) ?? leclercStoreIdFromMagQuery(currentUrl);
  if (!host || !storeId || !isLeclercHost(host)) return null;
  return {
    host,
    storeId,
    userAgent: userAgent || 'Mozilla/5.0 (Drive Assistant Mobile)',
    currentUrl,
    connected: true,
  };
}

function leclercStoreIdFromMagQuery(url: string): string | null {
  try {
    const mag = new URL(url).searchParams.get('mag');
    const m = mag?.match(/^(\d+)-/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const STORE_URL_PICKER_JS = `
function driveAssistantStoreUrl() {
  var html = document.documentElement && document.documentElement.innerHTML
    ? document.documentElement.innerHTML
    : '';
  var urls = [window.location.href];
  var links = document.querySelectorAll('a[href], link[href]');
  for (var i = 0; i < links.length; i += 1) {
    if (links[i].href) urls.push(links[i].href);
  }
  for (var j = 0; j < urls.length; j += 1) {
    if (/^https?:\\/\\/fd\\d+-courses\\.leclercdrive\\.fr\\/.*\\/magasin-\\d+-/i.test(urls[j])) {
      return urls[j];
    }
  }
  var hostFromUrl = null;
  for (var k = 0; k < urls.length; k += 1) {
    var hostMatch = urls[k].match(/fd\\d+-courses\\.leclercdrive\\.fr/i);
    if (hostMatch && hostMatch[0]) {
      hostFromUrl = hostMatch[0];
      break;
    }
  }
  var absolute = html.match(/https?:\\/\\/fd\\d+-courses\\.leclercdrive\\.fr\\/[^"'<>\\\\\\s]*magasin-\\d+-[^"'<>\\\\\\s]*/i);
  if (absolute && absolute[0]) return absolute[0].replace(/&amp;/g, '&');
  var host = html.match(/fd\\d+-courses\\.leclercdrive\\.fr/i);
  var path = html.match(/\\/magasin-\\d+-[^"'<>\\\\\\s]*/i);
  if (host && host[0] && path && path[0]) {
    return 'https://' + host[0] + path[0].replace(/&amp;/g, '&');
  }
  var mag = window.location.href.match(/[?&]mag=(\\d+)-/i);
  var fallbackHost = hostFromUrl || (host && host[0]);
  if (fallbackHost && mag && mag[1]) {
    return 'https://' + fallbackHost + '/magasin-' + mag[1] + '-' + mag[1];
  }
  return window.location.href;
}
`;

/** borne d'événement injectée sur la WebView pour remonter URL + UA. */
export const SESSION_PROBE_JS = `
(function() {
  try {
    ${STORE_URL_PICKER_JS}
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'session_probe',
      url: driveAssistantStoreUrl(),
      currentUrl: window.location.href,
      userAgent: navigator.userAgent,
    }));
  } catch (e) {}
})();
true;
`;

/** borne injectée après login pour confirmer la présence d'une page panier. */
export const LOGIN_CONFIRM_JS = `
(function() {
  try {
    ${STORE_URL_PICKER_JS}
    var connected = !!document.querySelector('[href*="mon-compte"], [href*="panier.aspx"]');
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'login_state',
      connected: connected,
      url: driveAssistantStoreUrl(),
      currentUrl: window.location.href,
      userAgent: navigator.userAgent,
    }));
  } catch (e) {}
})();
true;
`;

export type WebViewMessage =
  | { type: 'session_probe'; url: string; currentUrl?: string; userAgent: string }
  | { type: 'login_state'; connected: boolean; url: string; currentUrl?: string; userAgent: string };

export function parseWebViewMessage(raw: string): WebViewMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
      return obj as WebViewMessage;
    }
  } catch {
    /* ignore */
  }
  return null;
}
