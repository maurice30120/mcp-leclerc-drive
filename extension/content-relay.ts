/**
 * Content relay — isolated-world content script bridging the extension
 * messaging bus to the MAIN-world Leclerc bridge via `window.postMessage`.
 *
 * Why isolated world: the MAIN-world `inject.ts` has no access to `chrome.*`,
 * and the popup/background have no access to the page's window. This relay
 * (declared in the manifest as a content script with `world: "ISOLATED"`)
 * is the only context that can speak both: it receives
 * `chrome.runtime.onMessage` from the background and forwards to the page via
 * `window.postMessage`, then forwards the bridge's reply back over
 * `chrome.runtime`.
 *
 * Each request is correlated by `requestId` with a timeout, so a Leclerc tab
 * that never replies (navigated away, crashed) doesn't hang the popup forever.
 */

import { RequestCorrelator } from "../src/orchestrator/correlator.js";
import {
  isLeclercResponse,
  isRecipeStorageRequest,
  type LeclercRequest,
  type LeclercResponse,
  type RelayLeclercRunMsg,
  type RecipeStorageRequest,
  type RecipeStorageResponse,
} from "../src/orchestrator/messages.js";

const RELAY_TIMEOUT_MS = 12000;
const RELAY_SOURCE = "mcp-leclerc-drive:relay";
const BRIDGE_SOURCE = "mcp-leclerc-drive:bridge";

const correlator = new RequestCorrelator<LeclercResponse>({
  defaultTimeoutMs: RELAY_TIMEOUT_MS,
});

// ---- page → extension: forward bridge responses to pending requests --------

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isLeclercResponse(event.data)) return;
  if (event.data.source !== BRIDGE_SOURCE) return;
  correlator.resolve(event.data.requestId, event.data);
});

// ---- page → extension: forward bridge recipe-storage requests ---------------

// The recipe MCP tools run in the MAIN world and have no chrome.* access;
// their storage calls (captures, personal library, digest) travel the other
// way through this relay: bridge posts a RecipeStorageRequest on the window,
// we forward it to the background over chrome.runtime and post the
// correlated response back on the window.

import { RECIPE_STORAGE_RESPONSE_SOURCE as STORAGE_RESPONSE_SOURCE } from "../src/orchestrator/messages.js";

function forwardStorageRequest(request: RecipeStorageRequest): void {
  void chrome.runtime
    .sendMessage({ type: "recipe_storage_request", request })
    .then((reply: unknown) => {
      const r = reply as { type?: string; response?: RecipeStorageResponse };
      const response: RecipeStorageResponse =
        r?.type === "recipe_storage_result" && r.response
          ? r.response
          : {
              source: STORAGE_RESPONSE_SOURCE,
              requestId: request.requestId,
              ok: false,
              error: "Réponse du service worker inattendue.",
            };
      window.postMessage(response, location.origin);
    })
    .catch((err: unknown) => {
      window.postMessage(
        {
          source: STORAGE_RESPONSE_SOURCE,
          requestId: request.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        location.origin,
      );
    });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isRecipeStorageRequest(event.data)) return;
  forwardStorageRequest(event.data);
});

// ---- extension → page: relay LeclercRequest and await the bridge reply -----

chrome.runtime.onMessage.addListener(
  (
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (resp: { type: "leclerc_result"; response: LeclercResponse }) => void,
  ) => {
    if (
      typeof msg !== "object" ||
      msg === null ||
      (msg as { type?: unknown }).type !== "leclerc_request"
    ) {
      return false;
    }
    const { request } = msg as RelayLeclercRunMsg;
    void forward(request)
      .then((response) => sendResponse({ type: "leclerc_result", response }))
      .catch((err: unknown) => {
        const response: LeclercResponse = {
          source: BRIDGE_SOURCE,
          requestId: request.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        sendResponse({ type: "leclerc_result", response });
      });
    // Keep the message channel open for the async sendResponse above.
    return true;
  },
);

async function forward(request: LeclercRequest): Promise<LeclercResponse> {
  // Only post to a Leclerc origin — the bridge is installed on Leclerc tabs
  // only, and posting to the wrong origin would be a no-op anyway.
  if (!location.hostname.endsWith(".leclercdrive.fr")) {
    return {
      source: BRIDGE_SOURCE,
      requestId: request.requestId,
      ok: false,
      error:
        "L'onglet actif n'est pas sur un drive Leclerc (host " +
        location.hostname +
        "). Ouvre ton drive Leclerc dans un onglet puis réessaie.",
    };
  }
  const pending = correlator.register(request.requestId, RELAY_TIMEOUT_MS);
  window.postMessage({ ...request, source: RELAY_SOURCE }, location.origin);
  return pending;
}
