/**
 * Typed message contracts shared between the popup, the background service
 * worker, the offscreen model document, the isolated-world content relay and
 * the MAIN-world Leclerc bridge.
 *
 * Everything that crosses an extension boundary (popup ↔ background ↔ offscreen,
 * background ↔ content relay, content relay ↔ MAIN bridge) is one of these
 * shapes, so a typo in a string literal can never desync the pipeline.
 *
 * Pure types + tiny guards only — no runtime dependencies, safe to bundle into
 * every extension context and to unit-test in Node.
 */

// ---- Leclerc command channel (relay ↔ MAIN bridge) ------------------------

/**
 * A command the orchestrator asks the live Leclerc tab to run.
 * `requestId` correlates the request with its response across the
 * postMessage / chrome.runtime hop.
 */
export interface LeclercRequest {
  /** Channel marker, always `"mcp-leclerc-drive:relay"`. */
  source: "mcp-leclerc-drive:relay";
  requestId: string;
  command: LeclercCommandName;
  args: Record<string, unknown>;
}

/** Successful response to a {@link LeclercRequest}. */
export interface LeclercOkResponse {
  /** Channel marker, always `"mcp-leclerc-drive:bridge"`. */
  source: "mcp-leclerc-drive:bridge";
  requestId: string;
  ok: true;
  data: unknown;
}

/** Failure response to a {@link LeclercRequest}. */
export interface LeclercErrResponse {
  source: "mcp-leclerc-drive:bridge";
  requestId: string;
  ok: false;
  error: string;
}

export type LeclercResponse = LeclercOkResponse | LeclercErrResponse;

/** Discriminator: is a window MessageEvent payload a relay request? */
export function isLeclercRequest(data: unknown): data is LeclercRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "mcp-leclerc-drive:relay" &&
    typeof (data as { requestId?: unknown }).requestId === "string" &&
    typeof (data as { command?: unknown }).command === "string" &&
    (data as { args?: unknown }).args !== null &&
    typeof (data as { args?: unknown }).args === "object"
  );
}

/** Discriminator: is a window MessageEvent payload a bridge response? */
export function isLeclercResponse(data: unknown): data is LeclercResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "mcp-leclerc-drive:bridge" &&
    typeof (data as { requestId?: unknown }).requestId === "string" &&
    typeof (data as { ok?: unknown }).ok === "boolean"
  );
}

// ---- Leclerc command vocabulary -------------------------------------------

export const READ_COMMANDS = [
  "search_products",
  "get_cart",
  "get_store",
] as const;

export const MUTATION_COMMANDS = [
  "add_to_cart",
  "update_quantity",
  "remove_from_cart",
] as const;

export type ReadCommand = (typeof READ_COMMANDS)[number];
export type MutationCommand = (typeof MUTATION_COMMANDS)[number];
export type LeclercCommandName = ReadCommand | MutationCommand;

export function isReadCommand(name: string): name is ReadCommand {
  return (READ_COMMANDS as readonly string[]).includes(name);
}

export function isMutationCommand(name: string): name is MutationCommand {
  return (MUTATION_COMMANDS as readonly string[]).includes(name);
}

export function isLeclercCommand(name: string): name is LeclercCommandName {
  return isReadCommand(name) || isMutationCommand(name);
}

// ---- Popup ↔ background messages ------------------------------------------

export interface OrchestrateRequestMsg {
  type: "orchestrate";
  /** Correlates popup, background and offscreen logs for one planning run. */
  traceId?: string;
  /** Explicit shopping list or direct grocery request from the user. */
  text: string;
}

export interface LeclercRunMsg {
  type: "leclerc_run";
  /** Optional debug correlation id propagated from the popup. */
  traceId?: string;
  command: LeclercCommandName;
  args: Record<string, unknown>;
}

export interface LeclercRunResultMsg {
  type: "leclerc_run_result";
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ModelStatusMsg {
  type: "model_status";
  status: "idle" | "loading" | "ready" | "error";
  modelId?: string;
  detail?: string;
}

export interface ModelStatusRequestMsg {
  type: "model_status";
}

/** Ask the background to recreate the offscreen document (e.g. after toggling WebGPU). */
export interface ReloadOffscreenMsg {
  type: "reload_offscreen";
}

/** Ask the background to switch the active model (persists + reloads offscreen). */
export interface SetModelMsg {
  type: "set_model";
  modelId: string;
}

/** Result of a {@link SetModelMsg} (also returned for `reload_offscreen`). */
export interface ReloadOffscreenResultMsg {
  type: "reload_offscreen_result";
  ok: boolean;
  modelId?: string;
  device?: string;
  error?: string;
}

export type PopupToBackgroundMsg =
  | OrchestrateRequestMsg
  | LeclercRunMsg
  | ModelStatusRequestMsg
  | ReloadOffscreenMsg
  | SetModelMsg;

export type BackgroundToPopupMsg = LeclercRunResultMsg | ModelStatusMsg;

// ---- Background ↔ offscreen messages --------------------------------------

export interface OffscreenOrchestrateMsg {
  type: "offscreen_orchestrate";
  traceId?: string;
  text: string;
  /** Active picker/storage model id (background-owned; offscreen has no chrome.storage). */
  modelId: string;
  /** Transformers.js repo id. */
  repoId: string;
  /** ONNX dtype to load. */
  dtype: string;
  /** Prompt shape to send to Transformers.js. */
  promptFormat: "text" | "chat";
  /** Resolved device for this model. */
  device: "webgpu" | "wasm";
  /** Whether WebGPU init may fall back to WASM for this model. */
  allowWasmFallback?: boolean;
}

export interface OffscreenOrchestrateResultMsg {
  type: "offscreen_orchestrate_result";
  ok: boolean;
  plan?: unknown;
  error?: string;
  debug?: OrchestrationDebug;
}

export interface OrchestrationDebug {
  traceId?: string;
  modelId?: string;
  repoId?: string;
  dtype?: string;
  promptFormat?: string;
  device?: string;
  source?: "model" | "deterministic";
  input: string;
  rawOutput?: string;
  parsedPlan?: unknown;
  error?: string;
}

export interface OffscreenStatusMsg {
  type: "offscreen_status";
  /** Active picker/storage model id (background-owned; offscreen has no chrome.storage). */
  modelId: string;
  /** Transformers.js repo id. */
  repoId: string;
  /** ONNX dtype to load. */
  dtype: string;
  /** Resolved device for this model. */
  device: "webgpu" | "wasm";
  /** Whether WebGPU init may fall back to WASM for this model. */
  allowWasmFallback?: boolean;
}

export interface OffscreenStatusResultMsg {
  type: "offscreen_status_result";
  status: "loading" | "ready" | "error";
  device?: string;
  error?: string;
}

export type BackgroundToOffscreenMsg = OffscreenOrchestrateMsg | OffscreenStatusMsg;
export type OffscreenToBackgroundMsg =
  | OffscreenOrchestrateResultMsg
  | OffscreenStatusResultMsg;

// ---- Background ↔ content relay messages ----------------------------------

export interface RelayLeclercRunMsg {
  type: "leclerc_request";
  request: LeclercRequest;
}

export interface RelayLeclercResultMsg {
  type: "leclerc_result";
  response: LeclercResponse;
}

export type BackgroundToRelayMsg = RelayLeclercRunMsg;
export type RelayToBackgroundMsg = RelayLeclercResultMsg;
