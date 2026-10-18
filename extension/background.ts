/**
 * Extension background service worker.
 *
 * Three responsibilities:
 *   1. Inject the WebMCP tool bridge (inject.js + embed.js) into Leclerc Drive
 *      tabs so the existing 9 MCP tools keep working for opencode / Claude Code.
 *   2. Inject the isolated-world content relay (content-relay.js) so the popup
 *      can drive the same dispatcher via postMessage.
 *   3. Route messages between the popup, the offscreen model document and the
 *      content relay (Leclerc tab).
 *
 * MV3 service workers can be terminated by Chrome; every listener is
 * registered at module top-level so it is re-armed on every wake.
 */

import {
  isLeclercResponse,
  type LeclercRequest,
  type LeclercResponse,
  type LeclercRunMsg,
  type LeclercRunResultMsg,
  type ModelStatusRequestMsg,
  type ModelStatusMsg,
  type OffscreenOrchestrateMsg,
  type OffscreenOrchestrateResultMsg,
  type OffscreenStatusMsg,
  type OffscreenStatusResultMsg,
  type OrchestrateRequestMsg,
  type PopupToBackgroundMsg,
  type ReloadOffscreenResultMsg,
  type SetModelMsg,
} from "../src/orchestrator/messages.js";
import {
  DEFAULT_MODEL_ID,
  findModel,
  type ModelEntry,
} from "../src/orchestrator/models.js";
import {
  buildChatCompletionRequest,
  extractApiErrorMessage,
  extractAssistantText,
  resolveByokConfig,
  scrubApiKey,
  type ByokConfig,
} from "../src/orchestrator/byok.js";
import { buildMessages } from "../src/orchestrator/prompt.js";
import { parsePlan } from "../src/orchestrator/plan.js";
import { normalizeShoppingList } from "../src/orchestrator/shopping-list.js";
import { buildCaptureRecord } from "../src/recipes/capture.js";
import { extractStructuredRecipe } from "../src/recipes/structured.js";
import { parseRecipe } from "../src/recipes/contract.js";
import { createLibraryStore } from "../src/recipes/library.js";
import { createRecipeService } from "../src/recipes/service.js";
import {
  isRecipeStorageRequest,
  RECIPE_STORAGE_RESPONSE_SOURCE,
  type RecipeStorageRequest,
  type RelayRecipeStorageMsg,
  type RecipeStorageResponse,
  type RelayRecipeStorageResultMsg,
} from "../src/orchestrator/messages.js";
import { createCaptureStore } from "../src/recipes/capture-store.js";
import type { SaveCaptureResultMsg } from "../src/orchestrator/messages.js";

const LECRERC_URL_FILTER = {
  url: [{ hostSuffix: "leclercdrive.fr" }],
};

// The WebMCP runtime and tool registrations are injected in MAIN world. The
// relay embed is injected separately after the page reports that all tools
// have finished registering through the asynchronous WebMCP API.
const TOOL_FILES = ["inject.js"];
const EMBED_FILES = ["embed.js"];

// Isolated-world content relay (one file, declared as a content script in the
// manifest too, but also injected dynamically so it lands on already-open tabs
// without a reload). It speaks chrome.runtime on one side and window.postMessage
// (to the MAIN bridge) on the other.
const RELAY_FILES = ["content-relay.js"];

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !isLeclercUrl(tab.url)) return;

  try {
    await injectWebMcpBridge(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: RELAY_FILES,
    });
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f8a3f" });
  } catch (err) {
    // The page must still be present; most failures here are "frame removed"
    // during a navigation race. Log to the extension DevTools console.
    console.error(`[mcp-leclerc-drive] inject failed for tab ${tabId}:`, err);
    try {
      await chrome.action.setBadgeText({ tabId, text: "ERR" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b00020" });
    } catch {
      /* badge not settable on transient tabs */
    }
  }
});

// Re-inject on extension reload / browser start for any Leclerc tab already open.
chrome.runtime.onStartup.addListener(async () => {
  await reinjectAllLeclercTabs();
});
chrome.runtime.onInstalled.addListener(async () => {
  await reinjectAllLeclercTabs();
});

