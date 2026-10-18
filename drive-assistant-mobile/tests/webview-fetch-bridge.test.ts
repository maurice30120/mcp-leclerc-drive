/** Pont fetch via la WebView Leclerc (injectJavaScript + postMessage). */
import { test, assert } from './helpers.ts';
import { WebViewFetchBridge, buildFetchScript } from '../src/features/webview/fetch-bridge.ts';

const HOST = 'fd9-courses.leclercdrive.fr';
const URL = `https://${HOST}/magasin-053701-053701/recherche.aspx?TexteRecherche=lait`;

/** Simule une WebView : capture le JS injecté et expose post() pour renvoyer une réponse. */
function fakeWebView() {
  const injected: string[] = [];
  let listener: ((raw: string) => void) | null = null;
  return {
    inject: (js: string) => injected.push(js),
    injected,
    /** La page injectée appelle ReactNativeWebView.postMessage → on relaye ici. */
    post: (raw: string) => listener?.(raw),
    setListener: (fn: (raw: string) => void) => {
      listener = fn;
    },
  };
}

/** Simule l'exécution du script injecté : extrait les littéraux et appelle post(). */
function runInjectedScript(js: string, post: (raw: string) => void, opts: { fetchStatus?: number; fetchBody?: string; fetchError?: string; locationHost?: string } = {}): void {
  const status = opts.fetchStatus ?? 200;
  const body = opts.fetchBody ?? '';
  const locationHost = opts.locationHost ?? HOST;
  // Extrait les littéraux JSON du script (url, headers, body, expectedHost, method).
  const url = extractJsonLiteral(js, 'var url =');
  const expectedHost = extractJsonLiteralOrNull(js, 'var expectedHost =');
  const method = extractJsonLiteral(js, 'var method =') ?? 'GET';
  const id = extractJsonLiteral(js, 'var id =') ?? '';
  if (expectedHost && locationHost !== expectedHost) {
    post(JSON.stringify({ type: 'fetch_response', id, error: 'mauvais host' }));
    return;
  }
  if (opts.fetchError) {
    post(JSON.stringify({ type: 'fetch_response', id, error: opts.fetchError }));
    return;
  }
  post(JSON.stringify({ type: 'fetch_response', id, status, ok: status >= 200 && status < 300, body }));
  void url;
  void method;
}

function extractJsonLiteral(js: string, marker: string): string | null {
  const at = js.indexOf(marker);
  if (at < 0) return null;
  const rest = js.slice(at + marker.length).trim();
  if (rest[0] !== '"') return null;
  // parse a JSON string literal
  let i = 1;
  let out = '';
  while (i < rest.length) {
    if (rest[i] === '\\' && i + 1 < rest.length) {
      out += rest[i + 1];
      i += 2;
      continue;
    }
    if (rest[i] === '"') return out;
    out += rest[i];
    i++;
  }
  return null;
}

function extractJsonLiteralOrNull(js: string, marker: string): string | null {
  const at = js.indexOf(marker);
  if (at < 0) return null;
  const rest = js.slice(at + marker.length).trim();
  if (rest.startsWith('null')) return null; // expectedHost null case
  return extractJsonLiteral(js, marker);
}

/** Retourne le littéral JSON string brut (avec quotes) qui suit `marker`, pour JSON.parse. */
function extractRawJsonString(js: string, marker: string): string {
  const at = js.indexOf(marker);
  if (at < 0) throw new Error('marker introuvable: ' + marker);
  const rest = js.slice(at + marker.length).trim();
  if (rest[0] !== '"') throw new Error('pas un string literal après ' + marker);
  let i = 1;
  while (i < rest.length) {
    if (rest[i] === '\\') {
      i += 2;
      continue;
    }
    if (rest[i] === '"') return rest.slice(0, i + 1);
    i++;
  }
  throw new Error('littéral non fermé');
}

test('request : round-trip fetch via la WebView (200 + body)', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge();
  bridge.attach(wv.inject, HOST);
  wv.setListener((raw) => bridge.handleMessage(raw));

  const pending = bridge.request(URL, { method: 'GET' });
  assert.equal(wv.injected.length, 1);
  runInjectedScript(wv.injected[0], wv.post, { fetchStatus: 200, fetchBody: '<html>lait</html>' });

  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(await res.text(), '<html>lait</html>');
});

test('request : erreur (fetch reject côté page) remontée', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge();
  bridge.attach(wv.inject, HOST);
  wv.setListener((raw) => bridge.handleMessage(raw));

  const pending = bridge.request(URL);
  runInjectedScript(wv.injected[0], wv.post, { fetchError: 'NetworkError' });
  await assert.rejects(() => pending, /NetworkError/);
});

