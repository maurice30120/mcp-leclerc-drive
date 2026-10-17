/**
 * Scénario complet mocké : demande → plan → recherche → proposition →
 * validation → ajout panier. Tout via des doubles (fetch mocké, pas de RN,
 * pas de modèle IA — le normaliseur déterministe produit le plan).
 */
import { test, assert } from './helpers.ts';
import { LeclercConnector, type FetchLike } from '../src/features/leclerc/connector.ts';
import { InMemoryPermissionGate } from '../src/features/mcp/permissions.ts';
import { McpLogger } from '../src/features/mcp/logs.ts';
import { SessionHistory } from '../src/features/mcp/history.ts';
import { McpRunner } from '../src/features/mcp/runner.ts';
import { AssistantViewModel } from '../src/features/assistant/AssistantViewModel.ts';
import { STORE_PAGE_MARKER } from '../src/features/leclerc/api.ts';

const HOST = 'fd9-courses.leclercdrive.fr';
const STORE = '053701';

function searchHtml(products: { id: string; label: string }[]) {
  const arr = products
    .map((p) => `{"iIdProduit":${p.id},"sLibelleLigne1":"${p.label}","sPrixUnitaire":"1,00 €","iQteDisponible":1,"sType":"Produit"}`)
    .join(',');
  return `<html>"lstProduitsLight":{"sTotalAPayer":"0,00 €"}"lstProduits":[${arr}]${STORE_PAGE_MARKER}</html>`;
}

function cartAfterAdd() {
  return JSON.stringify([
    { sIdUnique: 'Panier', objElement: { rTotalAPayer: 3, iQuantitePanier: 3 } },
    { sIdUnique: 'Produit111', objElement: { iIdProduit: 111, sLibelleLigne1: 'Lait Bio 1L', sType: 'Produit', iQuantitePanier: 2, nrPVUnitaireTTC: 1.5, rTotalAPayer: 3 } },
  ]);
}

function makeFetch(): FetchLike & { posted: { url: string; body: string }[] } {
  const posted: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (input.includes('recherche.aspx')) {
      const q = decodeURIComponent((input.match(/TexteRecherche=([^&]+)/) ?? [])[1] ?? '');
      if (q.includes('zzz')) return { status: 200, ok: true, text: () => Promise.resolve(`<html>"lstProduitsLight":{"sTotalAPayer":"0,00 €"}${STORE_PAGE_MARKER}</html>`) };
      if (q.includes('lait')) return { status: 200, ok: true, text: () => Promise.resolve(searchHtml([{ id: '111', label: 'Lait Bio 1L' }])) };
      if (q.includes('pâtes') || q.includes('pates')) return { status: 200, ok: true, text: () => Promise.resolve(searchHtml([{ id: '222', label: 'Pâtes 500g' }])) };
      return { status: 200, ok: true, text: () => Promise.resolve(searchHtml([])) };
    }
    if (input.includes('panier.aspx')) {
      posted.push({ url: input, body: init?.body ?? '' });
      return { status: 200, ok: true, text: () => Promise.resolve(cartAfterAdd()) };
    }
    throw new Error('unexpected url ' + input);
  };
  return Object.assign(fetch, { posted });
}

function makeDeps(fetched: ReturnType<typeof makeFetch>) {
  const connector = new LeclercConnector({
    fetch: fetched,
    session: { host: HOST, storeId: STORE, userAgent: 'UA' },
    sleep: () => Promise.resolve(),
  });
  const gate = new InMemoryPermissionGate();
  const logger = new McpLogger();
  const history = new SessionHistory();
  return { connector, gate, logger, history };
}

test('e2e : plan → recherche → validation → ajout panier', async () => {
  const fetched = makeFetch();
  const deps = makeDeps(fetched);
  const vm = new AssistantViewModel({ ...deps, ai: null });

  const proposal = await vm.planAndSearch({ text: 'lait demi-écrémé 1L, pâtes' });
  assert.equal(proposal.items.length, 2);
  // Chaque item propose un produit réel issu de la recherche.
  assert.ok(proposal.items[0].results.some((p) => p.id === '111'));
  assert.ok(proposal.items[1].results.some((p) => p.id === '222'));

  // Sélection : on choisit les productId RÉELS (jamais du modèle).
  const selections = [
    { itemIndex: 0, productId: '111', quantity: 2 },
    { itemIndex: 1, productId: '222', quantity: 1 },
  ];
  const { added } = await vm.confirmAndAdd(selections);
  assert.deepEqual(added.sort(), ['111', '222']);
  assert.ok(fetched.posted.length >= 2);
  const postedPayloads = fetched.posted.map((p) =>
    JSON.parse(decodeURIComponent(p.body.slice(2))) as { iIdProduit: string },
  );
  assert.ok(postedPayloads.some((p) => p.iIdProduit === '111'));

  // Historique enregistre l'ajout confirmé.
  assert.ok(deps.history.activeAdds().some((h) => h.productId === '111'));
});

test('e2e : refus d’un productId absent des résultats (id halluciné)', async () => {
  const fetched = makeFetch();
  const vm = new AssistantViewModel({ ...makeDeps(fetched), ai: null });
  await vm.planAndSearch({ text: 'lait demi-écrémé 1L' });
  await assert.rejects(
    () => vm.confirmAndAdd([{ itemIndex: 0, productId: 'HALLUCINATED-999' }]),
    /absent des résultats|halluciné/i,
  );
});

test('runner : mutation refusée sans ticket de confirmation', async () => {
  const fetched = makeFetch();
  const deps = makeDeps(fetched);
  const runner = new McpRunner(deps);
  const res = await runner.runTool('add_to_cart', { product_id: '111', quantity: 1 }, {});
  assert.equal(res.isError, true);
  assert.match(res.text, /confirmation/i);
  assert.equal(fetched.posted.length, 0);
});

test('runner : mutation acceptée avec ticket', async () => {
  const fetched = makeFetch();
  const deps = makeDeps(fetched);
  const runner = new McpRunner(deps);
  const args = { product_id: '111', quantity: 1 };
  const ticket = deps.gate.issue('add_to_cart', args);
  const res = await runner.runTool('add_to_cart', args, { nonce: ticket.nonce });
  assert.equal(res.isError, undefined);
  assert.ok(fetched.posted.length >= 1);
});

test('runner : rejeu du même ticket consommé => refus', async () => {
  const fetched = makeFetch();
  const deps = makeDeps(fetched);
  const runner = new McpRunner(deps);
  const args = { product_id: '111', quantity: 1 };
  const ticket = deps.gate.issue('add_to_cart', args);
  const r1 = await runner.runTool('add_to_cart', args, { nonce: ticket.nonce });
  assert.equal(r1.isError, undefined);
  const r2 = await runner.runTool('add_to_cart', args, { nonce: ticket.nonce });
  assert.equal(r2.isError, true); // consommé
});

test('intent checkout interdite bloquée à planAndSearch', async () => {
  const vm = new AssistantViewModel({ ...makeDeps(makeFetch()), ai: null });
  await assert.rejects(() => vm.planAndSearch({ text: 'payer ma commande' }), /interdite|paiement/i);
});
