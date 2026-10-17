/**
 * Offscreen model runtime — the only place `@huggingface/transformers` runs.
 *
 * Loaded by extension/offscreen/offscreen.html. Configures Transformers.js to
 * load the bundled, offline model from `chrome.runtime.getURL("models/")`, picks
 * WebGPU when available and falls back to WASM CPU otherwise, then answers
 * `offscreen_orchestrate` messages by running the text-generation pipeline and
 * parsing its JSON output into a validated {@link Plan}.
 *
 * The model NEVER produces product ids: it only normalizes explicit shopping
 * list entries into purchasable `{ query, quantity, constraints?, notes? }`
 * items. It must not infer ingredients from recipe or dish names. The popup
 * resolves real product ids via `search_products` afterwards, and mutations
 * only run after the user clicks *Valider*.
 */

import {
  env,
  pipeline,
  type TextGenerationPipeline,
} from "@huggingface/transformers";

import { parsePlan, type Plan } from "../../src/orchestrator/plan.js";
import { buildMessages, buildPrompt } from "../../src/orchestrator/prompt.js";
import {
  MAX_NEW_TOKENS,
} from "../../src/orchestrator/models.js";

// The active model id + device are NOT read from chrome.storage here:
// offscreen documents have no chrome.storage access. The background owns
// the choice and forwards modelId + device in every offscreen_* message.
import type {
  OffscreenOrchestrateMsg,
  OffscreenOrchestrateResultMsg,
  OffscreenStatusMsg,
  OffscreenToBackgroundMsg,
  OrchestrationDebug,
} from "../../src/orchestrator/messages.js";

// ---- Transformers.js env: bundled, offline, no remote fetch ----------------

env.allowRemoteModels = false;
env.allowLocalModels = true;
// chrome.runtime.getURL is available in the offscreen document context.
env.localModelPath = chrome.runtime.getURL("models/");

