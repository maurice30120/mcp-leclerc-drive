/**
 * mcp-leclerc-drive — WebMCP tool bridge injected into the Leclerc Drive tab.
 *
 * Runs in the page's MAIN world (via chrome.scripting.executeScript) so it has
 * access to the live page's fetch context: cookies, datadome, fingerprint are
 * all authentic, and the browser refreshes `datadome` on its own when needed.
 *
 * It registers the 9 Leclerc capability tools — projected from the
 * @leclerc/contracts registry (issue #50) — plus the 7 recipe tools on
 * `document.modelContext` (installed by @mcp-b/global), then loads the
 * webmcp-local-relay `embed.js` so those tools
 * are forwarded to the local relay → opencode (or any stdio MCP client).
 *
 * Idempotent: if already injected (guard `__mcpLeclercDriveInjected`), no-op.
 *
 * Anti-DataDome: a small in-page throttle serializes calls with spacing +
 * jitter, plus a couple of retries with backoff on 403/429. Because every
 * fetch is the page's own fetch, DataDome sees a real browser fingerprint,
 * so strikes are far rarer than the legacy node-fetch path.
 */

import { initializeWebModelContext } from "@mcp-b/global";
import type { WebMCP } from "webmcp-types";

import {
  autocompleteUrl,
  coordinatesUrl,
  nearbyUrl,
  hostOf,
  isLeclercHost,
  isRetryableStatus,
  searchUrl as buildSearchUrl,
  cartUrl as buildCartUrl,
  cartMutationBody,
  cartFromHtml,
  cartFromEvents,
  productsFromHtml,
  assertStorePage,
  formatProduct,
  formatCart,
  decodeEntities,
  ACTION_ADD,
  ACTION_SUB,
  NO_MATCH_QUERY,
  type AutocompleteResponse,
  type CoordinatesResponse,
  type NearbyResponse,
} from "../src/leclerc/api.js";
import type { Product, Cart } from "../src/types.js";
import {
  isLeclercRequest,
  isLeclercCommand,
  type LeclercRequest,
  type LeclercResponse,
} from "../src/orchestrator/messages.js";
import {
  validateCommand,
  type DispatchCall,
} from "../src/orchestrator/dispatcher.js";
import { parseRecipe } from "../src/recipes/contract.js";
import { loadCatalogue } from "../src/recipes/catalogue.js";
import {
  createRecipeTools,
  withNotices,
  type ToolTextResult,
} from "../src/recipes/tools.js";
import { calculateIngredients } from "../src/recipes/calc.js";
import { searchRecipes } from "../src/recipes/search.js";
import type { RecipeRuntime } from "../src/recipes/service.js";
import { RequestCorrelator } from "../src/orchestrator/correlator.js";
import {
  isRecipeStorageResponse,
  RECIPE_STORAGE_REQUEST_SOURCE,
  type RecipeStorageCommand,
  type RecipeStorageRequest,
  type RecipeStorageResponse,
} from "../src/orchestrator/messages.js";

import { CAPABILITIES } from "@leclerc/contracts";
import { projectWebmcpTool } from "../src/webmcp/projection.js";

// ---- The 9 capability executors (descriptors are projected) ---------------
//
// Since issue #50 the tool descriptors (name, title, description,
// inputSchema, annotations) are projected from the @leclerc/contracts
// registry by src/webmcp/projection.ts; only the execute() plumbing below
// stays hand-written: runDispatch, page fetches, asText/asError,
// scrubUntrusted. NOTE: this map must be initialized BEFORE the injection
// guard below — main() runs registerTools() synchronously during module
// evaluation — while the functions it calls are hoisted declarations.

