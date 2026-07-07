import { test, assert } from './helpers.ts';
import { LeclercConnector, type FetchLike } from '../src/features/leclerc/connector.ts';
import { STORE_PAGE_MARKER } from '../src/features/leclerc/api.ts';
import { InMemoryPermissionGate } from '../src/features/mcp/permissions.ts';
import { McpLogger } from '../src/features/mcp/logs.ts';
import { SessionHistory } from '../src/features/mcp/history.ts';
import { DriveChatViewModel } from '../src/features/assistant/DriveChatViewModel.ts';
import type { MistralChatRequest, MistralChatTurn } from '../src/features/ai/mistral-client.ts';

const HOST = 'fd9-courses.leclercdrive.fr';
const STORE = '053701';

function searchHtml() {
  return `<html>"lstProduitsLight":{"sTotalAPayer":"0,00 €"}"lstProduits":[{"iIdProduit":111,"sLibelleLigne1":"Lait Bio 1L","sPrixUnitaire":"1,00 €","iQteDisponible":1,"sType":"Produit"}]${STORE_PAGE_MARKER}</html>`;
}

function cartAfterAdd() {
  return JSON.stringify([
    { sIdUnique: 'Panier', objElement: { rTotalAPayer: 1, iQuantitePanier: 1 } },
    { sIdUnique: 'Produit111', objElement: { iIdProduit: 111, sLibelleLigne1: 'Lait Bio 1L', sType: 'Produit', iQuantitePanier: 1, nrPVUnitaireTTC: 1, rTotalAPayer: 1 } },
  ]);
}

function makeFetch(): FetchLike & { posted: { url: string; body: string }[] } {
  const posted: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (input.includes('recherche.aspx')) {
      return { status: 200, ok: true, text: () => Promise.resolve(searchHtml()) };
    }
    if (input.includes('panier.aspx')) {
      posted.push({ url: input, body: init?.body ?? '' });
      return { status: 200, ok: true, text: () => Promise.resolve(cartAfterAdd()) };
    }
    throw new Error('unexpected url ' + input);
  };
  return Object.assign(fetch, { posted });
}

function makeVm(responses: MistralChatTurn[]) {
  const requests: MistralChatRequest[] = [];
  const fetched = makeFetch();
  const connector = new LeclercConnector({
    fetch: fetched,
    session: { host: HOST, storeId: STORE, userAgent: 'UA' },
    sleep: () => Promise.resolve(),
  });
  const ai = {
    isReady: () => true,
    completeChat: async (request: MistralChatRequest) => {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error('réponse IA manquante');
      return next;
    },
  };
  const vm = new DriveChatViewModel({
    connector,
    gate: new InMemoryPermissionGate(),
    logger: new McpLogger(),
    history: new SessionHistory(),
    ai,
  });
  return { vm, requests, fetched };
}

test('DriveChatViewModel : appelle un outil de lecture puis affiche la réponse finale et le brut modèle', async () => {
  const { vm, requests } = makeVm([
    {
      text: '',
      raw: '{"choices":[{"finish_reason":"tool_calls"}]}',
      message: { content: null },
      toolCalls: [
        {
          id: 'call-search',
          type: 'function',
          function: { name: 'search_products', arguments: '{"query":"lait"}' },
        },
      ],
    },
    {
      text: 'J ai trouvé Lait Bio 1L à 1,00 €.',
      raw: '{"choices":[{"message":{"content":"final"}}]}',
      message: { content: 'J ai trouvé Lait Bio 1L à 1,00 €.' },
      toolCalls: [],
    },
  ]);

  const result = await vm.sendUserMessage('cherche du lait');

  assert.ok(requests[0].tools?.some((tool) => tool.function.name === 'search_products'));
  assert.equal(result.pending.length, 0);
  assert.equal(result.rawModel, '{"choices":[{"message":{"content":"final"}}]}');
  assert.ok(result.lines.some((line) => line.role === 'tool' && line.text.includes('Lait Bio 1L')));
  assert.equal(result.lines.at(-1)?.text, 'J ai trouvé Lait Bio 1L à 1,00 €.');
});

test('DriveChatViewModel : suspend une mutation modèle puis l exécute après confirmation', async () => {
  const { vm, fetched } = makeVm([
    {
      text: '',
      raw: '{"choices":[{"finish_reason":"tool_calls","step":"search"}]}',
      message: { content: null },
      toolCalls: [
        {
          id: 'call-search',
          type: 'function',
          function: { name: 'search_products', arguments: { query: 'lait' } },
        },
      ],
    },
    {
      text: '',
      raw: '{"choices":[{"finish_reason":"tool_calls","step":"add"}]}',
      message: { content: null },
      toolCalls: [
        {
          id: 'call-add',
          type: 'function',
          function: { name: 'add_to_cart', arguments: '{"product_id":"111","quantity":1}' },
        },
      ],
    },
    {
      text: 'Ajout confirmé.',
      raw: '{"choices":[{"message":{"content":"Ajout confirmé."}}]}',
      message: { content: 'Ajout confirmé.' },
      toolCalls: [],
    },
  ]);

  const first = await vm.sendUserMessage('ajoute du lait');
  assert.equal(first.pending.length, 1);
  assert.equal(fetched.posted.length, 0);

  const confirmed = await vm.confirmTool(first.pending[0].id);

  assert.equal(fetched.posted.length, 1);
  assert.equal(confirmed.pending.length, 0);
  assert.equal(confirmed.rawModel, '{"choices":[{"message":{"content":"Ajout confirmé."}}]}');
  assert.equal(confirmed.lines.at(-1)?.text, 'Ajout confirmé.');
});

test('DriveChatViewModel : refuse une mutation avec product_id jamais vu', async () => {
  const { vm, fetched } = makeVm([
    {
      text: '',
      raw: '{"choices":[{"finish_reason":"tool_calls","step":"bad-add"}]}',
      message: { content: null },
      toolCalls: [
        {
          id: 'call-add',
          type: 'function',
          function: { name: 'add_to_cart', arguments: '{"product_id":"999","quantity":1}' },
        },
      ],
    },
    {
      text: 'Je dois d abord rechercher le produit.',
      raw: '{"choices":[{"message":{"content":"search-first"}}]}',
      message: { content: 'Je dois d abord rechercher le produit.' },
      toolCalls: [],
    },
  ]);

  const result = await vm.sendUserMessage('ajoute un produit inconnu');

  assert.equal(result.pending.length, 0);
  assert.equal(fetched.posted.length, 0);
  assert.ok(result.lines.at(-1)?.text.includes('rechercher'));
});
