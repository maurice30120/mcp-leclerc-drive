import { test, assert } from './helpers.ts';
import { LeclercConnector, type FetchLike } from '../src/features/leclerc/connector.ts';
import { InMemoryPermissionGate } from '../src/features/mcp/permissions.ts';
import { McpLogger } from '../src/features/mcp/logs.ts';
import { SessionHistory } from '../src/features/mcp/history.ts';
import { AssistantViewModel } from '../src/features/assistant/AssistantViewModel.ts';
import { STORE_PAGE_MARKER } from '../src/features/leclerc/api.ts';
import type { AIRuntime } from '../src/features/ai/runtime.ts';

const HOST = 'fd9-courses.leclercdrive.fr';
const STORE = '053701';

function searchHtml() {
  return `<html>"lstProduitsLight":{"sTotalAPayer":"0,00 €"}"lstProduits":[{"iIdProduit":111,"sLibelleLigne1":"Lait Bio 1L","sPrixUnitaire":"1,00 €","iQteDisponible":1,"sType":"Produit"}]${STORE_PAGE_MARKER}</html>`;
}

function makeFetch(): FetchLike {
  return async (input) => {
    if (input.includes('recherche.aspx')) {
      return { status: 200, ok: true, text: () => Promise.resolve(searchHtml()) };
    }
    throw new Error('unexpected url ' + input);
  };
}

test('AssistantViewModel : utilise l API IA quand le normaliseur déterministe ne produit pas de plan', async () => {
  let completed = false;
  const ai = {
    isReady: () => true,
    complete: async () => {
      completed = true;
      return '{"items":[{"query":"lait","quantity":1}]}';
    },
  } as unknown as AIRuntime;
  const connector = new LeclercConnector({
    fetch: makeFetch(),
    session: { host: HOST, storeId: STORE, userAgent: 'UA' },
    sleep: () => Promise.resolve(),
  });
  const vm = new AssistantViewModel({
    connector,
    gate: new InMemoryPermissionGate(),
    logger: new McpLogger(),
    history: new SessionHistory(),
    ai,
  });

  const proposal = await vm.planAndSearch({ text: '-' });

  assert.equal(completed, true);
  assert.equal(proposal.source, 'model');
  assert.equal(proposal.plan.items[0].query, 'lait');
  assert.equal(proposal.items[0].results[0].id, '111');
});