async function reinjectAllLeclercTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.leclercdrive.fr/*" });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await injectWebMcpBridge(tab.id);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "ISOLATED",
          files: RELAY_FILES,
        });
        await chrome.action.setBadgeText({ tabId: tab.id, text: "ON" });
        await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#1f8a3f" });
      } catch (err) {
        console.error(`[mcp-leclerc-drive] re-inject failed for tab ${tab.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[mcp-leclerc-drive] tabs.query failed:`, err);
  }
}

async function injectWebMcpBridge(tabId: number): Promise<void> {
  const target = { tabId };
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    files: TOOL_FILES,
  });
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    func: awaitWebMcpReady,
  });
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    func: setRelayEmbedConfig,
    args: [chrome.runtime.getURL("widget.html"), "127.0.0.1", "9333"],
  });
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    files: EMBED_FILES,
  });
}

// chrome.scripting.executeScript waits for the returned promise in the target
// page, so this is a synchronization point without polling or a timing delay.
async function awaitWebMcpReady(): Promise<boolean> {
  const page = window as Window & { __mcpLeclercDriveReady?: Promise<void> };
  if (!page.__mcpLeclercDriveReady) {
    throw new Error("Démarrage WebMCP absent ; recharge l'onglet Leclerc.");
  }
  await page.__mcpLeclercDriveReady;
  return true;
}

function isLeclercUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".leclercdrive.fr");
  } catch {
    return false;
  }
}

// ---- Popup ↔ offscreen ↔ content relay routing ----------------------------

const OFFSCREEN_URL = "offscreen/offscreen.html";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Recipe storage requests come from the content relay (Leclerc tab bridge).
  if (isRecipeStorageRequest((msg as { request?: unknown })?.request)) {
    const { request } = msg as RelayRecipeStorageMsg;
    void handleRecipeStorage(request)
      .then((response) => sendResponse({ type: "recipe_storage_result", response }))
      .catch(() => undefined); // handleRecipeStorage never rejects
    return true; // async
  }
  void handlePopupMessage(msg as PopupToBackgroundMsg, sender, sendResponse);
  return true; // async
});

async function handlePopupMessage(
  msg: PopupToBackgroundMsg,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (resp: unknown) => void,
): Promise<void> {
  try {
    switch (msg.type) {
      case "model_status":
        return void sendResponse(await handleModelStatus());
      case "orchestrate":
        return void sendResponse(await handleOrchestrate(msg));
      case "leclerc_run":
        return void sendResponse(await handleLeclercRun(msg));
      case "reload_offscreen":
        return void sendResponse(await handleReloadOffscreen());
      case "set_model":
        return void sendResponse(await handleSetModel(msg));
      case "save_capture":
        return void sendResponse(await handleSaveCapture());
      default:
        return void sendResponse({
          type: "leclerc_run_result",
          ok: false,
          error: "Message popup inconnu.",
        });
    }
  } catch (err) {
    sendResponse({
      type: "leclerc_run_result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// -- recipe storage: bridge (MAIN world) ↔ capture/library/digest stores ----

/**
 * Recipe-capability storage requests from the MAIN-world bridge, forwarded by
 * the content relay. The service is rebuilt on every request from
 * chrome.storage.local, so a service-worker restart loses nothing (ticket
 * 31): captures, personal recipes and the digest state all live in storage.
 */
async function handleRecipeStorage(request: RecipeStorageRequest):
  Promise<RecipeStorageResponse> {
  const service = createRecipeService({
    captureStore: createCaptureStore(chromeStorageAdapter()),
    libraryStore: createLibraryStore(chromeStorageAdapter(), parseRecipe),
  });
  let ok = false;
  let data: unknown;
  let error: string | undefined;
  try {
    switch (request.command) {
      case "list_captures":
        data = await service.listCaptures();
        ok = true;
        break;
      case "get_capture":
        data = await service.getCapture(String(request.args.id ?? ""));
        ok = true;
        break;
      case "save_recipe":
        data = await service.saveRecipe(
          request.args.recipe,
          typeof request.args.captureId === "string" ? request.args.captureId : undefined,
        );
        ok = true;
        break;
      case "abandon_capture":
        data = await service.abandonCapture(String(request.args.id ?? ""));
        ok = true;
        break;
      case "get_personal_recipe":
        data = await service.getPersonalRecipe(String(request.args.id ?? ""));
        ok = true;
        break;
      case "personal_recipes":
        data = await service.personalRecipes();
        ok = true;
        break;
      case "claim_new_recipes":
        data = await service.claimNewRecipes();
        ok = true;
        break;
      default:
        error = `Commande de stockage recettes inconnue : ${request.command}`;
    }
  } catch (err) {
    // A storage failure is an error, never a success.
    error = err instanceof Error ? err.message : String(err);
  }
  return ok
    ? {
        source: RECIPE_STORAGE_RESPONSE_SOURCE,
        requestId: request.requestId,
        ok: true,
        data,
      }
    : {
        source: RECIPE_STORAGE_RESPONSE_SOURCE,
        requestId: request.requestId,
        ok: false,
        error: error ?? "Erreur de stockage recettes inconnue.",
      };
}
// -- recipe page capture (popup → active tab → capture store) --------------