const capabilityExecutors: Record<string, (args: unknown) => Promise<ToolTextResult>> = {
  find_stores: async (args) => {
    try {
      const query = String((args as { query: string }).query);
      const auto = await getJsonRaw<AutocompleteResponse>(autocompleteUrl(query));
      const place = auto.postalCodes?.[0];
      if (!place) return asText(`Aucun drive trouvé pour « ${query} ».`);

      const coords = await getJsonRaw<CoordinatesResponse>(coordinatesUrl(place.id));
      const lat = coords.latitude ?? coords.coordinates?.latitude;
      const lng = coords.longitude ?? coords.coordinates?.longitude;
      if (lat === undefined || lng === undefined) {
        return asText(`Aucun drive trouvé pour « ${query} ».`);
      }
      const cp = place.postalCode ?? query;
      const near = await getJsonRaw<NearbyResponse>(nearbyUrl(lat, lng, cp));

      const found: ActiveStore[] = [];
      for (const p of near.points ?? []) {
        const host = hostOf(p.urlSiteCourse || p.urlBase);
        if (!host || !isLeclercHost(host) || p.noPL === undefined) continue;
        found.push({
          storeId: String(p.noPL),
          noPR: String(p.noPR ?? p.noPL),
          host,
          name: scrubUntrusted(p.name ?? `Magasin ${p.noPL}`),
          serviceType: p.serviceType || p.type || "drive",
        });
      }
      // Cache for set_store.
      (window as unknown as { __leclercFoundStores?: ActiveStore[] }).__leclercFoundStores = found;

      if (found.length === 0) return asText(`Aucun drive trouvé pour « ${query} ».`);
      const lines = found.map(
        (s) =>
          `• ${s.name} — ${s.serviceType ?? "drive"} (id=${s.storeId} @ ${s.host})`,
      );
      return asText(
        `Drives autour de « ${query} » :\n${lines.join("\n")}\n\n` +
          `Pour en choisir un : set_store avec son id.`,
      );
    } catch (err) {
      return asError(err);
    }
  },

  set_store: async (args) => {
    try {
      const a = args as { store_id: string; host?: string };
      const cache = (window as unknown as { __leclercFoundStores?: ActiveStore[] })
        .__leclercFoundStores;
      const found = cache?.find((s) => s.storeId === a.store_id);
      const host = found?.host ?? a.host;
      if (!host) {
        return asError(
          new Error(
            `Magasin ${a.store_id} inconnu. Lance d'abord find_stores, puis set_store avec un ` +
              `id de la liste (ou fournis le paramètre host).`,
          ),
        );
      }
      if (!isLeclercHost(host)) {
        return asError(new Error(`Host refusé (non-Leclerc) : ${host}`));
      }
      const selection: ActiveStore = {
        storeId: a.store_id,
        noPR: found?.noPR ?? a.store_id,
        host,
        name: found?.name,
        serviceType: found?.serviceType,
      };
      setStore(selection);
      return asText(
        `Magasin actif : ${selection.name ?? selection.storeId} (id=${selection.storeId} @ ` +
          `${selection.host}). Mémorisé. Ouvre ce drive dans Chrome pour aligner la session.`,
      );
    } catch (err) {
      return asError(err);
    }
  },

  get_store: async () => {
    try {
      const v = validateCommand("get_store", {});
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "get_store") return asError(new Error("Réponse inattendue"));
      const s = result.store;
      return asText(`Magasin actif : ${s.name ?? s.storeId} (id=${s.storeId} @ ${s.host}).`);
    } catch (err) {
      return asError(err);
    }
  },

  search_product: async (args) => {
    try {
      const query = String((args as { query: string }).query);
      const v = validateCommand("search_products", { query });
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "search_products") return asError(new Error("Réponse inattendue"));
      if (result.products.length === 0) return asText(`Aucun produit trouvé pour « ${query} ».`);
      const lines = result.products.map((p) => formatProduct(p));
      return asText(lines.join("\n"));
    } catch (err) {
      return asError(err);
    }
  },

  list_habitual_products: async () => {
    try {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      // Dérive le préfixe magasin depuis l'URL courante de l'onglet :
      //   /magasin-018201-018201-Montauban---Sapiac/... → produits-habituels.aspx
      const m = window.location.pathname.match(/^(\/magasin-\d+-\d+-[^/]+)\//i);
      if (!m) {
        throw new Error(
          "L'onglet courant n'est pas sur une page magasin Leclerc. Ouvre ton drive " +
            "(ex. https://fd11-courses.leclercdrive.fr/magasin-018201-018201-...) puis recharge.",
        );
      }
      const url = `https://${s.host}${m[1]}/produits-habituels.aspx`;
      const html = await getHtml(url);
      const products = productsFromHtml(html);
      if (products.length === 0) return asText("Aucun produit habituel trouvé.");
      const lines = products.map((p) => {
        const safe = { ...p, label: scrubUntrusted(p.label) };
        return formatProduct(safe);
      });
      return asText(lines.join("\n"));
    } catch (err) {
      return asError(err);
    }
  },

  get_cart: async () => {
    try {
      const v = validateCommand("get_cart", {});
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "get_cart") return asError(new Error("Réponse inattendue"));
      return asText(formatCart(result.cart));
    } catch (err) {
      return asError(err);
    }
  },

  add_to_cart: async (args) => {
    try {
      const a = args as { product_id: string; quantity?: number };
      const qty = a.quantity ?? 1;
      const v = validateCommand("add_to_cart", { product_id: a.product_id, quantity: qty });
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "cart_mutation") return asError(new Error("Réponse inattendue"));
      return asText(`Ajouté.\n\n${formatCart(result.cart)}`);
    } catch (err) {
      return asError(err);
    }
  },

  update_quantity: async (args) => {
    try {
      const a = args as { product_id: string; quantity: number };
      const v = validateCommand("update_quantity", { product_id: a.product_id, quantity: a.quantity });
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "cart_mutation") return asError(new Error("Réponse inattendue"));
      return asText(`Quantité mise à jour.\n\n${formatCart(result.cart)}`);
    } catch (err) {
      return asError(err);
    }
  },

  remove_from_cart: async (args) => {
    try {
      const a = args as { product_id: string };
      const v = validateCommand("remove_from_cart", { product_id: a.product_id });
      if (!v.ok) return asError(new Error(v.error));
      const result = await runDispatch(v.call);
      if (result.kind !== "cart_mutation") return asError(new Error("Réponse inattendue"));
      return asText(`Retiré.\n\n${formatCart(result.cart)}`);
    } catch (err) {
      return asError(err);
    }
  },
};

