/** Connecteur Leclerc avec fetch mocké. */
import { test, assert } from './helpers.ts';
import { LeclercConnector, type FetchLike } from '../src/features/leclerc/connector.ts';
import {
  productsFromHtml,
  cartFromHtml,
  STORE_PAGE_MARKER,
  NO_MATCH_QUERY,
} from '../src/features/leclerc/api.ts';

const LECLERC_HOST = 'fd9-courses.leclercdrive.fr';
const STORE_ID = '053701';

/** Page magasin synthétique portant 2 produits + un panier. */
function fakeSearchPage(products: { id: string; label: string; price: string; type?: string }[], cartTotal = '18,18 €') {
  const prods = products
    .map(
      (p) =>
        `{"iIdProduit":${p.id},"sLibelleLigne1":"${p.label}","sLibelleLigne2":"","nrPVUnitaireTTC":null,"sPrixUnitaire":"${p.price}","iQteDisponible":1,"sType":"${p.type ?? 'Produit'}"}`,
    )
    .join(',');
  const html =
    `<html>... "lstProduitsLight":{"sTotalAPayer":"${cartTotal}","iQuantitePanier":2} ...` +
    `"lstProduits":[${prods}] ... ${STORE_PAGE_MARKER} ...</html>`;
  return html;
}

function fetchMock(map: Record<string, (init?: { method?: string; body?: string }) => { status: number; text: () => Promise<string> }>): FetchLike {
  return async (input, init) => {
    const key = Object.keys(map).find((u) => input.includes(u));
    const handler = key ? map[key] : map['*'];
    if (!handler) throw new Error('no mock for ' + input);
    const res = handler(init);
    return { status: res.status, ok: res.status === 200, text: res.text };
  };
}

test('searchProducts : parse les produits et scribble', async () => {
  const html = fakeSearchPage([
    { id: '111', label: 'Lait demi-écrémé Bio 1L', price: '1,29 €' },
    { id: '222', label: 'Pâtes', price: '0,89 €' },
  ]);
  const fetch = fetchMock({ 'recherche.aspx': () => ({ status: 200, text: () => Promise.resolve(html) }) });
  const c = new LeclercConnector({ fetch, session: { host: LECLERC_HOST, storeId: STORE_ID, userAgent: 'UA' } });
  const products = await c.searchProducts('lait');
  assert.equal(products.length, 2);
  assert.equal(products[0].id, '111');
  assert.ok(products[0].label.includes('Lait'));
  assert.ok(products[0].price > 0);
});

test('searchProducts : page bloc DataDome (sans marker) => erreur actionnable', async () => {
  const fetch = fetchMock({ 'recherche.aspx': () => ({ status: 200, text: () => Promise.resolve('<html>datadome</html>') }) });
  const c = new LeclercConnector({ fetch, session: { host: LECLERC_HOST, storeId: STORE_ID, userAgent: 'UA' } });
  await assert.rejects(() => c.searchProducts('x'), /DataDome|session/i);
});

test('searchProducts : HTTP 403 retryable puis succès', async () => {
  let calls = 0;
  const html = fakeSearchPage([{ id: '1', label: 'X', price: '1 €' }]);
  const fetch: FetchLike = async () => {
    calls++;
    if (calls < 3) return { status: 403, ok: false, text: () => Promise.resolve('block') };
    return { status: 200, ok: true, text: () => Promise.resolve(html) };
  };
  const c = new LeclercConnector({
    fetch,
    session: { host: LECLERC_HOST, storeId: STORE_ID, userAgent: 'UA' },
    sleep: () => Promise.resolve(),
  });
  const products = await c.searchProducts('x');
  assert.ok(calls >= 3);
  assert.equal(products.length, 1);
});

test('getCart : panier depuis page no-match', async () => {
  const html =
    `<html>"lstProduitsLight":{"sTotalAPayer":"10,00 €","iQuantitePanier":2}` +
    `"lstProduits":[{"iIdProduit":1,"sLibelleLigne1":"Lait","nrPVUnitaireTTC":2,"iQuantitePanier":2,"rTotalAPayer":4,"sType":"Produit"}]` +
    `${STORE_PAGE_MARKER}</html>`;
  const fetch = fetchMock({ [NO_MATCH_QUERY]: () => ({ status: 200, text: () => Promise.resolve(html) }) });
  const c = new LeclercConnector({ fetch, session: { host: LECLERC_HOST, storeId: STORE_ID, userAgent: 'UA' } });
  const cart = await c.getCart();
  assert.equal(cart.storeId, STORE_ID);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.total, 10);
});

test('addToCart : POST avec body cartMutationBody + log ok', async () => {
  let body = '';
  const fetch: FetchLike = async (_input, init) => {
    body = init?.body ?? '';
    return {
      status: 200,
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { sIdUnique: 'Panier', objElement: { rTotalAPayer: 5, iQuantitePanier: 3 } },
            { sIdUnique: 'Produit1', objElement: { iIdProduit: 9, sLibelleLigne1: 'Lait', sType: 'Produit', iQuantitePanier: 3, nrPVUnitaireTTC: 1.5, rTotalAPayer: 4.5 } },
          ]),
        ),
    };
  };
  const logger: { ok: boolean; command: string }[] = [];
  const c = new LeclercConnector({
    fetch,
    session: { host: LECLERC_HOST, storeId: STORE_ID, userAgent: 'UA' },
    sleep: () => Promise.resolve(),
    log: (e) => logger.push({ ok: e.ok, command: e.command }),
  });
  const cart = await c.addToCart('9', 3);
  assert.ok(body.startsWith('d='));
  assert.ok(body.includes('iIdProduit'));
  assert.equal(cart.itemCount, 3);
  assert.ok(logger.some((l) => l.command === 'add_to_cart' && l.ok));
});

test('host non-Leclerc à la construction => jeté', () => {
  assert.throws(
    () => new LeclercConnector({ fetch: fetchMock({}), session: { host: 'evil.example.com', storeId: 'x', userAgent: 'UA' } }),
    /non-Leclerc/i,
  );
});

test('productsFromHtml pure : parsing hors fetch', () => {
  const html = fakeSearchPage([{ id: '7', label: 'Pâtes', price: '0,89 €' }]);
  const p = productsFromHtml(html);
  assert.equal(p.length, 1);
});

test('cartFromHtml pure : panier', () => {
  const html = `<html>"lstProduitsLight":{"sTotalAPayer":"6,00 €"}"lstProduits":[{"iIdProduit":1,"sLibelleLigne1":"L","nrPVUnitaireTTC":2,"iQuantitePanier":3,"rTotalAPayer":6,"sType":"Produit"}]${STORE_PAGE_MARKER}</html>`;
  const cart = cartFromHtml(html, STORE_ID);
  assert.equal(cart.total, 6);
  assert.equal(cart.items[0].quantity, 3);
});