// onnxruntime-web ships its own .wasm + proxy .mjs binaries; point ORT at the
// copies vendored under dist/extension/ort-wasm/ by the build so it never
// reaches out to a CDN (and works fully offline in the extension).
//
// Force a single WASM thread. ORT otherwise picks a multi-threaded runtime when
// SharedArrayBuffer is available, and Chrome Canary/macOS can crash natively
// during that setup from an extension offscreen document.
const ortWasm = (env.backends as {
  onnx?: { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
}).onnx?.wasm;
if (ortWasm) {
  ortWasm.wasmPaths = chrome.runtime.getURL("ort-wasm/");
  ortWasm.numThreads = 1;
  ortWasm.proxy = false;
}

// ---- pipeline singleton (keyed by modelId+device) -----------------------
// The background owns the model choice (chrome.storage has no access in an
// offscreen document); every offscreen_* message carries modelId + device,
// and the pipeline is rebuilt whenever either changes (popup model switch).

let generatorPromise: Promise<TextGenerationPipeline> | null = null;
let activeGeneratorKey: string | null = null;
let activeDevice: "webgpu" | "wasm" = "wasm";
let device: "webgpu" | "wasm" = "wasm";

async function getGenerator(
  modelId: string,
  repoId: string,
  dtype: string,
  requestedDevice: "webgpu" | "wasm",
  allowWasmFallback: boolean,
): Promise<TextGenerationPipeline> {
  const key = `${modelId}|${repoId}|${dtype}|${requestedDevice}|${allowWasmFallback ? "fallback" : "strict"}`;
  if (
    generatorPromise &&
    activeGeneratorKey === key &&
    activeDevice === requestedDevice
  ) {
    return generatorPromise;
  }
  activeGeneratorKey = key;
  activeDevice = requestedDevice;
  generatorPromise = createGenerator(repoId, dtype, requestedDevice, allowWasmFallback).catch((err) => {
    generatorPromise = null;
    activeGeneratorKey = null;
    throw err;
  });
  return generatorPromise;
}

async function createGenerator(
  repoId: string,
  dtype: string,
  requestedDevice: "webgpu" | "wasm",
  allowWasmFallback: boolean,
): Promise<TextGenerationPipeline> {
  device = requestedDevice;
  try {
    return await pipeline("text-generation", repoId, {
      dtype,
      device,
    }) as TextGenerationPipeline;
  } catch (err) {
    if (device === "webgpu" && allowWasmFallback) {
      console.warn(
        "[mcp-leclerc-drive] WebGPU init failed, fallback WASM :",
        err,
      );
      device = "wasm";
      activeDevice = "wasm";
      return await pipeline("text-generation", repoId, {
        dtype,
        device,
      }) as TextGenerationPipeline;
    }
    throw err;
  }
}

// ---- message handler ------------------------------------------------------
// The system prompt + buildPrompt live in the pure, chrome-free module
// `src/orchestrator/prompt.ts` so they can be shared verbatim with the Node
// inference tests (`tests/model-inference.test.ts`).

chrome.runtime.onMessage.addListener(
  (
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (resp: OffscreenToBackgroundMsg) => void,
  ) => {
    if (typeof msg !== "object" || msg === null) return false;
    const type = (msg as { type?: unknown }).type;

    if (type === "offscreen_status") {
      const {
        modelId,
        repoId,
        dtype,
        device: reqDevice,
        allowWasmFallback = true,
      } = msg as OffscreenStatusMsg;
      // Pre-warm + report readiness without running generation.
      void getGenerator(modelId, repoId, dtype, reqDevice, allowWasmFallback)
        .then(() =>
          sendResponse({
            type: "offscreen_status_result",
            status: "ready",
            device,
          }),
        )
        .catch((err: unknown) =>
          sendResponse({
            type: "offscreen_status_result",
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    if (type !== "offscreen_orchestrate") return false;
    const {
      text,
      traceId,
      modelId,
      repoId,
      dtype,
      promptFormat = "text",
      device: reqDevice,
      allowWasmFallback = true,
    } = msg as OffscreenOrchestrateMsg;
    void run(text, modelId, repoId, dtype, promptFormat, reqDevice, allowWasmFallback, traceId)
      .then(({ plan, debug }) =>
        sendResponse({ type: "offscreen_orchestrate_result", ok: true, plan, debug }),
      )
      .catch((err: unknown) => {
        const rawOutput = getErrorRawOutput(err);
        const debug: OrchestrationDebug = {
          traceId,
          modelId,
          repoId,
          dtype,
          promptFormat,
          device,
          input: text,
          rawOutput,
          error: err instanceof Error ? err.message : String(err),
        };
        console.error("[mcp-leclerc-drive][offscreen] orchestrate failed", debug);
        sendResponse({
          type: "offscreen_orchestrate_result",
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          debug,
        });
      });
    return true;
  },
);

async function run(
  userText: string,
  modelId: string,
  repoId: string,
  dtype: string,
  promptFormat: "text" | "chat",
  reqDevice: "webgpu" | "wasm",
  allowWasmFallback: boolean,
  traceId?: string,
): Promise<{ plan: Plan; debug: OrchestrationDebug }> {
  if (!userText || !userText.trim()) {
    throw new Error("Demande vide.");
  }
  const generator = await getGenerator(modelId, repoId, dtype, reqDevice, allowWasmFallback);
  const prompt = promptFormat === "chat" ? buildMessages(userText) : buildPrompt(userText);
  console.info("[mcp-leclerc-drive][offscreen] model input", {
    traceId,
    modelId,
    repoId,
    dtype,
    promptFormat,
    device,
    userText,
  });
  const output = await generator(prompt, {
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
    return_full_text: false,
    tokenizer_encode_kwargs: {
      enable_thinking: false,
    },
  });
  const text = extractGeneratedText(output);
  console.info("[mcp-leclerc-drive][offscreen] raw model output", {
    traceId,
    rawOutput: text,
  });
  const parsed = parsePlan(text);
  if (!parsed.ok) {
    const err = new Error(parsed.error) as Error & { rawOutput?: string };
    err.rawOutput = text;
    throw err;
  }
  const debug: OrchestrationDebug = {
    traceId,
    modelId,
    repoId,
    dtype,
    promptFormat,
    device,
    source: "model",
    input: userText,
    rawOutput: text,
    parsedPlan: parsed.plan,
  };
  console.info("[mcp-leclerc-drive][offscreen] parsed plan", debug);
  return { plan: parsed.plan, debug };
}

function getErrorRawOutput(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const rawOutput = (err as { rawOutput?: unknown }).rawOutput;
    if (typeof rawOutput === "string") return rawOutput;
  }
  return undefined;
}

/** Transformers.js text-generation output can be a string[] or message-like. */
function extractGeneratedText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const gen = (first as { generated_text?: unknown; generated_text_2?: unknown }).generated_text;
      if (typeof gen === "string") return gen;
      if (Array.isArray(gen)) {
        const last = gen[gen.length - 1] as { content?: unknown } | undefined;
        if (last && typeof last.content === "string") return last.content;
      }
    }
  }
  return String(output);
}

// No top-level pre-warm here: the background creates this document only for an
// explicit user action, and every message carries the active modelId + device.