// ---- Protection: a single injection per tab -------------------------------

declare global {
  interface Window {
    __mcpLeclercDriveInjected?: boolean;
    __mcpLeclercDriveReady?: Promise<void>;
  }
}

if (window.__mcpLeclercDriveInjected !== true) {
  window.__mcpLeclercDriveInjected = true;
  window.__mcpLeclercDriveReady = main();
}

// ---- Active store (persisted in localStorage, scoped to the Leclerc host) --

interface ActiveStore {
  storeId: string;
  noPR: string;
  host: string;
  name?: string;
  /** Service kind from the finder response, e.g. "drive"/"relais"/"livraison". */
  serviceType?: string;
}

const STORE_KEY = "mcp-leclerc-drive:active-store";

function loadStore(): ActiveStore {
  const current = currentStoreFromUrl();
  const saved = readSavedStore();
  // Prefer the tab's own host: the user must be on the drive they log into.
  if (current) {
    if (saved && saved.storeId === current.storeId && saved.host === current.host) {
      return saved;
    }
    return current;
  }
  if (saved) return saved;
  throw new Error(
    "Aucun magasin Leclerc Drive détecté. Ouvre dans Chrome l'URL de ton drive " +
      "(ex. https://fd9-courses.leclercdrive.fr/magasin-053701-053701-...) " +
      "puis recharge l'onglet.",
  );
}

