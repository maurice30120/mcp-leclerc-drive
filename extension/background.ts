/**
 * Extension background service worker.
 *
 * Four responsibilities:
 *   1. Inject the WebMCP tool bridge (inject.js + embed.js) into Leclerc Drive
 *      tabs so the existing 9 MCP tools keep working for opencode / Claude Code.
 *   2. Inject the isolated-world content relay (content-relay.js) so the popup
 *      can drive the same dispatcher via postMessage.
 *   3. Route messages between the popup, the offscreen model document and the
 *      content relay (Leclerc tab).
 *   4. Host the side panel agent protocol (ticket #51): the shopping flow
 *      with its EXPLICIT global approval, providers selected explicitly only
 *      (simulated offline demo / local model through the offscreen document /
 *      Mistral BYOK with a stored key), the session state machine persisted in
 *      chrome.storage.session, and the manifest-verified local model download
 *      with explicit consent.
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
  type PrepareRecipeMsg,
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
import { LECLERC_DOMAIN, isLeclercDomainHost } from "../src/leclerc/api.js";
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

// Side panel agent wiring (ticket #51).
import {
  SIDEPANEL_EVENT_CHANNEL,
  SIDEPANEL_KEEPALIVE_PORT,
  SidePanelSession,
  buildSidePanelPrompt,
  buildSimulatedRecipeScript,
  isSidePanelRequestEnvelope,
  type FlowResultPayload,
  type OffscreenGenerateMsg,
  type OffscreenGenerateResultMsg,
  type SidePanelEvent,
  type SidePanelModelState,
  type SidePanelRequest,
  type SidePanelRequestResult,
} from "../src/sidepanel-protocol/protocol.js";
import { LOCAL_MODEL_MANIFEST } from "../src/sidepanel-protocol/local-model.js";
import { requestedServings, packagingFromLabel } from "../src/sidepanel-protocol/shopping-request.js";
import {
  ApprovalGate,
  ToolExecutor,
  ProgressiveCart,
  createTraceBuilder,
  isCartProgress,
  type CartProgress,
  SimulatedProvider,
  bindingFromContract,
  createMistralByokProvider,
  createWebGpuProvider,
  downloadModel,
  resumeShoppingFlow,
  runShoppingFlow,
  type ApprovalDecision,
  type ApprovalDecisionHandler,
  type CachedModelFile,
  type ProductReviewChoice,
  type ProductReviewHandler,
  type ClarificationAnswer,
  type ClarificationHandler,
  type ModelCacheStore,
  type ModelManifest,
  type ModelProvider,
  type ShoppingFlowRequest,
  type ShoppingFlowResume,
  type ShoppingFlowResult,
  type ToolBinding,
  type WebGpuPipeline,
  type WebGpuPipelineFactory,
  type WebGpuProbe,
} from "@leclerc/agent";
import {
  addToCart,
  getCart,
  listHabitualProducts,
  updateQuantity,
  parseRecipeText,
  searchProduct,
  toolError,
  type Cart as DomainCart,
  type GeneratedRecipe,
  type Product as DomainProduct,
} from "@leclerc/contracts";
import type { Cart as BridgeCart, Product as BridgeProduct } from "../src/types.js";

const LECRERC_URL_FILTER = {
  url: [{ hostSuffix: LECLERC_DOMAIN }],
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
    const tabs = await chrome.tabs.query({ url: `*://*.${LECLERC_DOMAIN}/*` });
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
    // Domain check shared with src/leclerc/api.ts (ADR-0004): any
    // *.leclercdrive.fr page, not just the fdN-courses backend shape.
    return u.protocol === "https:" && isLeclercDomainHost(u.hostname);
  } catch {
    return false;
  }
}

// ---- Popup ↔ offscreen ↔ content relay routing ----------------------------

const OFFSCREEN_URL = "offscreen/offscreen.html";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Side panel protocol (ticket #51): its own channel, routed first.
  if (isSidePanelRequestEnvelope(msg)) {
    void handleSidePanelRequest(msg.request)
      .then((result) => sendResponse(result))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies SidePanelRequestResult),
      );
    return true; // async
  }
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
      case "prepare_recipe": {
        // Open immediately while the popup click still carries user activation.
        const opened = chrome.sidePanel.open({ windowId: msg.windowId });
        return void sendResponse(await handlePrepareRecipe(msg, opened));
      }
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
  // An explicitly selected remote provider takes precedence over every local
  // shortcut, including deterministic parsing of otherwise simple lists.
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
  const result = await runLeclercCommand(msg.command, msg.args);
  return {
    type: "leclerc_run_result",
    ok: result.ok,
    ...(result.ok ? { data: result.data } : { error: result.error }),
  };
}

/**
 * The single background seam toward the live Leclerc tab: content relay →
 * MAIN bridge → dispatcher. Both the popup (leclerc_run) and the side panel
 * agent capabilities (ticket #51) go through here, so there is no duplicated
 * business logic between the two surfaces.
 */