/**
 * Reads the useful visible content of the active tab (the tab the user
 * clicked the extension on — temporary `activeTab` access, no permanent
 * host permission) and saves a pending capture in chrome.storage.local.
 *
 * The excerpt is plain text only (innerText excludes scripts, styles,
 * hidden nodes and form field values) and is bounded before storage; the
 * full HTML page is never kept. Nothing from the page is ever executed.
 */
async function handleSaveCapture(): Promise<SaveCaptureResultMsg> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    return { type: "save_capture_result", ok: false, error: "Aucun onglet actif à capturer." };
  }
  let data:
    | { ok: boolean; title?: string; excerpt?: string; structuredJson?: string[]; error?: string }
    | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectVisibleExcerpt,
      args: [20000], // MAX_EXCERPT_CHARS (src/recipes/capture.ts) — serialized fn cannot import it
    });
    data = results[0]?.result as typeof data;
  } catch (err) {
    // Protected pages (chrome://, web store…) or a lost tab: no access.
    return {
      type: "save_capture_result",
      ok: false,
      error: `Impossible de lire la page active (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!data || !data.ok || !data.excerpt) {
    return {
      type: "save_capture_result",
      ok: false,
      error: data?.error ?? "Aucun contenu visible exploitable sur cette page.",
    };
  }
  // Structured data first (spec: exploit Recipe JSON-LD when present), then
  // the visible text — both bounded by buildCaptureRecord. Both stay inert
  // data; nothing from the page is ever executed.
  const structured = extractStructuredRecipe(data.structuredJson ?? []);
  const record = buildCaptureRecord({
    url: tab.url,
    capturedAt: Date.now(),
    title: data.title,
    excerpt:
      structured.length > 0
        ? `${structured}

--- Contenu visible de la page ---
${data.excerpt}`
        : data.excerpt,
  });
  if (!record.ok) {
    return { type: "save_capture_result", ok: false, error: record.error };
  }
  try {
    // Storage failures throw and are returned as failures — never a success.
    const store = createCaptureStore(chromeStorageAdapter());
    const saved = await store.save(record.capture);
    return {
      type: "save_capture_result",
      ok: true,
      capture: { id: saved.id, url: saved.url, ...(saved.title ? { title: saved.title } : {}) },
    };
  } catch (err) {
    return {
      type: "save_capture_result",
      ok: false,
      error: `Échec de la sauvegarde locale de la capture (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

/**
 * Serialized into the active tab (ISOLATED world). Must stay self-contained:
 * no imports, no chrome.* APIs. Returns plain text only — innerText never
 * includes scripts, styles, or form input values, and nothing is evaluated.
 */
function collectVisibleExcerpt(maxChars: number):
  | { ok: true; title?: string; excerpt: string; structuredJson?: string[] }
  | { ok: false; error: string } {
  try {
    const root =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body;
    const text = (root?.innerText ?? "").replace(/\u00a0/g, " ").trim();
    if (!text) return { ok: false, error: "Aucun contenu visible exploitable sur cette page." };
    const excerpt = text.length > maxChars ? text.slice(0, maxChars) : text;
    const title = (document.title || "").trim();
    // Raw schema.org JSON-LD script texts (bounded): parsed later, off-page,
    // as inert data. Nothing here is executed or trusted.
    const structuredJson: string[] = [];
    for (const script of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).slice(0, 5)) {
      const raw = script.textContent ?? "";
      if (raw.trim()) structuredJson.push(raw.slice(0, 50000));
    }
    return {
      ok: true,
      ...(title ? { title } : {}),
      ...(structuredJson.length > 0 ? { structuredJson } : {}),
      excerpt,
    };
  } catch (err) {
    return { ok: false, error: `Lecture de la page impossible (${String(err)}).` };
  }
}

/** chrome.storage.local as a CaptureStorageAdapter. */
function chromeStorageAdapter() {
  return {
    async get(key: string) {
      const values = await chrome.storage.local.get([key]);
      return values[key];
    },
    async set(key: string, value: unknown) {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}


// -- active model + device (background-owned; offscreen has no storage) ----

async function getActiveModel(): Promise<{ entry: ModelEntry; device: "webgpu" | "wasm" }> {
  const v = await chrome.storage.local.get(["modelId", "webgpu"]);
  const modelId = (v as { modelId?: string }).modelId ?? DEFAULT_MODEL_ID;
  const entry = findModel(modelId);
  // `webgpu` storage flag is a manual override independent of the model's
  // recommended device: explicit `true` forces WebGPU, explicit `false` (and
  // unset) forces WASM. WASM is the default because WebGPU crashes the Chrome
  // GPU process on some macOS setups (EXC_BREAKPOINT in the compositor).
  const override = (v as { webgpu?: boolean }).webgpu;
  const device = override === true ? "webgpu" : "wasm";
  return { entry, device };
}

// -- model status -----------------------------------------------------------

async function handleModelStatus(): Promise<ModelStatusMsg> {
  try {
    const { entry, device } = await getActiveModel();
    const existing = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (!existing) {
      return {
        type: "model_status",
        status: "idle",
        modelId: entry.id,
        detail: `dtype=${entry.dtype}, device=${device}`,
      };
    }
    const res = await chrome.runtime.sendMessage({
      type: "offscreen_status",
      modelId: entry.id,
      repoId: entry.repoId,
      dtype: entry.dtype,
      device,
      allowWasmFallback: entry.supportsWasm,
    } satisfies OffscreenStatusMsg);
    const r = res as OffscreenStatusResultMsg | undefined;
    if (r?.type === "offscreen_status_result") {
      return {
        type: "model_status",
        status: r.status === "ready" ? "ready" : r.status === "error" ? "error" : "loading",
        modelId: entry.id,
        detail: r.device ? `dtype=${entry.dtype}, device=${r.device}` : r.error,
      };
    }
    return { type: "model_status", status: "loading", modelId: entry.id };
  } catch (err) {
    return {
      type: "model_status",
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// -- orchestration ----------------------------------------------------------

async function handleOrchestrate(
  msg: OrchestrateRequestMsg,
): Promise<OffscreenOrchestrateResultMsg> {
  const normalized = normalizeShoppingList(msg.text);
  if (normalized?.ok) {
    return {
      type: "offscreen_orchestrate_result",
      ok: true,
      plan: normalized.plan,
      debug: {
        traceId: msg.traceId,
        source: normalized.source,
        input: msg.text,
        parsedPlan: normalized.plan,
      },
    };
  }

  const byok = await getByokConfig();
  if (byok) {
    if (!byok.ok) {
      // The user explicitly selected a provider: surface the config error
      // instead of silently falling back to the (heavy) local model.
      return {
        type: "offscreen_orchestrate_result",
        ok: false,
        error: byok.error,
        debug: {
          traceId: msg.traceId,
          source: "byok",
          input: msg.text,
          error: byok.error,
        },
      };
    }
    return await orchestrateByok(msg, byok.config);
  }

  const { entry, device } = await getActiveModel();
  if (device === "wasm" && !entry.supportsWasm) {
    return {
      type: "offscreen_orchestrate_result",
      ok: false,
      error:
        `${entry.label} nécessite WebGPU. ` +
        "Coche WebGPU pour tester ce modèle, ou choisis Qwen3 0.6B q4 pour le mode WASM.",
      debug: {
        traceId: msg.traceId,
        modelId: entry.id,
        repoId: entry.repoId,
        dtype: entry.dtype,
        promptFormat: entry.promptFormat,
        device,
        input: msg.text,
        error: "Model blocked before ONNX session creation: WebGPU-only variant selected without WebGPU.",
      },
    };
  }
  await ensureOffscreen();
  console.info("[mcp-leclerc-drive][background] orchestrate request", {
    traceId: msg.traceId,
    text: msg.text,
    modelId: entry.id,
    repoId: entry.repoId,
    dtype: entry.dtype,
    promptFormat: entry.promptFormat,
    device,
  });
  const res = await chrome.runtime.sendMessage({
    type: "offscreen_orchestrate",
    traceId: msg.traceId,
    text: msg.text,
    modelId: entry.id,
    repoId: entry.repoId,
    dtype: entry.dtype,
    promptFormat: entry.promptFormat,
    device,
    allowWasmFallback: entry.supportsWasm,
  } satisfies OffscreenOrchestrateMsg);
  console.info("[mcp-leclerc-drive][background] orchestrate response", {
    traceId: msg.traceId,
    response: res,
  });
  return res as OffscreenOrchestrateResultMsg;
}

// -- BYOK remote inference (replaces the local model when configured) ------

const BYOK_TIMEOUT_MS = 30_000;

/**
 * Persisted BYOK settings (popup-owned, chrome.storage.local key `byok`):
 *   { provider?: "openai" | "vibe", openaiKey?, vibeKey?, openaiModel?, vibeModel? }
 * Absent/empty `provider` means BYOK is off → the local model is used.
 */
async function getByokConfig(): Promise<
  ReturnType<typeof resolveByokConfig> | null
> {
  const v = (await chrome.storage.local.get("byok")) as {
    byok?: {
      provider?: string;
      openaiKey?: string;
      vibeKey?: string;
      openaiModel?: string;
      vibeModel?: string;
    };
  };
  const stored = v.byok;
  if (!stored?.provider) return null;
  const isVibe = stored.provider === "vibe";
  return resolveByokConfig(
    stored.provider,
    isVibe ? stored.vibeKey : stored.openaiKey,
    isVibe ? stored.vibeModel : stored.openaiModel,
  );
}

/**
 * Remote inference path: send the same shopping-list prompt to the configured
 * OpenAI-compatible provider and reuse the local plan validation. The API key
 * only ever lives in the request Authorization header and is scrubbed from
 * every error/debug payload. No offscreen document is created for this path —
 * the user's key replaces the local model entirely.
 */
async function orchestrateByok(
  msg: OrchestrateRequestMsg,
  config: ByokConfig,
): Promise<OffscreenOrchestrateResultMsg> {
  const request = buildChatCompletionRequest(config, buildMessages(msg.text));
  const modelId = `${config.provider.id}:${config.model}`;
  console.info("[mcp-leclerc-drive][background] byok orchestrate request", {
    traceId: msg.traceId,
    provider: config.provider.id,
    model: config.model,
    text: msg.text,
  });
  let rawOutput: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BYOK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = scrubApiKey(
        `${config.provider.label} : ${extractApiErrorMessage(json, res.status)}`,
        config.apiKey,
      );
      return {
        type: "offscreen_orchestrate_result",
        ok: false,
        error,
        debug: { traceId: msg.traceId, modelId, source: "byok", input: msg.text, error },
      };
    }
    rawOutput = extractAssistantText(json);
    if (rawOutput === null) {
      const error = `${config.provider.label} : réponse sans contenu assistant.`;
      return {
        type: "offscreen_orchestrate_result",
        ok: false,
        error,
        debug: { traceId: msg.traceId, modelId, source: "byok", input: msg.text, error },
      };
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    const error = scrubApiKey(
      aborted
        ? `${config.provider.label} : délai dépassé (${BYOK_TIMEOUT_MS / 1000}s).`
        : `${config.provider.label} : ${err instanceof Error ? err.message : String(err)}`,
      config.apiKey,
    );
    return {
      type: "offscreen_orchestrate_result",
      ok: false,
      error,
      debug: { traceId: msg.traceId, modelId, source: "byok", input: msg.text, error },
    };
  }
  const parsed = parsePlan(rawOutput);
  if (!parsed.ok) {
    return {
      type: "offscreen_orchestrate_result",
      ok: false,
      error: parsed.error,
      debug: {
        traceId: msg.traceId,
        modelId,
        source: "byok",
        input: msg.text,
        rawOutput,
        error: parsed.error,
      },
    };
  }
  console.info("[mcp-leclerc-drive][background] byok parsed plan", {
    traceId: msg.traceId,
    provider: config.provider.id,
    model: config.model,
    items: parsed.plan.items.length,
  });
  return {
    type: "offscreen_orchestrate_result",
    ok: true,
    plan: parsed.plan,
    debug: {
      traceId: msg.traceId,
      modelId,
      source: "byok",
      input: msg.text,
      rawOutput,
      parsedPlan: parsed.plan,
    },
  };
}

// -- leclerc run (popup → content relay → MAIN bridge) ----------------------

async function handleLeclercRun(msg: LeclercRunMsg): Promise<LeclercRunResultMsg> {
  const tabId = await findLeclercTabId();
  const requestId = `req_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const request: LeclercRequest = {
    source: "mcp-leclerc-drive:relay",
    requestId,
    command: msg.command,
    args: msg.args,
  };
  console.info("[mcp-leclerc-drive][background] leclerc_run request", {
    traceId: msg.traceId,
    tabId,
    request,
  });
  try {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: "leclerc_request",
      request,
    });
    const r = res as { type: string; response?: LeclercResponse } | undefined;
    if (r?.type === "leclerc_result" && r.response && isLeclercResponse(r.response)) {
      const result = {
        type: "leclerc_run_result",
        ok: r.response.ok,
        data: r.response.ok ? r.response.data : undefined,
        error: r.response.ok ? undefined : r.response.error,
      } satisfies LeclercRunResultMsg;
      console.info("[mcp-leclerc-drive][background] leclerc_run response", {
        traceId: msg.traceId,
        result,
      });
      return result;
    }
    return {
      type: "leclerc_run_result",
      ok: false,
      error: "Réponse du relay de contenu invalide.",
    };
  } catch (err) {
    return {
      type: "leclerc_run_result",
      ok: false,
      error:
        "Impossible de joindre l'onglet Leclerc. Ouvre ton drive Leclerc dans un onglet, puis réessaie (" +
        (err instanceof Error ? err.message : String(err)) +
        ").",
    };
  }
}

async function findLeclercTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: "*://*.leclercdrive.fr/*" });
  // Prefer the active tab if it's a Leclerc tab, else the first match.
  const active = tabs.find((t) => t.active);
  const chosen = active ?? tabs[0];
  if (!chosen?.id) {
    throw new Error("Aucun onglet Leclerc Drive ouvert.");
  }
  return chosen.id;
}

// -- model switch + offscreen reload --------------------------------------

async function handleSetModel(msg: SetModelMsg): Promise<ReloadOffscreenResultMsg> {
  try {
    await chrome.storage.local.set({ modelId: msg.modelId });
    return await handleReloadOffscreen();
  } catch (err) {
    return {
      type: "reload_offscreen_result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleReloadOffscreen(): Promise<ReloadOffscreenResultMsg> {
  try {
    // Close any existing offscreen document so the next explicit model run
    // rebuilds the pipeline for the current model + device. Do not recreate
    // the document here: merely opening the popup or changing an option should
    // not load ONNX/Transformers, because that can crash some Chrome Canary
    // builds on macOS.
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* none yet */
    }
    const { entry, device } = await getActiveModel();
    return {
      type: "reload_offscreen_result",
      ok: true,
      modelId: entry.id,
      device,
    };
  } catch (err) {
    return {
      type: "reload_offscreen_result",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -- offscreen document lifecycle -------------------------------------------

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (existing) return;
  // createDocument throws if one already exists; guard with hasDocument when
  // available (Chrome 116+), otherwise try/catch.
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification:
        "Run the local Transformers.js text-generation model for the shopping-list orchestrator (WebGPU/WASM).",
    });
  } catch (err) {
    // Already exists or race; verify presence.
    if (!(await chrome.offscreen.hasDocument?.().catch(() => false))) {
      throw err;
    }
  }
}

// The vendored relay embed derives its widget URL from `document.currentScript`,
// which is null when a file is injected with chrome.scripting.executeScript.
// The patched embed (see build-extension.mjs) falls back to this page-global
// config, so the background supplies the chrome-extension:// widget URL and
// the loopback relay coordinates here.
function setRelayEmbedConfig(
  widgetUrl: string,
  relayHost: string,
  relayPort: string,
): void {
  const page = window as Window & {
    __WEBMCP_RELAY_EMBED__?: { widgetUrl: string; relayHost: string; relayPort: string };
  };
  page.__WEBMCP_RELAY_EMBED__ = { widgetUrl, relayHost, relayPort };
}