test('request : origin guard → erreur si WebView pas sur le host attendu', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge();
  bridge.attach(wv.inject, HOST);
  wv.setListener((raw) => bridge.handleMessage(raw));

  const pending = bridge.request(URL);
  // La page est sur www.leclercdrive.fr, pas sur fd9-courses…
  runInjectedScript(wv.injected[0], wv.post, { locationHost: 'www.leclercdrive.fr' });
  await assert.rejects(() => pending, /mauvais host/);
});

test('request : erreur claire si WebView non attachée', async () => {
  const bridge = new WebViewFetchBridge();
  bridge.attach(null, HOST);
  await assert.rejects(() => bridge.request(URL), /WebView Leclerc non attachée/);
});

test('request : timeout si la WebView ne répond pas', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge({ timeoutMs: 40 });
  // Pas de setListener → la réponse ne revient jamais.
  bridge.attach(wv.inject, HOST);
  await assert.rejects(() => bridge.request(URL, { method: 'GET' }), /Timeout fetch Leclerc/);
  assert.equal(bridge.pendingCount, 0);
});

test('handleMessage : ignore les messages non-fetch (sonde de session)', () => {
  const bridge = new WebViewFetchBridge();
  bridge.attach(() => {}, HOST);
  const consumed = bridge.handleMessage(
    JSON.stringify({ type: 'session_probe', url: 'https://x/', userAgent: 'UA' }),
  );
  assert.equal(consumed, false);
});

test('handleMessage : ignore un JSON invalide', () => {
  const bridge = new WebViewFetchBridge();
  bridge.attach(() => {}, HOST);
  assert.equal(bridge.handleMessage('not json'), false);
});

test('buildFetchScript : sérialise url/body sans casser le littéral JS', () => {
  const trickyUrl = 'https://x/path?a=1&b="q"</script>';
  const trickyBody = 'd=</script>&x="1';
  const js = buildFetchScript({
    id: 'fetch-1',
    url: trickyUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: trickyBody,
    expectedHost: HOST,
  });
  // Le littéral url doit être un JSON string valide (quotes/backslash échappés),
  // et le corps du script doit rester exécutable : on extrait le littéral via
  // JSON.parse pour prouver qu'il round-trip exactement.
  const urlLit = extractRawJsonString(js, 'var url =');
  assert.equal(JSON.parse(urlLit), trickyUrl);
  const bodyLit = extractRawJsonString(js, 'var body =');
  assert.ok(bodyLit !== null);
  assert.equal(JSON.parse(bodyLit as string), trickyBody);
  assert.ok(js.includes('fetch('));
});

test('request : envoie credentials include + Accept par défaut', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge({ timeoutMs: 1000 });
  bridge.attach(wv.inject, HOST);
  wv.setListener((raw) => bridge.handleMessage(raw));
  const pending = bridge.request(URL, { method: 'GET' });
  const js = wv.injected[0];
  assert.ok(js.includes("credentials: 'include'"));
  assert.ok(js.includes('text/html'));
  // On répond pour ne pas laisser de promesse en suspens.
  runInjectedScript(js, wv.post, { fetchStatus: 200, fetchBody: '' });
  await pending;
});

test('request : auto-navigation vers le drive puis retry sur origin mismatch', async () => {
  const wv = fakeWebView();
  const bridge = new WebViewFetchBridge({ timeoutMs: 2000 });
  bridge.attach(wv.inject, HOST);
  bridge.setExpectedHost(HOST);
  bridge.setStoreId('053701');
  wv.setListener((raw) => bridge.handleMessage(raw));

  const pending = bridge.request(URL, { method: 'GET' });
  // 1) La page est sur www.leclercdrive.fr → origin mismatch.
  const firstJs = wv.injected[0];
  const firstId = extractJsonLiteral(firstJs, 'var id =')!;
  wv.post(JSON.stringify({
    type: 'fetch_response', id: firstId, originMismatch: true,
    currentHost: 'www.leclercdrive.fr', expectedHost: HOST,
  }));
  // Le bridge doit avoir injecté location.replace(driveUrl).
  const navJs = wv.injected[1];
  assert.ok(navJs.includes('location.replace('));
  assert.ok(navJs.includes('magasin-053701-053701'));

  // 2) La navigation se termine (onLoadEnd) → le bridge réinjecte le fetch.
  bridge.notifyLoadEnded();
  const retryJs = wv.injected[2];
  assert.ok(retryJs.includes('fetch('));
  const retryId = extractJsonLiteral(retryJs, 'var id =')!;
  assert.notEqual(retryId, firstId);

  // 3) Cette fois la page est sur le bon host → 200 + body.
  wv.post(JSON.stringify({ type: 'fetch_response', id: retryId, status: 200, ok: true, body: '<html>panier</html>' }));
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>panier</html>');
});