function readSavedStore(): ActiveStore | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<ActiveStore>;
    if (
      o &&
      typeof o.storeId === "string" &&
      typeof o.host === "string" &&
      isLeclercHost(o.host)
    ) {
      return {
        storeId: o.storeId,
        noPR: typeof o.noPR === "string" ? o.noPR : o.storeId,
        host: o.host,
        name: typeof o.name === "string" ? o.name : undefined,
        serviceType: typeof o.serviceType === "string" ? o.serviceType : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveStore(s: ActiveStore): void {
  // SECURITY: refuse to persist any host that isn't a Leclerc Drive backend.
  if (!isLeclercHost(s.host)) {
    throw new Error(`Host refusé (non-Leclerc) : ${s.host}`);
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

/**
 * Derive the active store from the tab's own URL when on a drive page:
 *   https://fd9-courses.leclercdrive.fr/magasin-053701-053701-.../...
 *                                          \______/ \______/
 *                                            storeId   noPR
 */
function currentStoreFromUrl(): ActiveStore | null {
  if (!isLeclercHost(location.host)) return null;
  const m = location.pathname.match(/magasin-(\d+)-(\d+)/);
  if (!m) return null;
  return { storeId: m[1], noPR: m[2], host: location.host };
}

function setStore(selection: ActiveStore): void {
  saveStore(selection);
}

// ---- Throttle: serialize + space calls to stay polite with DataDome --------

const MIN_INTERVAL_MS = 600;
const JITTER_MS = 250;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1200;

let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function jittered(): number {
  return Math.floor(Math.random() * (JITTER_MS + 1));
}

function backoff(attempt: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempt - 1) + jittered();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Serialize `fn` and space it out; retry on 403/429. */
function throttled<T>(fn: () => Promise<Response>): Promise<Response> {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_INTERVAL_MS + jittered() - Date.now();
    if (wait > 0) await delay(wait);
    try {
      return await retry(fn);
    } finally {
      lastAt = Date.now();
    }
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function retry(fn: () => Promise<Response>): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await delay(backoff(attempt));
    const res = await fn();
    if (!isRetryableStatus(res.status)) return res;
    last = res;
  }
  throw new Error(
    "Bloqué par Leclerc Drive (DataDome, HTTP " +
      (last?.status ?? 0) +
      "). Recharge l'onglet Leclerc Drive dans Chrome pour rafraîchir la session, puis réessaye.",
  );
}

// ---- Page-context fetch helpers -------------------------------------------

async function getHtml(url: string): Promise<string> {
  const res = await throttled(() =>
    fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
  const html = await res.text();
  assertStorePage(html);
  return html;
}

async function postJson(url: string, body: string): Promise<string> {
  const res = await throttled(() =>
    fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
      body,
      redirect: "follow",
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
  return res.text();
}

async function getJsonRaw<T>(url: string): Promise<T> {
  const res = await throttled(() =>
    fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      redirect: "follow",
    }),
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);
  return (await res.json()) as T;
}

// ---- Tool response helpers -------------------------------------------------

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function asText(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function asError(err: unknown): ToolTextResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

/**
 * mcp-b defines `untrustedContentHint` to flag tools whose output may include
 * attacker-controlled content (here: product labels from Leclerc's catalogue).
 * We additionally strip a few sequences that could break out of an LLM system
 * prompt / mimic tool-result boundaries.
 */
function scrubUntrusted(s: string): string {
  return decodeEntities(s)
    .replace(/<\/?(system|assistant|im_start|im_end|tool)[^>]*>/gi, "")
    .replace(/\[\/?(system|tool|assistant)\]/gi, "");
}

// ---- WebMCP tool descriptor type ------------------------------------------

type LeclercToolDescriptor = Omit<WebMCP.ModelContextTool, "annotations"> & {
  annotations?: WebMCP.ToolAnnotations & {
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

// ---- Recipe capability: storage bridge (MAIN → relay → background) --------

// The recipe tools run in this MAIN world and have no chrome.* access: their
// storage calls (captures, personal library, digest) are correlated
// postMessage requests answered by the background service worker through the
// isolated-world relay.

const storageCorrelator = new RequestCorrelator<RecipeStorageResponse>({
  defaultTimeoutMs: 10000,
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isRecipeStorageResponse(event.data)) return;
  storageCorrelator.resolve(event.data.requestId, event.data);
});

let storageRequestId = 0;

function callRecipeStorage(
  command: RecipeStorageCommand,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const request: RecipeStorageRequest = {
    source: RECIPE_STORAGE_REQUEST_SOURCE,
    requestId: `rs_${++storageRequestId}`,
    command,
    args,
  };
  const pending = storageCorrelator.register(request.requestId, 10000);
  window.postMessage(request, location.origin);
  return pending.then((response) => {
    if (!response.ok) throw new Error(response.error);
    return response.data;
  });
}

const recipeRuntime: RecipeRuntime = {
  async listCaptures() {
    return (await callRecipeStorage("list_captures")) as Awaited<ReturnType<RecipeRuntime["listCaptures"]>>;
  },
  async getCapture(id) {
    return (await callRecipeStorage("get_capture", { id })) as Awaited<ReturnType<RecipeRuntime["getCapture"]>>;
  },
  async saveRecipe(raw, captureId) {
    return (await callRecipeStorage("save_recipe", { recipe: raw, captureId })) as Awaited<
      ReturnType<RecipeRuntime["saveRecipe"]>
    >;
  },
  async abandonCapture(id) {
    return (await callRecipeStorage("abandon_capture", { id })) as Awaited<
      ReturnType<RecipeRuntime["abandonCapture"]>
    >;
  },
  async getPersonalRecipe(id) {
    return (await callRecipeStorage("get_personal_recipe", { id })) as Awaited<
      ReturnType<RecipeRuntime["getPersonalRecipe"]>
    >;
  },
  async personalRecipes() {
    return (await callRecipeStorage("personal_recipes")) as Awaited<
      ReturnType<RecipeRuntime["personalRecipes"]>
    >;
  },
  async claimNewRecipes() {
    return (await callRecipeStorage("claim_new_recipes")) as Awaited<
      ReturnType<RecipeRuntime["claimNewRecipes"]>
    >;
  },
};

/**
 * Append the bounded recipe notices (pending captures + digest of new
 * personal recipes) to every successful tool response. Best-effort: if the
 * storage bridge is unavailable, the underlying result is returned as-is.
 */
async function attachRecipeNotices(result: ToolTextResult): Promise<ToolTextResult> {
  try {
    return await withNotices(result, recipeRuntime);
  } catch {
    return result;
  }
}
async function registerTools(): Promise<void> {
  const mc = document.modelContext;
  if (!mc) throw new Error("Le runtime WebMCP document.modelContext est indisponible.");

  const registrations: Promise<void>[] = [];
  const registerTool = (tool: LeclercToolDescriptor): void => {
    const wrapped = {
      ...tool,
      async execute(args: unknown) {
        const base = await tool.execute(args);
        return attachRecipeNotices(base);
      },
    };
    registrations.push(mc.registerTool(wrapped as WebMCP.ModelContextTool));
  };

  // Recipe capability: catalogue + personal library + captures + digest.
  // Same descriptor shape, same registration path (incl. notices wrapper).
  const catalogue = loadCatalogue(parseRecipe);
  for (const tool of createRecipeTools({
    getCatalogueRecipe: (id) => catalogue.byId.get(id),
    catalogueRecipes: () => catalogue.recipes,
    runtime: recipeRuntime,
    search: searchRecipes,
    calculate: calculateIngredients,
  })) {
    registerTool(tool as unknown as LeclercToolDescriptor);
  }

  // The 9 Leclerc capability tools, projected from the @leclerc/contracts
  // registry (issue #50): descriptors from src/webmcp/projection.ts,
  // execute plumbing from capabilityExecutors. The external surface is
  // unchanged (tool names, input field names, annotations).
  for (const contract of CAPABILITIES) {
    const projected = projectWebmcpTool(contract);
    const execute = capabilityExecutors[projected.name];
    if (!execute) {
      throw new Error(`Aucun adaptateur d'exécution pour la capacité ${projected.name}.`);
    }
    registerTool({ ...projected, execute });
  }

  await Promise.all(registrations);
}

// ---- Internal structured dispatcher --------------------------------------
//
// The single source of truth for the 6 core Leclerc actions. Both the public
// MCP tools (below) and the postMessage bridge (used by the popup orchestrator)
// call this, so there is no duplicated business logic between the CLI agent
// path and the local-model popup path.
//
// Read commands return plain data; mutation commands return the updated cart.
// Labels are scrubbed of prompt-injection sequences before leaving the bridge
// (see scrubUntrusted) — the orchestrator must still treat them as untrusted
// data, never as instructions.

export type DispatchResult =
  | { kind: "search_products"; products: Product[] }
  | { kind: "get_cart"; cart: Cart }
  | { kind: "get_store"; store: { storeId: string; noPR: string; host: string; name?: string; serviceType?: string } }
  | { kind: "cart_mutation"; cart: Cart };

async function runDispatch(call: DispatchCall): Promise<DispatchResult> {
  switch (call.command) {
    case "search_products": {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      const html = await getHtml(buildSearchUrl(s.host, s.storeId, s.noPR, call.query));
      const products = productsFromHtml(html).map((p) => ({
        ...p,
        label: scrubUntrusted(p.label),
      }));
      return { kind: "search_products", products };
    }
    case "get_cart": {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      const html = await getHtml(buildSearchUrl(s.host, s.storeId, s.noPR, NO_MATCH_QUERY));
      const cart = cartFromHtml(html, s.storeId);
      return { kind: "get_cart", cart };
    }
    case "get_store": {
      const s = loadStore();
      return {
        kind: "get_store",
        store: { storeId: s.storeId, noPR: s.noPR, host: s.host, name: s.name, serviceType: s.serviceType },
      };
    }
    case "add_to_cart": {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      const body = cartMutationBody(call.productId, call.quantity, ACTION_ADD, s.storeId);
      const raw = await postJson(buildCartUrl(s.host, s.storeId, s.noPR), body);
      const cart = cartFromEvents(JSON.parse(raw) as never[], s.storeId);
      return { kind: "cart_mutation", cart };
    }
    case "remove_from_cart": {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      const body = cartMutationBody(call.productId, 0, ACTION_SUB, s.storeId);
      const raw = await postJson(buildCartUrl(s.host, s.storeId, s.noPR), body);
      const cart = cartFromEvents(JSON.parse(raw) as never[], s.storeId);
      return { kind: "cart_mutation", cart };
    }
    case "update_quantity": {
      const s = loadStore();
      if (!isLeclercHost(s.host)) throw new Error("Host non-Leclerc : " + s.host);
      if (call.quantity === 0) {
        const body = cartMutationBody(call.productId, 0, ACTION_SUB, s.storeId);
        const raw = await postJson(buildCartUrl(s.host, s.storeId, s.noPR), body);
        return { kind: "cart_mutation", cart: cartFromEvents(JSON.parse(raw) as never[], s.storeId) };
      }
      const current = await currentQuantity(call.productId);
      const action = call.quantity >= current ? ACTION_ADD : ACTION_SUB;
      const body = cartMutationBody(call.productId, call.quantity, action, s.storeId);
      const raw = await postJson(buildCartUrl(s.host, s.storeId, s.noPR), body);
      return { kind: "cart_mutation", cart: cartFromEvents(JSON.parse(raw) as never[], s.storeId) };
    }
  }
}

// ---- postMessage bridge: orchestrator (popup) → live tab ------------------
//
// The isolated-world content relay posts LeclercRequest on window. We validate
// + dispatch and post back a typed LeclercResponse. Mutations are allowed here
// only because the popup gates them behind an explicit *Valider* click — the
// bridge itself never invents mutations, and refuses to run off a Leclerc tab.

function installBridgeListener(): void {
  // Defence in depth: the injector only runs on Leclerc tabs (background
  // filters by host), but a navigated/redirected page could change origin.
  if (!isLeclercHost(location.host)) return;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!isLeclercRequest(event.data)) return;
    void handleBridgeRequest(event.data);
  });
}

async function handleBridgeRequest(req: LeclercRequest): Promise<void> {
  let resp: LeclercResponse;
  try {
    if (!isLeclercCommand(req.command)) {
      resp = { source: "mcp-leclerc-drive:bridge", requestId: req.requestId, ok: false, error: `Commande inconnue : ${req.command}` };
    } else {
      const host = isLeclercHost(location.host) ? location.host : undefined;
      const v = validateCommand(req.command, req.args, host);
      if (!v.ok) {
        resp = { source: "mcp-leclerc-drive:bridge", requestId: req.requestId, ok: false, error: v.error };
      } else {
        const result = await runDispatch(v.call);
        resp = { source: "mcp-leclerc-drive:bridge", requestId: req.requestId, ok: true, data: result };
      }
    }
  } catch (err) {
    resp = {
      source: "mcp-leclerc-drive:bridge",
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  window.postMessage(resp, location.origin);
}

/** Quick inline current-quantity reader used by update_quantity. */
async function currentQuantity(productId: string): Promise<number> {
  const s = loadStore();
  const html = await getHtml(buildSearchUrl(s.host, s.storeId, s.noPR, NO_MATCH_QUERY));
  const cart = cartFromHtml(html, s.storeId);
  const line = cart.items.find((i) => i.product.id === String(productId));
  return line?.quantity ?? 0;
}

// ---- Boot ------------------------------------------------------------------

async function main(): Promise<void> {
  // Install the current document.modelContext runtime. autoInitialize wires
  // the Tab + Iframe transports the relay's embed iframe relies on.
  initializeWebModelContext({ autoInitialize: true });

  // The current WebMCP API registers tools asynchronously. The background
  // worker waits for this promise before injecting the relay embed.
  await registerTools();

  // 2b) Install the postMessage bridge so the popup orchestrator (local
  //     Transformers.js model) can drive the same dispatcher the MCP tools use.
  //     The isolated-world content relay posts typed LeclercRequest on window.
  installBridgeListener();

  // The background worker injects embed.js only after this promise resolves.

  console.info(
    "[mcp-leclerc-drive] WebMCP tools registered (16). Make sure @mcp-b/webmcp-local-relay " +
      "is running (opencode launches it via `npx @mcp-b/webmcp-local-relay`).",
  );
}

// The webmcp-local-relay embed script (`embed.js`) is injected alongside
// this script, in MAIN world, by the extension background worker (see
// extension/background.ts — list ordering: ["inject.js","embed.js"]). We must
// not inject it ourselves — MAIN-world scripts have no access to chrome.* APIs,
// so chrome.runtime.getURL is unavailable here. The background worker is the
// single entry point for that.
