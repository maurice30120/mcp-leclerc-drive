/**
 * Catalogue of local orchestrator models (ONNX, Transformers.js-compatible).
 *
 * One family is kept:
 *   - **onnx-community/Qwen3-0.6B-*-ONNX** — the reference Transformers.js repos
 *     (single-file `onnx/model_<dtype>.onnx` layout, loaded by the offscreen
 *     `text-generation` pipeline).
 *
 * NOTE: `huggingworld/Qwen3.5-*-ONNX` was considered but is incompatible —
 * those repos are multimodal VL models (`Qwen3_5ForConditionalGeneration`,
 * sharded `decoder_model_merged_q4f16.onnx` + `vision_encoder` +
 * `embed_tokens`, no `onnx/model_q4f16.onnx`) that the text-generation
 * pipeline cannot load, so they are deliberately excluded.
 *
 * The popup renders a picker ordered by parameter count (lightest → heaviest).
 * The background persists the chosen id in `chrome.storage.local.modelId`
 * (default = the smallest stable model) and forwards it to the
 * offscreen document — offscreen docs have NO access to `chrome.storage`, so
 * the device + model id always travel inside the message, never read from
 * storage there.
 *
 * `device` is the recommended compute target; a manual `webgpu` storage flag
 * (toggle in the popup) overrides it. WebGPU can still crash the browser
 * process on some Chrome/GPU combos — if it does, uncheck WebGPU to force WASM.
 *
 * NOTE: `onnx-community/Qwen3-1.7B-ONNX` was tested with q4/q4f16 and excluded:
 * q4f16 fails ONNX Runtime WASM session creation, and q4 can crash Chrome
 * natively on macOS during model execution. Keep it out of the picker until
 * the browser/ORT stack is stable enough.
 *
 * NOTE: `onnx-community/Qwen3-0.6B-Instruct-ONNX` is also excluded from the
 * active picker. With the explicit shopping-list prompt it repeatedly drifts
 * into meta-prose or copies examples instead of returning the products the user
 * wrote, so it is not reliable enough for the cart workflow.
 *
 * NOTE: `onnx-community/Qwen3-4B-ONNX` was considered but is excluded — its
 * repo historically shipped only a stub `onnx/model_q4f16.onnx` (~59MB, no
 * real weights, restructured for ORT GenAI) that the text-generation pipeline
 * cannot use, so it is not offered in the picker.
 */

export type DevicePref = "webgpu" | "wasm" | "auto";
export type ModelDtype = "q4" | "q4f16";
export type PromptFormat = "text" | "chat";

export interface ModelEntry {
  /** Stable picker/storage id. May include a variant suffix. */
  id: string;
  /** Hugging Face repo id, also the Transformers.js model id. */
  repoId: string;
  /** Short label for the picker. */
  label: string;
  /** Parameter count in billions, for ordering + display. */
  paramsB: number;
  /** Approximate on-disk size of the selected ONNX weight, in GB. */
  sizeGb: number;
  /** ONNX quantization dtype to request from Transformers.js. */
  dtype: ModelDtype;
  /** Prompt shape sent to the text-generation pipeline. */
  promptFormat: PromptFormat;
  /** Recommended device; `auto` = WebGPU if available else WASM. */
  device: DevicePref;
  /** True if a given device is sensible for this model size. */
  supportsWasm: boolean;
}

/** Ordered lightest → heaviest. */
export const MODELS: readonly ModelEntry[] = [
  {
    id: "onnx-community/Qwen3-0.6B-ONNX",
    repoId: "onnx-community/Qwen3-0.6B-ONNX",
    label: "Qwen3 0.6B — fiable Transformers.js",
    paramsB: 0.6,
    sizeGb: 0.86,
    dtype: "q4",
    promptFormat: "text",
    device: "auto",
    supportsWasm: true,
  },
  {
    id: "onnx-community/Qwen3-0.6B-ONNX:q4f16-webgpu",
    repoId: "onnx-community/Qwen3-0.6B-ONNX",
    label: "Qwen3 0.6B q4f16 — WebGPU expérimental",
    paramsB: 0.6,
    sizeGb: 0.55,
    dtype: "q4f16",
    promptFormat: "chat",
    device: "webgpu",
    supportsWasm: false,
  },
] as const;

/** Default model = the smallest stable model. */
export const DEFAULT_MODEL_ID: string =
  "onnx-community/Qwen3-0.6B-ONNX";

// q4 is the default because q4f16 graphs fail to create an ONNX Runtime WASM
// session in Chrome with float16/float tensor mismatches.
export const MODEL_DTYPE = "q4" as const;
export const MAX_NEW_TOKENS = 192;

export function findModel(id: string | undefined | null): ModelEntry {
  const m = MODELS.find((e) => e.id === id);
  if (m) return m;
  // Fall back to the default so a stale stored id never picks a broken model.
  return findModel(DEFAULT_MODEL_ID);
}

/** Resolve a concrete device for the offscreen pipeline. */
export function resolveDevice(
  entry: ModelEntry,
  webgpuAvailable: boolean,
): "webgpu" | "wasm" {
  switch (entry.device) {
    case "wasm":
      return "wasm";
    case "webgpu":
      return "webgpu";
    case "auto":
    default:
      return webgpuAvailable ? "webgpu" : "wasm";
  }
}
