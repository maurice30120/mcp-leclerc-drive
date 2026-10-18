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

function worker(byok?: Record<string, string>, status = 200, recipeText?: string) {
  let listener: (message: unknown, sender: unknown, reply: (value: any) => void) => void;
  const requests: { url: string; body: any }[] = [];
  const localMessages: unknown[] = [];
  const sessionStorage: Record<string, unknown> = {};
  const bridgeCalls: { command: string; args: Record<string, unknown> }[] = [];
  const openedWindows: number[] = [];
  const event = { addListener() {} };
  runInNewContext(bundle.outputFiles[0].text, {
    console: { info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, AbortController, URL,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return {
        ok: status === 200, status,
        json: async () => status === 200
          ? { choices: [{ message: { content: recipeText ?? '{"items":[{"query":"lait","quantity":1}]}' } }] }
          : { error: { message: "Invalid API key" } },
      };
    },
    chrome: {
      tabs: {
        onUpdated: event,
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId: number, { request }: any) => {
          bridgeCalls.push({ command: request.command, args: request.args });
          assert.equal(request.command, "search_products", "no mutation before approval");
          const name = String(request.args.query);
          return {
            type: "leclerc_result",
            response: {
              source: "mcp-leclerc-drive:bridge", requestId: request.requestId, ok: true,
              data: { products: [{ id: name, label: `${name} - 500g`, price: 2, available: true }] },
            },
          };
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
        local: { get: async () => ({ byok }) },
        session: {
          get: async () => sessionStorage,
          set: async (values: Record<string, unknown>) => { Object.assign(sessionStorage, values); },
        },
      },
      offscreen: { hasDocument: async () => true },
    },
  });
  return {
    requests, localMessages, bridgeCalls, openedWindows, sessionStorage,
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

test("recipe handoff: cassoulet for five generates ingredients and prepares catalogue quantities without mutations", async () => {
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
  assert.equal(state.phase, "awaiting_approval");
  assert.equal(state.provider, "mistral");
  assert.equal(state.pendingApproval.preview.servings, 5);
  assert.deepEqual(w.bridgeCalls.map((c) => c.args.query), ["haricots blancs secs", "saucisses de Toulouse"]);
  assert.deepEqual(Array.from(state.pendingApproval.preview.lines, (line: any) => line.quantity), [2, 2]);
  assert.equal(w.requests.length, 1);
  assert.ok(w.requests[0].body.messages[0].content.includes("UNE recette"));
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
