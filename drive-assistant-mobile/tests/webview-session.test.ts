/** Session WebView Leclerc : dérivation host/store depuis une URL magasin. */
import { test, assert } from './helpers.ts';
import { deriveWebSession, parseStoredWebSession, parseWebViewMessage } from '../src/features/webview/session.ts';

test('deriveWebSession : publie une session connectée depuis une URL magasin fd', () => {
  const session = deriveWebSession(
    'https://fd9-courses.leclercdrive.fr/magasin-053701-053701/recherche.aspx?Texte=lait',
    'UA-WebView',
  );

  assert.equal(session?.connected, true);
  assert.equal(session?.host, 'fd9-courses.leclercdrive.fr');
  assert.equal(session?.storeId, '053701');
  assert.equal(session?.userAgent, 'UA-WebView');
});

test('deriveWebSession : ignore une URL home Leclerc sans host magasin', () => {
  const session = deriveWebSession('https://www.leclercdrive.fr/?mag=053701-053701&sRedirect=false', 'UA-WebView');

  assert.equal(session, null);
});

test('deriveWebSession : accepte mag query si le host fd Leclerc est connu', () => {
  const session = deriveWebSession('https://fd9-courses.leclercdrive.fr/?mag=053701-053701&sRedirect=false', 'UA-WebView');

  assert.equal(session?.connected, true);
  assert.equal(session?.host, 'fd9-courses.leclercdrive.fr');
  assert.equal(session?.storeId, '053701');
});

test('parseWebViewMessage : accepte le message de sonde avec currentUrl', () => {
  const msg = parseWebViewMessage(JSON.stringify({
    type: 'session_probe',
    url: 'https://fd9-courses.leclercdrive.fr/magasin-053701-053701/recherche.aspx',
    currentUrl: 'https://www.leclercdrive.fr/?mag=053701-053701&sRedirect=false',
    userAgent: 'UA-WebView',
  }));

  assert.equal(msg?.type, 'session_probe');
  assert.equal(msg?.url, 'https://fd9-courses.leclercdrive.fr/magasin-053701-053701/recherche.aspx');
});

test('parseStoredWebSession : recharge une session non sensible valide', () => {
  const session = parseStoredWebSession(JSON.stringify({
    host: 'fd9-courses.leclercdrive.fr',
    storeId: '053701',
    userAgent: 'UA-WebView',
    currentUrl: 'https://fd9-courses.leclercdrive.fr/magasin-053701-053701/recherche.aspx',
    connected: true,
  }));

  assert.equal(session?.host, 'fd9-courses.leclercdrive.fr');
  assert.equal(session?.storeId, '053701');
});

test('parseStoredWebSession : refuse un host non Leclerc', () => {
  const session = parseStoredWebSession(JSON.stringify({
    host: 'evil.example.com',
    storeId: '053701',
    userAgent: 'UA-WebView',
    currentUrl: 'https://evil.example.com/magasin-053701-053701',
    connected: true,
  }));

  assert.equal(session, null);
});