async function runLeclercCommand(
  command: LeclercCommandName,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const tabId = await findLeclercTabId();
  const requestId = `req_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const request: LeclercRequest = {
    source: "mcp-leclerc-drive:relay",
    requestId,
    command,
    args,
  };
  console.info("[mcp-leclerc-drive][background] leclerc_run request", {
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
      console.info("[mcp-leclerc-drive][background] leclerc_run response", {
        ok: r.response.ok,
        requestId,
      });
      return r.response.ok
        ? { ok: true, data: r.response.data }
        : { ok: false, error: r.response.error };
    }
    return { ok: false, error: "Réponse du relay de contenu invalide." };
  } catch (err) {
    return {
      ok: false,
      error:
        "Impossible de joindre l'onglet Leclerc. Ouvre ton drive Leclerc dans un onglet, puis réessaie (" +
        (err instanceof Error ? err.message : String(err)) +
        ").",
    };
  }
}

async function findLeclercTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: `*://*.${LECLERC_DOMAIN}/*` });
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

// ---- Side panel agent (ticket #51) ----------------------------------------
//
// The side panel is the conversation surface of the shopping agent
// (tickets #44/#50). The protocol and the session state machine are pure and
// unit-tested in src/sidepanel-protocol (tests/sidepanel-protocol.test.ts);
// this section is the Chrome wiring only:
//
//   - provider construction is EXPLICIT ONLY: the simulated scripted demo
//     (offline, never selected implicitly), the local model through the
//     existing offscreen document — the only context with WebGPU access, no
//     CPU/WASM fallback on this path — and Mistral BYOK when a key is stored.
//     No code path ever falls back from one provider to another: a failure is
//     surfaced (diagnostic + consent-only Mistral proposal), never retried
//     elsewhere;
//   - the capabilities run through the SAME dispatcher bridge as the popup
//     (runLeclercCommand → content relay → MAIN bridge on the Leclerc tab);
//   - progressive mutations require an exact durable preparation intent;
//     historical approval-gated snapshots keep their original authorization;
//   - the conversation lives in chrome.storage.session (survives MV3 service
//     worker suspensions, cleared when the browser closes) and NEVER in
//     chrome.storage.local. The contribution journal and Mistral settings are
//     stored separately in chrome.storage.local; the key is never echoed back.

const SIDEPANEL_SESSION_KEY = "sidepanelSession";
const CART_PROGRESS_STORAGE_KEY = "preparedCartProgress";
const MISTRAL_KEY_STORAGE_KEY = "sidepanelMistralApiKey";
const MISTRAL_MODEL_ID = "mistral-small-latest";
const MISTRAL_MODEL_STORAGE_KEY = "sidepanelMistralModel";
const SIDEPANEL_PROVIDER_STORAGE_KEY = "sidepanelProvider";

async function handlePrepareRecipe(
  msg: PrepareRecipeMsg,
  opened: Promise<void>,
): Promise<SidePanelRequestResult> {
  await opened;
  const session = await loadSidePanelSession();
  if (session.getState().flowActive) {
    return { ok: false, error: "Un parcours est déjà en cours dans l'assistant." };
  }
  const config = resolveByokConfig(msg.providerId, msg.apiKey, msg.model);
  if (msg.providerId !== "vibe" || !config.ok) {
    const error = msg.providerId !== "vibe"
      ? "Choisis Mistral dans le plugin pour préparer une recette, ou sélectionne un fournisseur dans les réglages de l'assistant."
      : config.ok ? "Configuration Mistral invalide." : config.error;
    session.appendHistory("assistant", "error", error);
    await emitSidePanelState();
    return { ok: false, error };
  }
  // Reuse the explicit popup selection without asking the user to enter the
  // same key again. Only a boolean enters the conversation snapshot.
  session.selectProvider("mistral");
  await saveMistralConfig(config.config.apiKey, config.config.model);
  await chrome.storage.local.set({ [SIDEPANEL_PROVIDER_STORAGE_KEY]: "mistral" });
  session.setMistralKeySet(true);
  return handleSidePanelRequest({
    type: "start_flow", message: msg.text, servings: requestedServings(msg.text),
  });
}
const MODEL_CACHE_NAME = "mcp-leclerc-drive:models";

let sidepanelSession: SidePanelSession | undefined;
let sidepanelSessionLoaded = false;

/** The live flow of THIS service worker instance (dies with the worker). */
interface LiveSidePanelFlow {
  reviewResolver?: (choices: ProductReviewChoice[]) => void;
  approvalResolver?: (decision: ApprovalDecision) => void;
  clarificationResolver?: (answer: ClarificationAnswer) => void;
}
let liveSidePanelFlow: LiveSidePanelFlow | undefined;
let cartReviewMutation = false;

/**
 * Loads (and on first call restores) the session snapshot from
 * chrome.storage.session. A flow that was mid-run in the previous worker
 * instance can only be an interrupted run — except a pending approval, which
 * is kept so the user can still approve (the completion then goes through
 * the resume path with a fresh gate).
 */
let sidepanelSessionLoading: Promise<SidePanelSession> | undefined;
let sidepanelStateWrites: Promise<void> = Promise.resolve();

async function loadSidePanelSession(): Promise<SidePanelSession> {
  if (sidepanelSessionLoaded) return sidepanelSession!;
  if (sidepanelSessionLoading) return sidepanelSessionLoading;
  sidepanelSessionLoading = (async () => {
    const session = new SidePanelSession();
    const stored = await chrome.storage.session.get(SIDEPANEL_SESSION_KEY);
    const snapshot = stored[SIDEPANEL_SESSION_KEY];
    if (snapshot !== undefined) {
      const restored = SidePanelSession.restore(snapshot);
      markInterruptedSidePanelFlow(restored);
      sidepanelSession = restored;
    } else sidepanelSession = session;
    // The durable contribution journal is authoritative across browser restarts.
    // Credentials are restored separately; they never enter the contribution journal.
    const local = await chrome.storage.local.get([CART_PROGRESS_STORAGE_KEY, MISTRAL_KEY_STORAGE_KEY, MISTRAL_MODEL_STORAGE_KEY, SIDEPANEL_PROVIDER_STORAGE_KEY, "byok"]);
    const volatile = await chrome.storage.session.get([MISTRAL_KEY_STORAGE_KEY, MISTRAL_MODEL_STORAGE_KEY]);
    const legacy = local.byok as { provider?: string; vibeKey?: string; vibeModel?: string } | undefined;
    const key = local[MISTRAL_KEY_STORAGE_KEY] ?? volatile[MISTRAL_KEY_STORAGE_KEY]
      ?? (legacy?.provider === "vibe" ? legacy.vibeKey : undefined);
    if (typeof key === "string" && key.trim()) {
      const model = local[MISTRAL_MODEL_STORAGE_KEY] ?? volatile[MISTRAL_MODEL_STORAGE_KEY] ?? legacy?.vibeModel;
      await saveMistralConfig(key, typeof model === "string" && model.trim() ? model : MISTRAL_MODEL_ID);
      sidepanelSession!.setMistralKeySet(true);
    } else sidepanelSession!.setMistralKeySet(false);
    const provider = local[SIDEPANEL_PROVIDER_STORAGE_KEY] ?? (legacy?.provider === "vibe" ? "mistral" : undefined);
    if (sidepanelSession!.getState().provider === "none" && ["simulated", "webgpu", "mistral"].includes(String(provider))) {
      sidepanelSession!.selectProvider(provider as "simulated" | "webgpu" | "mistral");
    }
    const progress = local[CART_PROGRESS_STORAGE_KEY] as CartProgress | undefined;
    if (progress !== undefined) {
      if (!isCartProgress(progress)) throw new Error("Journal de panier invalide : aucune mutation autorisée.");
      sidepanelSession!.setCartProgress(progress);
      if (!progress.finished) {
        sidepanelSession!.finishFlow("cancelled");
        if (snapshot === undefined) sidepanelSession!.appendHistory("assistant", "message", "Panier préparé retrouvé : les quantités confirmées sont conservées. Reprendre vérifiera le panier réel.");
      }
    }
    sidepanelSessionLoaded = true;
    return sidepanelSession;
  })();
  try { return await sidepanelSessionLoading; }
  catch (error) { sidepanelSessionLoading = undefined; throw error; }
}

function writeSidePanelSnapshot(): Promise<void> {
  if (!sidepanelSession) return Promise.reject(new Error("Session non chargée."));
  const snapshot = structuredClone(sidepanelSession.serialize());
  const write = sidepanelStateWrites.catch(() => {}).then(async () => {
    if (snapshot.cartProgress) await chrome.storage.local.set({ [CART_PROGRESS_STORAGE_KEY]: snapshot.cartProgress });
    await chrome.storage.session.set({ [SIDEPANEL_SESSION_KEY]: snapshot });
  });
  sidepanelStateWrites = write;
  return write;
}

function markInterruptedSidePanelFlow(restored: SidePanelSession): void {
  const state = restored.getState();
  if (!state.flowActive) return;
  if (state.cartProgress) {
    restored.appendHistory("assistant", "error", "Parcours interrompu : les ajouts confirmés sont conservés. Reprendre relira le panier avant toute mutation.");
    restored.finishFlow("cancelled");
    return;
  }
  if (state.phase === "awaiting_approval") {
    return; // still approvable through the resume path
  }
  restored.appendHistory(
    "assistant",
    "error",
    "Le service worker a été suspendu pendant le parcours : il a été interrompu. Aucune écriture au panier n'est en attente.",
  );
  restored.finishFlow("cancelled");
}

async function persistSidePanelSession(): Promise<void> {
  const current = sidepanelSession;
  if (!current) return;
  try {
    await writeSidePanelSnapshot();
  } catch (err) {
    console.error("[mcp-leclerc-drive][sidepanel] persistance de session impossible :", err);
  }
}

/** Pushes one protocol event to the side panel (no-op when it is closed). */
async function emitSidePanelEvent(event: SidePanelEvent): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ channel: SIDEPANEL_EVENT_CHANNEL, event });
  } catch {
    /* the panel is closed: events are disposable, the state is the truth */
  }
}

