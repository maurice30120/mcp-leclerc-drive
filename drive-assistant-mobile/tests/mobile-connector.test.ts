import { test, assert } from './helpers.ts';
import { STORE_PAGE_MARKER } from '../src/features/leclerc/api.ts';
import { createMobileConnector } from '../src/features/leclerc/mobile-connector.ts';

const HOST = 'fd9-courses.leclercdrive.fr';
const STORE = '053701';

function searchHtml() {
  return `<html>"lstProduitsLight":{"sTotalAPayer":"0,00 €"}"lstProduits":[{"iIdProduit":111,"sLibelleLigne1":"Pates","sPrixUnitaire":"1,00 €","iQteDisponible":1,"sType":"Produit"}]${STORE_PAGE_MARKER}</html>`;
}

test('createMobileConnector : branche le fetch React Native par défaut', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(searchHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;

    const connector = createMobileConnector({
      host: HOST,
      storeId: STORE,
      userAgent: 'DriveAssistantUA',
      currentUrl: `https://${HOST}/magasin-${STORE}-${STORE}-x.aspx`,
      connected: true,
    });

    const products = await connector.searchProducts('pates');

    assert.equal(products.length, 1);
    assert.ok(capturedUrl.includes('recherche.aspx'));
    assert.equal(capturedInit?.credentials, 'include');
    assert.equal((capturedInit?.headers as Record<string, string>)['User-Agent'], 'DriveAssistantUA');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createMobileConnector : conserve le fetch injectable', async () => {
  let called = false;
  const connector = createMobileConnector(
    {
      host: HOST,
      storeId: STORE,
      userAgent: 'UA',
      currentUrl: `https://${HOST}/magasin-${STORE}-${STORE}-x.aspx`,
      connected: true,
    },
    async () => {
      called = true;
      return { status: 200, ok: true, text: () => Promise.resolve(searchHtml()) };
    },
  );

  await connector.searchProducts('pates');

  assert.equal(called, true);
});
