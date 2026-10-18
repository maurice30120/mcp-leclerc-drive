import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

// Exercise the bundled worker's real popup message boundary, including routing
// and storage, rather than testing the request builder in isolation.
const bundle = await build({
  entryPoints: [new URL("../extension/background.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});

function worker(byok?: Record<string, string>, status = 200, recipeText?: string, restore?: { local: Record<string, unknown>; catalogue: [string, any][]; quantities: [string, number][] }, selectionText?: string) {
  let listener: (message: unknown, sender: unknown, reply: (value: any) => void) => void;
  const requests: { url: string; body: any }[] = [];
  const localMessages: unknown[] = [];
  const sessionStorage: Record<string, unknown> = {};
  const localStorage: Record<string, unknown> = structuredClone({ ...(byok ? { byok } : {}), ...(restore?.local ?? {}) });
  const bridgeCalls: { command: string; args: Record<string, unknown> }[] = [];
  const openedWindows: number[] = [];
  const catalogue = new Map<string, any>(restore?.catalogue ?? []);
  const cartQuantities = new Map<string, number>(restore?.quantities ?? []);
  const currentCart = () => ({ items: [...cartQuantities].map(([id, quantity]) => ({ product: catalogue.get(id), quantity, lineTotal: quantity * catalogue.get(id).price })), itemCount: cartQuantities.size, total: [...cartQuantities].reduce((total, [id, quantity]) => total + catalogue.get(id).price * quantity, 0), storeId: "42" });
  const event = { addListener() {} };
  runInNewContext(bundle.outputFiles[0].text, {
    console: { info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, AbortController, URL, structuredClone, crypto: globalThis.crypto,
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push({ url, body });
      let content = recipeText ?? '{"items":[{"query":"lait","quantity":1}]}';
      if (recipeText && body.messages[0].content.includes("sélectionnes les produits")) {
        const input = JSON.parse(body.messages[1].content);
        content = JSON.stringify({ decisions: input.ingredients.map((entry: any) => {
          const product = entry.products[0];
          return product ? { ingredientIndex: entry.ingredientIndex, action: "select", productId: product.id, labelEvidence: product.label, compatibility: "exact", reason: "Produit adapté et conditionnement vérifié." }
            : { ingredientIndex: entry.ingredientIndex, action: "clarify", candidateIds: [], reason: "Aucun produit." };
        }) });
      }
      if (selectionText !== undefined && body.messages[0].content.includes("sélectionnes les produits")) content = selectionText;
      return { ok: status === 200, status,
        json: async () => status === 200 ? { choices: [{ message: { content } }] } : { error: { message: "Invalid API key" } },
      };
    },
    chrome: {
      tabs: {
        onUpdated: event,
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId: number, { request }: any) => {
          bridgeCalls.push({ command: request.command, args: request.args });
          let data;
          if (request.command === "search_products") {
            const name = String(request.args.query);
            const product = { id: name, label: `${name} - 500g`, price: 2, available: true };
            catalogue.set(name, product);
            data = { products: [product] };
          } else if (request.command === "list_habitual_products") data = { products: [] };
          else if (request.command === "get_cart") data = { cart: currentCart() };
          else if (request.command === "update_quantity") {
            const intent = (localStorage.preparedCartProgress as any)?.intent;
            assert.ok(intent, "durable intent is saved before the mutation");
            assert.equal(intent.productId, request.args.product_id);
            assert.equal(intent.target, request.args.quantity);
            if (Number(request.args.quantity) === 0) cartQuantities.delete(String(request.args.product_id));
            else cartQuantities.set(String(request.args.product_id), Number(request.args.quantity));
            data = { cart: currentCart() };
          } else throw new Error(`Commande inattendue : ${request.command}`);
          return { type: "leclerc_result", response: { source: "mcp-leclerc-drive:bridge", requestId: request.requestId, ok: true, data } };
        },
      },
      sidePanel: { open: async ({ windowId }: { windowId: number }) => { openedWindows.push(windowId); } },
      runtime: {
        onStartup: event, onInstalled: event, onConnect: event,
        onMessage: { addListener(fn: typeof listener) { listener = fn; } },
        sendMessage: async (message: unknown) => {
          localMessages.push(message);
          return { type: "offscreen_status_result", status: "ready" };
        },
      },
      storage: {
        local: { get: async () => localStorage, set: async (values: Record<string, unknown>) => { Object.assign(localStorage, structuredClone(values)); }, remove: async (key: string) => { delete localStorage[key]; } },
        session: {
          get: async () => sessionStorage,
          set: async (values: Record<string, unknown>) => { Object.assign(sessionStorage, structuredClone(values)); },
          remove: async (key: string) => { delete sessionStorage[key]; },
        },
      },
      offscreen: { hasDocument: async () => true },
    },
  });
  return {
    requests, localMessages, bridgeCalls, openedWindows, sessionStorage, localStorage,
    snapshot: () => ({ local: structuredClone(localStorage), catalogue: [...catalogue], quantities: [...cartQuantities] }),
    send: (message: unknown): Promise<any> => new Promise((resolve) => listener(message, {}, resolve)),
  };
}

for (const text of ["fait moi un casoulet", "lait 1L", "une recette de carbonara"]) {
  test(`worker: explicit Mistral selection routes to its API: ${text}`, async () => {
    const w = worker({ provider: "vibe", vibeKey: "test-key" });
    const reply = await w.send({ type: "orchestrate", text, traceId: "test" });
    assert.equal(w.requests.length, 1, "selected Mistral must not be bypassed by normalization");
    assert.equal(w.requests[0].url, "https://api.mistral.ai/v1/chat/completions");
    assert.equal(w.requests[0].body.model, "mistral-small-latest");
    assert.equal(reply.ok, true);
    assert.equal(reply.debug.source, "byok");
    assert.equal(w.localMessages.length, 0, "no local runtime for remote inference");
  });
}

test("worker: missing Mistral key is reported even for a simple list", async () => {
  const w = worker({ provider: "vibe" });
  const reply = await w.send({ type: "orchestrate", text: "lait 1L" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /clé api manquante/i);
  assert.equal(w.requests.length, 0);
  assert.equal(w.localMessages.length, 0);
});

test("worker: Mistral API errors never fall back to the local model", async () => {
  const w = worker({ provider: "vibe", vibeKey: "test-key" }, 401);
  const reply = await w.send({ type: "orchestrate", text: "lait 1L" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Invalid API key/);
  assert.equal(w.requests.length, 1);
  assert.equal(w.localMessages.length, 0);
});

test("worker: local selection keeps deterministic list normalization", async () => {
  const w = worker();
  const reply = await w.send({ type: "orchestrate", text: "lait 1L" });
  assert.equal(reply.ok, true);
  assert.equal(reply.debug.source, "deterministic");
  assert.equal(w.requests.length, 0);
});

test("recipe handoff: cassoulet for five progressively fills the cart and permits removal after addition", async () => {
  const recipe = {
    title: "Cassoulet", servings: 5,
    ingredients: [
      { name: "haricots blancs secs", quantity: 750, unit: "g" },
      { name: "saucisses de Toulouse", quantity: 1000, unit: "g" },
    ],
    steps: ["Faire tremper les haricots puis les cuire avec les saucisses."],
  };
  const w = worker(undefined, 200, JSON.stringify(recipe));
  const reply = await w.send({
    type: "prepare_recipe", text: "je veux faire un casoulet 5 personne",
    windowId: 42, providerId: "vibe", apiKey: "secret-test-only", model: "mistral-small-latest",
  });
  assert.equal(reply.ok, true);
  // The production flow runs asynchronously after acknowledging the handoff.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(w.openedWindows, [42]);
  const states = w.localMessages.filter((m: any) => m.event?.type === "state") as any[];
  const state = states.at(-1)?.event.state;
  assert.equal(state.phase, "reviewing");
  assert.equal(state.provider, "mistral");
  assert.equal(state.cartProgress.recipe.servings, 5);
  assert.equal(state.pendingApproval, undefined);
  assert.deepEqual(w.bridgeCalls.filter((c) => c.command === "search_products").map((c) => c.args.query), ["haricots blancs secs", "saucisses de Toulouse"]);
  assert.deepEqual(Array.from(state.cartProgress.entries, (entry: any) => entry.added), [2, 2]);
  assert.equal(w.requests.length, 2);
  assert.equal(w.bridgeCalls.filter((c) => c.command === "update_quantity").length, 2);
  const stale = await w.send({ channel: "mcp-leclerc-drive:sidepanel", request: { type: "remove_prepared", flowId: "old-flow", ingredientIndex: 0 } });
  assert.equal(stale.ok, false);
  assert.equal(w.bridgeCalls.filter((c) => c.command === "update_quantity").length, 2);
  const removed = await w.send({ channel: "mcp-leclerc-drive:sidepanel", request: { type: "remove_prepared", flowId: state.cartProgress.flowId, ingredientIndex: 0 } });
  assert.equal(removed.ok, true);
  assert.equal(removed.state.cartProgress.entries[0].removed, 2);
  const done = await w.send({ channel: "mcp-leclerc-drive:sidepanel", request: { type: "finish_review", flowId: state.cartProgress.flowId } });
  assert.equal(done.ok, true);
  assert.equal(done.state.phase, "done");
  assert.ok(w.requests[0].body.messages[0].content.includes("UNE recette"));
  assert.ok(!JSON.stringify(w.localStorage.preparedCartProgress).includes("secret-test-only"));
  assert.ok(!JSON.stringify(states).includes("secret-test-only"));
  assert.ok(!JSON.stringify(reply).includes("secret-test-only"));
});

test("recipe handoff: missing key refuses generation instead of choosing another provider", async () => {
  const w = worker();
  const reply = await w.send({
    type: "prepare_recipe", text: "un cassoulet pour 5 personnes",
    windowId: 42, providerId: "vibe", apiKey: "", model: "",
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /clé api manquante/i);
  assert.equal(w.requests.length, 0);
  assert.equal(w.bridgeCalls.length, 0);
});

test("browser restart: restore the saved Mistral key and contribution journal, reconcile without duplicates", async () => {
  const recipe = JSON.stringify({ title: "Haricots", servings: 4,
    ingredients: [{ name: "haricots blancs secs", quantity: 750, unit: "g" }], steps: ["Faire tremper puis cuire."] });
  const id = "haricots blancs secs";
  const first = worker(undefined, 200, recipe, { local: {}, quantities: [[id, 5]], catalogue: [[id, { id, label: `${id} - 500g`, price: 2, available: true }]] });
  await first.send({ type: "prepare_recipe", text: "Des haricots pour 4", windowId: 1, providerId: "vibe", apiKey: "saved-mistral-key", model: "mistral-small-latest" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const persisted = first.snapshot();
  assert.equal((persisted.local.preparedCartProgress as any).entries[0].added, 2);
  assert.equal(persisted.quantities[0][1], 7);
  assert.ok(!JSON.stringify(persisted.local.preparedCartProgress).includes("saved-mistral-key"));

  // Simulate a worker/browser stopping after the server write but before the
  // confirmation checkpoint. Session history is gone; the saved Mistral configuration is restored separately.
  const journal = persisted.local.preparedCartProgress as any;
  journal.entries[0].added = 0;
  journal.entries[0].status = "verification_pending";
  journal.intent = { ingredientIndex: 0, productId: id, before: 5, target: 7, delta: 2, operation: "add" };
  const restarted = worker(undefined, 200, undefined, persisted);
  const message = (request: unknown) => ({ channel: "mcp-leclerc-drive:sidepanel", request });
  const state = await restarted.send(message({ type: "get_state" }));
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.state.cartProgress.intent.target, 7);
  assert.equal(state.state.mistralKeySet, true);
  assert.equal(state.state.provider, "mistral");
  assert.equal(restarted.sessionStorage.sidepanelMistralApiKey, "saved-mistral-key");
  await restarted.send(message({ type: "resume" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(restarted.requests.length, 0, "cart-only recovery does not call Mistral even with a restored key");
  assert.equal(restarted.bridgeCalls.filter((call) => call.command === "update_quantity").length, 0);
  const resumed = await restarted.send(message({ type: "get_state" }));
  assert.equal(resumed.state.cartProgress.entries[0].added, 2);
  const removed = await restarted.send(message({ type: "remove_prepared", flowId: resumed.state.cartProgress.flowId, ingredientIndex: 0 }));
  assert.equal(removed.ok, true);
  assert.equal(restarted.snapshot().quantities[0][1], 5, "preexisting five packages are preserved");
});

test("a corrupt durable journal is reported without replacing it or mutating the cart", async () => {
  const w = worker(undefined, 200, undefined, { local: { preparedCartProgress: { formatVersion: 99 } }, catalogue: [], quantities: [] });
  const result = await w.send({ channel: "mcp-leclerc-drive:sidepanel", request: { type: "get_state" } });
  assert.equal(result.ok, false);
  assert.match(result.error, /journal.*invalide/i);
  assert.equal(w.bridgeCalls.length, 0);
  assert.deepEqual(w.localStorage.preparedCartProgress, { formatVersion: 99 });
});

test("persistent Mistral settings: restore the chosen model and delete every saved key copy", async () => {
  const key = "fake-persistent-key";
  const w = worker(undefined, 200, undefined, { local: {
    sidepanelMistralApiKey: key, sidepanelMistralModel: "my-chosen-model", sidepanelProvider: "mistral",
    byok: { provider: "vibe", vibeKey: key },
  }, catalogue: [], quantities: [] });
  const message = (request: unknown) => ({ channel: "mcp-leclerc-drive:sidepanel", request });
  const restored = await w.send(message({ type: "get_state" }));
  assert.equal(restored.state.mistralKeySet, true);
  assert.equal(restored.state.provider, "mistral");
  assert.equal(w.sessionStorage.sidepanelMistralModel, "my-chosen-model");
  assert.equal(w.requests.length, 0, "restoring settings does not call Mistral");
  assert.ok(!JSON.stringify(restored).includes(key));
  await w.send(message({ type: "set_mistral_key", apiKey: "replacement-key" }));
  assert.equal(w.localStorage.sidepanelMistralApiKey, "replacement-key");
  assert.equal(w.localStorage.sidepanelMistralModel, "my-chosen-model");
  const deleted = await w.send(message({ type: "delete_mistral_key" }));
  assert.equal(deleted.state.mistralKeySet, false);
  assert.equal(w.localStorage.sidepanelMistralApiKey, undefined);
  assert.equal(w.sessionStorage.sidepanelMistralApiKey, undefined);
  assert.equal((w.localStorage.byok as any).vibeKey, undefined);
  const restarted = worker(undefined, 200, undefined, w.snapshot());
  const again = await restarted.send(message({ type: "get_state" }));
  assert.equal(again.state.mistralKeySet, false, "a deleted key cannot reappear through migration");
});

test("selection failure: malformed JSON stays resumable, legacy generic failures recover without new searches", async () => {
  const recipeText = JSON.stringify({ title: "Haricots", servings: 4, ingredients: [{ name: "haricots blancs secs", quantity: 750, unit: "g" }], steps: ["Faire tremper puis cuire."] });
  const w = worker(undefined, 200, recipeText, undefined, "```json\n{broken}");
  await w.send({ type: "prepare_recipe", text: "haricots pour 4", windowId: 42, providerId: "vibe", apiKey: "test-only", model: "mistral-small-latest" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = (request: unknown) => ({ channel: "mcp-leclerc-drive:sidepanel", request });
  const failed = (await w.send(request({ type: "get_state" }))).state;
  assert.equal(failed.pendingReview, undefined);
  assert.equal(failed.cartProgress.entries[0].status, "failed");
  assert.equal(w.bridgeCalls.filter((call) => call.command === "update_quantity").length, 0);
  assert.deepEqual(w.requests[1].body.response_format, { type: "json_object" });
  const snapshot = w.snapshot();
  // Snapshot produced by the version seen in the user's screenshot.
  const progress = snapshot.local.preparedCartProgress as any;
  progress.selection.evaluationsComplete = true;
  delete progress.selection.evaluationError;
  progress.selection.problems = { 0: "Évaluation du modèle indisponible ou invalide ; choix à vérifier." };
  progress.entries[0].status = "choice_needed";
  const restarted = worker(undefined, 200, recipeText, snapshot);
  await restarted.send(request({ type: "resume" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const resumed = (await restarted.send(request({ type: "get_state" }))).state;
  assert.equal(resumed.cartProgress.entries[0].added, 2);
  assert.equal(restarted.requests.length, 1, "only selection, no recipe regeneration");
  assert.equal(restarted.bridgeCalls.filter((call) => call.command === "search_products").length, 0);
  assert.equal(restarted.bridgeCalls.filter((call) => call.command === "update_quantity").length, 1);
});
