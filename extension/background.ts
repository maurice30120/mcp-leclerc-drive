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
  MODEL_DTYPE,
  findModel,
} from "../src/orchestrator/models.js";

const LECRERC_URL_FILTER = {
  url: [{ hostSuffix: "leclercdrive.fr" }],
};

// inject.js installs @mcp-b/global (document.modelContext runtime) and our 9
// tools; embed.js then opens the WebSocket to the local relay and forwards
// those tools as first-class MCP tools. Both are injected into the page's
// MAIN world — inject.js first so embed.js sees a ready document.modelContext.
// MAIN-world scripts have no access to chrome.* APIs, so anything chrome-*
// (including the relay embed) must be driven through this list ordering.
const INJECT_FILES = ["inject.js", "embed.js"];

// Isolated-world content relay (one file, declared as a content script in the
// manifest too, but also injected dynamically so it lands on already-open tabs
// without a reload). It speaks chrome.runtime on one side and window.postMessage
// (to the MAIN bridge) on the other.
const RELAY_FILES = ["content-relay.js"];

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !isLeclercUrl(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: INJECT_FILES,
    });
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
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: INJECT_FILES,
        });
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

// -- active model + device (background-owned; offscreen has no storage) ----

async function getActiveModel(): Promise<{ modelId: string; device: "webgpu" | "wasm" }> {
  const v = await chrome.storage.local.get(["modelId", "webgpu"]);
  const modelId = (v as { modelId?: string }).modelId ?? DEFAULT_MODEL_ID;
  const entry = findModel(modelId);
  // `webgpu` storage flag is a manual override independent of the model's
  // recommended device: explicit `true` forces WebGPU, explicit `false` (and
  // unset) forces WASM. WASM is the default because WebGPU crashes the Chrome
  // GPU process on some macOS setups (EXC_BREAKPOINT in the compositor).
  const override = (v as { webgpu?: boolean }).webgpu;
  const device = override === true ? "webgpu" : "wasm";
  return { modelId: entry.id, device };
}

// -- model status -----------------------------------------------------------

async function handleModelStatus(): Promise<ModelStatusMsg> {
  try {
    const { modelId, device } = await getActiveModel();
    const existing = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (!existing) {
      return {
        type: "model_status",
        status: "idle",
        modelId,
        detail: `device=${device}`,
      };
    }
    const res = await chrome.runtime.sendMessage({
      type: "offscreen_status",
      modelId,
      device,
    } satisfies OffscreenStatusMsg);
    const r = res as OffscreenStatusResultMsg | undefined;
    if (r?.type === "offscreen_status_result") {
      return {
        type: "model_status",
        status: r.status === "ready" ? "ready" : r.status === "error" ? "error" : "loading",
        modelId,
        detail: r.device ? `device=${r.device}` : r.error,
      };
    }
    return { type: "model_status", status: "loading", modelId };
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
  await ensureOffscreen();
  const { modelId, device } = await getActiveModel();
  console.info("[mcp-leclerc-drive][background] orchestrate request", {
    traceId: msg.traceId,
    text: msg.text,
    modelId,
    device,
  });
  const res = await chrome.runtime.sendMessage({
    type: "offscreen_orchestrate",
    traceId: msg.traceId,
    text: msg.text,
    modelId,
    device,
  } satisfies OffscreenOrchestrateMsg);
  console.info("[mcp-leclerc-drive][background] orchestrate response", {
    traceId: msg.traceId,
    response: res,
  });
  return res as OffscreenOrchestrateResultMsg;
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
    const { modelId, device } = await getActiveModel();
    return {
      type: "reload_offscreen_result",
      ok: true,
      modelId,
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