async function emitSidePanelState(): Promise<void> {
  await persistSidePanelSession();
  const state = (await loadSidePanelSession()).getState();
  await emitSidePanelEvent({ type: "state", state });
}

// -- request routing ---------------------------------------------------------

async function handleSidePanelRequest(
  request: SidePanelRequest,
): Promise<SidePanelRequestResult> {
  const session = await loadSidePanelSession();
  switch (request.type) {
    case "get_state":
    case "model_status": {
      await refreshSidePanelModelState();
      return { ok: true, state: session.getState() };
    }
    case "set_provider": {
      const result = session.selectProvider(request.providerId);
      if (result.ok) await chrome.storage.local.set({ [SIDEPANEL_PROVIDER_STORAGE_KEY]: request.providerId });
      await emitSidePanelState();
      return result.ok ? { ok: true, state: session.getState() } : { ok: false, error: result.error };
    }
    case "set_mistral_key": {
      // Persist locally for browser restarts; only a boolean enters UI snapshots.
      const savedModel = (await chrome.storage.session.get(MISTRAL_MODEL_STORAGE_KEY))[MISTRAL_MODEL_STORAGE_KEY];
      await saveMistralConfig(request.apiKey, typeof savedModel === "string" && savedModel.trim() ? savedModel : MISTRAL_MODEL_ID);
      session.setMistralKeySet(true);
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "delete_mistral_key": {
      await chrome.storage.local.remove(MISTRAL_KEY_STORAGE_KEY);
      await chrome.storage.session.remove(MISTRAL_KEY_STORAGE_KEY);
      // Remove the older popup copy as well, so migration cannot resurrect it.
      const legacy = (await chrome.storage.local.get("byok")).byok;
      if (legacy && typeof legacy === "object" && "vibeKey" in legacy) {
        const { vibeKey: _deleted, ...rest } = legacy;
        await chrome.storage.local.set({ byok: rest });
      }
      session.setMistralKeySet(false);
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "start_flow": {
      const servings = requestedServings(request.message, request.servings);
      const flowRequest: ShoppingFlowRequest = {
        message: `${request.message}\nNombre de personnes demandé : ${servings}.${
          request.exclusions?.length ? `\nIngrédients exclus : ${request.exclusions.join(", ")}.` : ""
        }`,
        servings,
        ...(request.exclusions ? { excludedIngredients: request.exclusions } : {}),
      };
      const started = session.startFlow({
        message: request.message,
        servings,
        ...(request.exclusions ? { exclusions: request.exclusions } : {}),
      });
      if (!started.ok) {
        return { ok: false, error: started.error };
      }
      await emitSidePanelState();
      await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
      void runSidePanelFlow(flowRequest);
      return { ok: true, state: session.getState() };
    }
    case "approve": {
      return handleSidePanelApprove();
    }
    case "refuse": {
      const refused = session.refuse(request.reason);
      if (!refused.ok) {
        return { ok: false, error: refused.error };
      }
      liveSidePanelFlow?.approvalResolver?.({
        approved: false,
        ...(request.reason ? { reason: request.reason } : {}),
      });
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "remove_prepared": {
      if (liveSidePanelFlow || cartReviewMutation) return { ok: false, error: "Une opération est déjà en cours." };
      const progress = session.getCartProgress();
      if (!progress || progress.flowId !== request.flowId || progress.finished || !progress.entries[request.ingredientIndex]) return { ok: false, error: "Ajout du parcours introuvable." };
      cartReviewMutation = true;
      try {
        const gate = new ApprovalGate(() => ({ approved: false }));
        const trace = createTraceBuilder();
        const cart = new ProgressiveCart(progress, new ToolExecutor({ bindings: makeSidePanelBindings(), gate, trace }), gate, trace, checkpointCartProgress);
        await cart.remove(request.ingredientIndex);
        await emitSidePanelState();
        return { ok: true, state: session.getState() };
      } catch (error) {
        await emitSidePanelState();
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally { cartReviewMutation = false; }
    }
    case "cancel_prepared": {
      if (liveSidePanelFlow || cartReviewMutation) return { ok: false, error: "Une opération est encore en cours." };
      const progress = session.getCartProgress();
      if (!progress || progress.flowId !== request.flowId) return { ok: false, error: "Cette révision concerne un ancien parcours." };
      if (progress.finished) return { ok: false, error: "La révision de ce parcours est terminée." };
      cartReviewMutation = true;
      try {
        const gate = new ApprovalGate(() => ({ approved: false }));
        const trace = createTraceBuilder();
        const cart = new ProgressiveCart(progress, new ToolExecutor({ bindings: makeSidePanelBindings(), gate, trace }), gate, trace, checkpointCartProgress);
        for (const entry of progress.entries) {
          if (entry.added > entry.removed) await cart.remove(entry.ingredientIndex);
        }
        const finished = session.finishReview();
        if (!finished.ok) return { ok: false, error: finished.error };
        await writeSidePanelSnapshot();
        await emitSidePanelState();
        return { ok: true, state: session.getState() };
      } catch (error) {
        await emitSidePanelState();
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally { cartReviewMutation = false; }
    }
    case "finish_review": {
      if (liveSidePanelFlow || cartReviewMutation) return { ok: false, error: "Une opération est encore en cours." };
      if (session.getCartProgress()?.flowId !== request.flowId) return { ok: false, error: "Cette révision concerne un ancien parcours." };
      const finished = session.finishReview();
      if (!finished.ok) return { ok: false, error: finished.error };
      await writeSidePanelSnapshot();
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "review_answer": {
      if (session.getCartProgress()?.flowId !== request.flowId) return { ok: false, error: "Ce choix concerne un ancien parcours." };
      if (!liveSidePanelFlow?.reviewResolver) return { ok: false, error: "Parcours interrompu : relance la recette." };
      const answered = session.answerProductReview(request.choices);
      if (!answered.ok) return { ok: false, error: answered.error };
      liveSidePanelFlow.reviewResolver(request.choices);
      liveSidePanelFlow.reviewResolver = undefined;
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "clarify_answer": {
      const answered = session.answerClarification(request.answer);
      if (!answered.ok) {
        return { ok: false, error: answered.error };
      }
      liveSidePanelFlow?.clarificationResolver?.(answered.answer);
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "resume": {
      const progress = session.getCartProgress();
      if (progress && !progress.finished) {
        if (cartReviewMutation || liveSidePanelFlow) return { ok: false, error: "Une opération est déjà en cours." };
        const begun = session.beginProgressiveResume();
        if (!begun.ok) return { ok: false, error: begun.error };
        await emitSidePanelState();
        void runSidePanelFlow(progress.request, progress);
        return { ok: true, state: session.getState() };
      }
      const resume = session.getResume();
      if (!resume) {
        return { ok: false, error: "Aucune reprise disponible." };
      }
      const begun = session.beginResume(resume.preview);
      if (!begun.ok) {
        return { ok: false, error: begun.error };
      }
      await emitSidePanelState();
      void runSidePanelResume(resume);
      return { ok: true, state: session.getState() };
    }
    case "reset_session": {
      if (session.getCartProgress() && !session.getCartProgress()!.finished) return { ok: false, error: "Termine la vérification du panier avant de réinitialiser." };
      session.reset();
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
    case "model_download_consent": {
      if (!request.accepted) {
        return { ok: true, state: session.getState() };
      }
      // The consent IS this request: nothing is fetched without the explicit
      // click that carries it. The download runs with progress events.
      void runSidePanelModelDownload();
      return { ok: true, state: session.getState() };
    }
    case "model_cache_clear": {
      try {
        await sidePanelModelCache.remove(LOCAL_MODEL_MANIFEST);
      } catch (err) {
        return {
          ok: false,
          error: `Impossible de vider le cache du modèle : ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await refreshSidePanelModelState();
      await emitSidePanelState();
      return { ok: true, state: session.getState() };
    }
  }
}

/**
 * The explicit approval event. Two cases:
 *   - the flow is alive in this worker instance: resolve its pending decision;
 *   - only the snapshot survived (MV3 suspension): the click completes the
 *     stored preview through the resume path — the click IS the decision.
 */
async function handleSidePanelApprove(): Promise<SidePanelRequestResult> {
  const session = await loadSidePanelSession();
  const state = session.getState();
  if (liveSidePanelFlow?.approvalResolver) {
    const approved = session.approve();
    if (!approved.ok) {
      return { ok: false, error: approved.error };
    }
    liveSidePanelFlow.approvalResolver({ approved: true });
    await emitSidePanelState();
    return { ok: true, state: session.getState() };
  }
  if (state.pendingApproval) {
    const preview = state.pendingApproval.preview;
    const approved = session.approve();
    if (!approved.ok) {
      return { ok: false, error: approved.error };
    }
    await emitSidePanelState();
    const resume: ShoppingFlowResume = {
      preview,
      pending: preview.lines,
      applied: [],
      failed: undefined,
    };
    void runSidePanelResume(resume, { approvedByClick: true });
    return { ok: true, state: session.getState() };
  }
  return { ok: false, error: "Aucune approbation en attente." };
}

// -- provider construction (explicit only, never a fallback) -----------------

async function buildSidePanelProvider(
  request: ShoppingFlowRequest,
): Promise<{ ok: true; provider: ModelProvider } | { ok: false; error: string }> {
  const providerId = (await loadSidePanelSession()).getState().provider;
  if (providerId === "simulated") {
    return {
      ok: true,
      provider: new SimulatedProvider({
        id: "simulated-sidepanel",
        modelVersion: "simulated-1.0",
        script: buildSimulatedRecipeScript(request),
      }),
    };
  }
  if (providerId === "mistral") {
    const apiKey = await getStoredMistralKey();
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Aucune clé Mistral enregistrée. Renseigne ta clé personnelle dans les réglages (elle n'est jamais affichée en retour).",
      };
    }
    return {
      ok: true,
      provider: createMistralByokProvider({
        apiKey,
        model: (await chrome.storage.session.get(MISTRAL_MODEL_STORAGE_KEY))[MISTRAL_MODEL_STORAGE_KEY] ?? MISTRAL_MODEL_ID,
        fetchImpl: (url, init) => fetch(url, init),
      }),
    };
  }
  if (providerId === "webgpu") {
    const { entry } = await getActiveModel();
    return {
      ok: true,
      provider: createWebGpuProvider({
        modelId: entry.repoId,
        probe: makeOffscreenWebGpuProbe(entry),
        pipelineFactory: makeOffscreenPipelineFactory(entry),
      }),
    };
  }
  return { ok: false, error: "Aucun fournisseur sélectionné." };
}

async function saveMistralConfig(apiKey: string, model: string): Promise<void> {
  const config = { [MISTRAL_KEY_STORAGE_KEY]: apiKey, [MISTRAL_MODEL_STORAGE_KEY]: model };
  await chrome.storage.local.set(config);
  await chrome.storage.session.set(config);
}

async function getStoredMistralKey(): Promise<string | undefined> {
  const stored = (await chrome.storage.session.get(MISTRAL_KEY_STORAGE_KEY)) as Record<
    string,
    unknown
  >;
  const key = stored[MISTRAL_KEY_STORAGE_KEY];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Wraps the selected provider so the recipe becomes visible in the panel as
 * soon as it parses: the flow itself only exposes the recipe in its final
 * result, but the UI journey is demande → recette → recherche → aperçu →
 * approbation. Deterministic: the parse here uses the exact same strict
 * @leclerc/contracts parser the flow uses.
 */
function wrapProviderForRecipeEvents(provider: ModelProvider): ModelProvider {
  let recipeShown = false;
  return {
    id: provider.id,
    modelVersion: provider.modelVersion,
    capabilities: provider.capabilities,
    async generate(request) {
      const response = await provider.generate(request);
      if (!recipeShown && typeof response.text === "string" && response.text !== "") {
        const parsed = parseRecipeText(response.text);
        if (parsed.ok) {
          recipeShown = true;
          void sidePanelRecipeReady(parsed.recipe);
        }
      }
      return response;
    },
  };
}

async function sidePanelRecipeReady(recipe: GeneratedRecipe): Promise<void> {
  const session = await loadSidePanelSession();
  session.markSearching();
  session.appendHistory(
    "assistant",
    "recipe",
    `${recipe.title} — ${recipe.servings} personnes, ${recipe.ingredients.length} ingrédients.`,
    recipe,
  );
  await emitSidePanelEvent({ type: "recipe", recipe });
  await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
  await emitSidePanelState();
}

// -- capability bindings through the existing dispatcher bridge --------------

function bridgeProductToDomain(product: BridgeProduct): DomainProduct {
  const packaging = packagingFromLabel(product.label);
  return {
    id: String(product.id),
    label: product.label,
    price: product.price,
    ...(product.brand !== undefined ? { brand: product.brand } : {}),
    ...(product.pricePerUnit !== undefined ? { pricePerUnit: product.pricePerUnit } : {}),
    ...(product.nutriScore !== undefined ? { nutriScore: product.nutriScore } : {}),
    available: product.available,
    ...(product.imageUrl !== undefined ? { imageUrl: product.imageUrl } : {}),
    ...(packaging ? { packaging } : {}),
  };
}

function bridgeCartToDomain(cart: BridgeCart): DomainCart {
  return {
    items: cart.items.map((item) => ({
      product: bridgeProductToDomain(item.product),
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    itemCount: cart.itemCount,
    total: cart.total,
    storeId: cart.storeId,
  };
}

async function reportSidePanelToolActivity(
  name: string,
  ok: boolean,
  summary: string,
  data?: unknown,
  error?: string,
): Promise<void> {
  const session = await loadSidePanelSession();
  session.appendHistory("assistant", "tool_activity", summary, data);
  await emitSidePanelEvent({
    type: "tool_activity",
    name,
    ok,
    summary,
    ...(error !== undefined ? { error } : {}),
  });
}

/**
 * The three capabilities the shopping flow uses, bound to the SAME dispatcher
 * bridge as the popup. The add_to_cart binding enforces the BLOCKING safety
 * rule: the state machine must permit the mutation BEFORE any request is
 * emitted toward the Leclerc tab.
 */
function makeSidePanelBindings(): ToolBinding[] {
  return [
    bindingFromContract(listHabitualProducts, async () => {
      const result = await runLeclercCommand("list_habitual_products", {});
      if (!result.ok) return toolError("CAPABILITY_FAILED", "Lecture des produits habituels impossible.");
      const products = (result.data as { products?: BridgeProduct[] }).products ?? [];
      await reportSidePanelToolActivity("list_habitual_products", true, `${products.length} produit(s) habituel(s) consulté(s).`);
      return { ok: true as const, output: { products: products.map(bridgeProductToDomain) } };
    }),
    bindingFromContract(searchProduct, async (input: { query: string }) => {
      const result = await runLeclercCommand("search_products", { query: input.query });
      if (!result.ok) {
        void reportSidePanelToolActivity(
          "search_product",
          false,
          `Recherche « ${input.query} » échouée.`,
          undefined,
          result.error,
        );
        return toolError("CAPABILITY_FAILED", `Recherche produit impossible : ${result.error}`);
      }
      const products = (result.data as { products?: BridgeProduct[] }).products ?? [];
      void reportSidePanelToolActivity(
        "search_product",
        true,
        `Recherche « ${input.query} » : ${products.length} produit(s) trouvé(s).`,
        {
          products: products.slice(0, 5).map((p) => ({
            id: p.id,
            label: p.label,
            price: p.price,
            available: p.available,
          })),
        },
      );
      return { ok: true as const, output: { products: products.map(bridgeProductToDomain) } };
    }),
    bindingFromContract(getCart, async () => {
      const result = await runLeclercCommand("get_cart", {});
      if (!result.ok) {
        return toolError("CAPABILITY_FAILED", `Lecture du panier impossible : ${result.error}`);
      }
      const cart = (result.data as { cart?: BridgeCart }).cart;
      if (!cart) {
        return toolError("CAPABILITY_FAILED", "Réponse du pont Leclerc sans panier.");
      }
      return { ok: true as const, output: { cart: bridgeCartToDomain(cart) } };
    }),
    bindingFromContract(updateQuantity, async (input: { productId: string; quantity: number }) => {
      const permitted = (await loadSidePanelSession()).assertMutationPermitted(input.productId, input.quantity);
      if (!permitted.ok) return toolError("APPROVAL_REQUIRED", permitted.message);
      const result = await runLeclercCommand("update_quantity", { product_id: input.productId, quantity: input.quantity });
      if (!result.ok) return toolError("CART_MUTATION_REFUSED", result.error);
      const cart = (result.data as { cart?: BridgeCart }).cart;
      if (!cart) return toolError("CAPABILITY_FAILED", "Réponse sans panier ; résultat à vérifier.");
      return { ok: true as const, output: { cart: bridgeCartToDomain(cart) } };
    }),
    bindingFromContract(addToCart, async (input: { productId: string; quantity: number }) => {
      // BLOCKING SAFETY RULE (state machine, ticket #51): no mutation request
      // may be emitted before the explicit approval event.
      const gate = (await loadSidePanelSession()).assertMutationPermitted();
      if (!gate.ok) {
        return toolError("APPROVAL_REQUIRED", gate.message, { capability: "add_to_cart" });
      }
      const result = await runLeclercCommand("add_to_cart", {
        product_id: input.productId,
        quantity: input.quantity,
      });
      if (!result.ok) {
        void reportSidePanelToolActivity(
          "add_to_cart",
          false,
          `Ajout au panier échoué (${input.productId} × ${input.quantity}).`,
          undefined,
          result.error,
        );
        return toolError("CART_MUTATION_REFUSED", `Ajout au panier refusé : ${result.error}`);
      }
      const cart = (result.data as { cart?: BridgeCart }).cart;
      void reportSidePanelToolActivity(
        "add_to_cart",
        true,
        `Ajouté au panier : ${input.productId} × ${input.quantity}.`,
      );
      return {
        ok: true as const,
        output: {
          cart: cart
            ? bridgeCartToDomain(cart)
            : { items: [], itemCount: 0, total: 0, storeId: "" },
        },
      };
    }),
  ];
}

// -- approval / clarification handlers (answered ONLY by UI events) ----------

function makeResumeApprovalHandler(live: LiveSidePanelFlow): ApprovalDecisionHandler {
  return (request) =>
    new Promise<ApprovalDecision>((resolve) => {
      void (async () => {
        const session = await loadSidePanelSession();
        session.awaitApproval(request.summary);
        await emitSidePanelEvent({
          type: "approval_request",
          summary: request.summary,
          preview: request.preview,
        });
        await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
        await emitSidePanelState();
      })();
      live.approvalResolver = resolve;
    });
}

async function checkpointCartProgress(progress: CartProgress): Promise<void> {
  const session = await loadSidePanelSession();
  session.setCartProgress(progress);
  // Unlike disposable UI updates, this write must succeed before any cart mutation.
  await writeSidePanelSnapshot();
  await emitSidePanelEvent({ type: "state", state: session.getState() });
}

function makeProductReviewHandler(live: LiveSidePanelFlow): ProductReviewHandler {
  return (review) => new Promise((resolve, reject) => {
    live.reviewResolver = resolve;
    void (async () => {
      const session = await loadSidePanelSession();
      session.awaitProductReview(review);
      await emitSidePanelState();
    })().catch(reject);
  });
}

// -- flow runs ----------------------------------------------------------------

async function runSidePanelFlow(request: ShoppingFlowRequest, progress?: CartProgress): Promise<void> {
  const session = await loadSidePanelSession();
  const live: LiveSidePanelFlow = {};
  liveSidePanelFlow = live;
  if (progress?.selection && !progress.selection.complete && progress.selection.decisions.length === 0
    && Object.values(progress.selection.problems).some((reason) => reason.startsWith("Évaluation du modèle indisponible ou invalide"))) {
    progress.selection.evaluationsComplete = false;
  }
  const built = progress?.selection && (progress.selection.complete || progress.selection.evaluationsComplete || progress.selection.round >= 3)
    ? { ok: true as const, provider: new SimulatedProvider({ id: "resume:cart-only", script: [] }) }
    : await buildSidePanelProvider(request);
  if (!built.ok) {
    session.appendHistory("assistant", "error", built.error);
    session.finishFlow("provider_unavailable");
    await emitSidePanelEvent({ type: "error", code: "PROVIDER_UNAVAILABLE", message: built.error });
    await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
    await emitSidePanelState();
    liveSidePanelFlow = undefined;
    return;
  }
  try {
    const result = await runShoppingFlow({
      provider: wrapProviderForRecipeEvents(built.provider),
      bindings: makeSidePanelBindings(),
      request,
      review: makeProductReviewHandler(live),
      progress,
      checkpoint: checkpointCartProgress,
    });
    liveSidePanelFlow = undefined;
    await finishSidePanelFlow(result);
  } catch (err) {
    liveSidePanelFlow = undefined;
    await failSidePanelFlow(
      `Échec inattendu du parcours : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runSidePanelResume(
  resume: ShoppingFlowResume,
  options: { approvedByClick?: boolean } = {},
): Promise<void> {
  const live: LiveSidePanelFlow = {};
  liveSidePanelFlow = live;
  try {
    const result = await resumeShoppingFlow({
      bindings: makeSidePanelBindings(),
      resume,
      // A resume NEVER inherits the previous approval: either the user goes
      // through a fresh explicit approval round, or (post-suspension) the
      // approve click that triggered this run IS the decision.
      approval:
        options.approvedByClick === true
          ? () => ({ approved: true })
          : makeResumeApprovalHandler(live),
    });
    liveSidePanelFlow = undefined;
    await finishSidePanelFlow(result);
  } catch (err) {
    liveSidePanelFlow = undefined;
    await failSidePanelFlow(
      `Échec inattendu de la reprise : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function toFlowResultPayload(result: ShoppingFlowResult): FlowResultPayload {
  return {
    status: result.status,
    ...(result.recipe ? { recipe: result.recipe } : {}),
    ...(result.preview ? { preview: result.preview } : {}),
    issues: result.issues,
    ...(result.gap ? { gap: result.gap } : {}),
    ...(result.cart ? { cart: result.cart } : {}),
    ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    ...(result.proposal ? { proposal: result.proposal } : {}),
    ...(result.error ? { error: result.error } : {}),
    resumeAvailable: result.resume !== undefined,
  };
}

function flowResultSummary(result: ShoppingFlowResult): string {
  if (result.progress) {
    const entries = result.progress.entries;
    const confirmed = entries.filter((entry) => entry.added > entry.removed).length;
    const failed = entries.filter((entry) => entry.status === "failed").length;
    const unknown = entries.filter((entry) => entry.status === "verification_pending").length;
    const remaining = entries.filter((entry) => ["searching", "verifying", "choice_needed"].includes(entry.status)).length;
    return `${confirmed} ajout(s) confirmé(s), ${failed} échec(s), ${unknown} résultat(s) à vérifier, ${remaining} ingrédient(s) restant(s). ${result.error?.message ?? "Vérifie le panier rempli puis termine la vérification."}`;
  }
  switch (result.status) {
    case "completed":
      return `Parcours terminé : ${result.gap?.applied.length ?? result.preview?.lines.length ?? 0} article(s) ajouté(s) au panier.`;
    case "partial_failure": {
      if (result.error && !result.gap) return `${result.error.message} Aucun ajout confirmé ; ${result.recipe?.ingredients.length ?? 0} ingrédient(s) restant(s) à traiter.`;
      const applied = result.gap?.applied.length ?? 0;
      const failed = result.gap?.failed.length ?? 0;
      const notAttempted = result.gap?.notAttempted.length ?? 0;
      return `Échec partiel : ${applied} ajouté(s), ${failed} en échec, ${notAttempted} non tenté(s). Reprendre relira le panier pour éviter les doublons.`;
    }
    case "recipe_invalid":
      return result.error?.message ?? "Recette invalide : aucune recherche ni mutation du panier n'a été effectuée.";
    case "provider_unavailable":
      return result.diagnostic ?? "Fournisseur indisponible : le parcours n'a pas démarré.";
    case "limits_exceeded":
      return result.error?.message ?? "Budget d'appels épuisé : parcours interrompu.";
    case "cancelled":
      return "Parcours annulé.";
    default:
      return "Parcours terminé sans ajout au panier.";
  }
}

async function finishSidePanelFlow(result: ShoppingFlowResult): Promise<void> {
  const session = await loadSidePanelSession();
  const payload = toFlowResultPayload(result);
  if (result.progress) session.setCartProgress(result.progress);
  if (result.status === "partial_failure" && result.resume) {
    session.setResume(result.resume);
  }
  if (result.status !== "refused") {
    // The refusal already logged its own history entry (refuse()).
    session.appendHistory("assistant", "flow_result", flowResultSummary(result), payload);
  }
  session.finishFlow(result.status);
  await emitSidePanelEvent({ type: "flow_result", result: payload });
  await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
  await emitSidePanelState();
}

async function failSidePanelFlow(message: string): Promise<void> {
  const session = await loadSidePanelSession();
  session.appendHistory("assistant", "error", message);
  session.finishFlow("provider_unavailable");
  await emitSidePanelEvent({ type: "error", code: "FLOW_FAILED", message });
  await emitSidePanelEvent({ type: "phase", phase: session.getState().phase });
  await emitSidePanelState();
}

// -- local model: offscreen WebGPU adapters (probe + raw generation) ---------

/**
 * The local model runs in the offscreen document — the only extension context
 * with WebGPU access (service workers have no navigator.gpu). The probe goes
 * through the existing offscreen_status path: the pipeline creation there
 * instantiates a REAL ONNX WebGPU session (well beyond navigator.gpu
 * presence), with allowWasmFallback false — no CPU/WASM fallback exists on
 * the side panel path. A failure surfaces the diagnostic and the Mistral
 * proposal; nothing else is launched.
 */
function makeOffscreenWebGpuProbe(entry: ModelEntry): WebGpuProbe {
  return async () => {
    try {
      await ensureOffscreen();
      const res = (await chrome.runtime.sendMessage({
        type: "offscreen_status",
        modelId: entry.id,
        repoId: entry.repoId,
        dtype: entry.dtype,
        device: "webgpu",
        allowWasmFallback: false,
      } satisfies OffscreenStatusMsg)) as OffscreenStatusResultMsg | undefined;
      if (res?.type === "offscreen_status_result" && res.status === "ready") {
        return { ok: true };
      }
      return {
        ok: false,
        reason:
          res?.error ?? "la session WebGPU du modèle local n'a pas pu être créée dans le document offscreen",
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Raw text generation through the offscreen document (see offscreen_generate). */
function makeOffscreenPipelineFactory(entry: ModelEntry): WebGpuPipelineFactory {
  return async () => {
    await ensureOffscreen();
    return {
      async generate(input) {
        const res = (await chrome.runtime.sendMessage({
          type: "offscreen_generate",
          prompt: buildSidePanelPrompt(input.messages),
          modelId: entry.id,
          repoId: entry.repoId,
          dtype: entry.dtype,
          device: "webgpu",
          ...(input.maxTokens !== undefined ? { maxNewTokens: input.maxTokens } : {}),
        } satisfies OffscreenGenerateMsg)) as OffscreenGenerateResultMsg | undefined;
        if (res?.type === "offscreen_generate_result" && res.ok && typeof res.text === "string") {
          return { text: res.text };
        }
        throw new Error(res?.error ?? "Le document offscreen n'a pas répondu à la génération.");
      },
    } satisfies WebGpuPipeline;
  };
}

// -- local model: manifest-verified cache + download consent ------------------

function modelCacheUrl(manifest: ModelManifest, path: string): string {
  const base = manifest.sourceUrl.endsWith("/") ? manifest.sourceUrl : `${manifest.sourceUrl}/`;
  return `${base}${path}`;
}

/**
 * CacheStorage-backed ModelCacheStore (the #52 pipeline commit target).
 * `put` only ever receives a complete, verified file set; `current` checks
 * presence without loading file bodies into memory.
 */
const sidePanelModelCache: ModelCacheStore = {
  async get(manifest) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const files: CachedModelFile[] = [];
    for (const declared of manifest.files) {
      const response = await cache.match(modelCacheUrl(manifest, declared.path));
      if (!response) return undefined;
      files.push({ path: declared.path, bytes: await response.arrayBuffer() });
    }
    return { manifest, files };
  },
  async put(manifest, files) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const file of files) {
      await cache.put(modelCacheUrl(manifest, file.path), new Response(file.bytes));
    }
  },
  async remove(manifest) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const declared of manifest.files) {
      await cache.delete(modelCacheUrl(manifest, declared.path));
    }
  },
  async current() {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const declared of LOCAL_MODEL_MANIFEST.files) {
      if (!(await cache.match(modelCacheUrl(LOCAL_MODEL_MANIFEST, declared.path)))) {
        return undefined;
      }
    }
    return {
      modelId: LOCAL_MODEL_MANIFEST.modelId,
      revision: LOCAL_MODEL_MANIFEST.revision,
      sizeBytes: LOCAL_MODEL_MANIFEST.totalSizeBytes,
    };
  },
};

async function refreshSidePanelModelState(): Promise<void> {
  const session = await loadSidePanelSession();
  const model: SidePanelModelState = {
    cacheState: "absent",
    modelId: LOCAL_MODEL_MANIFEST.modelId,
    sizeBytes: LOCAL_MODEL_MANIFEST.totalSizeBytes,
  };
  try {
    const current = await sidePanelModelCache.current();
    if (current) {
      model.cacheState = "ready";
    }
  } catch (err) {
    model.lastError = `Cache du modèle illisible : ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    // Bundled artifacts (dist/extension/models) are what the offscreen runtime
    // actually loads — the preferred, fully offline path.
    const { entry } = await getActiveModel();
    const res = await fetch(
      chrome.runtime.getURL(`models/${entry.repoId}/onnx/model_${entry.dtype}.onnx`),
      { method: "HEAD" },
    );
    model.bundledReady = res.ok;
  } catch {
    model.bundledReady = false;
  }
  session.setModelState(model);
  await persistSidePanelSession();
}

async function runSidePanelModelDownload(): Promise<void> {
  const session = await loadSidePanelSession();
  session.setModelState({
    cacheState: "downloading",
    modelId: LOCAL_MODEL_MANIFEST.modelId,
    sizeBytes: LOCAL_MODEL_MANIFEST.totalSizeBytes,
  });
  await emitSidePanelState();
  const result = await downloadModel({
    manifest: LOCAL_MODEL_MANIFEST,
    fetchImpl: (url, init) => fetch(url, init),
    // The explicit consent already happened: the model_download_consent
    // request IS the user's click. Nothing is ever fetched without it.
    consent: () => true,
    cache: sidePanelModelCache,
    hashBytes: async (bytes) => {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    onProgress: (progress) => {
      void (async () => {
        const s = await loadSidePanelSession();
        s.setModelState({
          cacheState: "downloading",
          modelId: progress.modelId,
          sizeBytes: progress.totalSizeBytes,
          progress: {
            file: progress.file,
            totalBytes: progress.totalBytes,
            totalSizeBytes: progress.totalSizeBytes,
          },
        });
        await emitSidePanelState();
      })();
    },
  });
  const final = await loadSidePanelSession();
  if (result.ok) {
    final.appendHistory(
      "assistant",
      "message",
      `Modèle local téléchargé et vérifié (${(LOCAL_MODEL_MANIFEST.totalSizeBytes / 1_000_000).toFixed(0)} Mo, manifeste validé).`,
    );
    await refreshSidePanelModelState();
  } else {
    final.setModelState({
      cacheState: "absent",
      modelId: LOCAL_MODEL_MANIFEST.modelId,
      sizeBytes: LOCAL_MODEL_MANIFEST.totalSizeBytes,
      lastError: result.message,
    });
  }
  await emitSidePanelState();
}

// -- side panel keep-alive ----------------------------------------------------

// The side panel holds a runtime Port and pings every 20 s while it is open.
// Each received message resets the MV3 idle timer, so a flow waiting for the
// explicit approval (the only long wait) survives Chrome's ~30 s service
// worker idle termination.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDEPANEL_KEEPALIVE_PORT) return;
  port.onMessage.addListener((msg: unknown) => {
    if ((msg as { type?: unknown } | undefined)?.type === "sidepanel_ping") {
      port.postMessage({ type: "sidepanel_pong" });
    }
  });
});
