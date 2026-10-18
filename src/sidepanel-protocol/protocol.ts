/**
 * Side panel protocol (ticket #51) — the pure, node-testable seam between the
 * Chrome side panel UI and the background service worker.
 *
 * Three things live here and nowhere else:
 *
 *   1. The typed message vocabulary: requests the panel sends (get_state,
 *      set_provider, set_mistral_key, delete_mistral_key, start_flow, approve,
 *      refuse, clarify_answer, resume, reset_session, model_download_consent,
 *      model_cache_clear, model_status) and events the background pushes back
 *      (state, phase, recipe, preview, approval_request, clarification,
 *      tool_activity, flow_result, error). Everything crosses one envelope
 *      shape guarded by isSidePanelRequestEnvelope / isSidePanelEventEnvelope,
 *      so a typo in a string literal can never desync the pipeline.
 *
 *   2. The SESSION STATE MACHINE (SidePanelSession): provider selection is
 *      EXPLICIT (no default provider), flow phases are
 *      idle → generating → searching → preview → awaiting_approval → mutating
 *      → done/error, and the BLOCKING safety rule lives here: NO mutation can
 *      be permitted before the explicit approval event. The background's
 *      add_to_cart binding consults assertMutationPermitted() before any
 *      mutation request is emitted toward the Leclerc tab.
 *
 *   3. The conversation history is session-only: it lives in the SidePanelSession
 *      snapshot that the background persists in chrome.storage.session (MV3
 *      suspension survival, cleared when the browser closes) and NEVER in
 *      chrome.storage.local. The Mistral API key itself never crosses this
 *      module — only the boolean mistralKeySet does.
 *
 * Purity: no chrome.*, no Node, no fetch at module scope. The offscreen raw-
 * generation message types (offscreen_generate) are also declared here because
 * they are part of the same protocol surface (side panel flow → background →
 * offscreen WebGPU runtime).
 */

import type {
  CartProgress,
  ProductReview,
  ProductReviewChoice,
  ClarificationAnswer,
  ClarificationQuestion,
  CartPreview,
  ProviderMessage,
  ProviderProposal,
  ShoppingFlowIssue,
  ShoppingFlowResume,
  ShoppingOutcomeStatus,
} from "@leclerc/agent";
import type { Cart, GeneratedRecipe } from "@leclerc/contracts";

// ---- channel markers --------------------------------------------------------

export const SIDEPANEL_REQUEST_CHANNEL = "mcp-leclerc-drive:sidepanel";
export const SIDEPANEL_EVENT_CHANNEL = "mcp-leclerc-drive:sidepanel-event";

/**
 * Name of the runtime Port the side panel holds open. The panel pings every
 * 20 s while it is open; each received message resets the MV3 service-worker
 * idle timer, so a flow waiting for the explicit approval survives Chrome's
 * 30 s idle termination.
 */
export const SIDEPANEL_KEEPALIVE_PORT = "mcp-leclerc-drive:sidepanel-keepalive";

// ---- providers (explicit selection only, never defaulted) -------------------

export type SidePanelProviderId = "simulated" | "webgpu" | "mistral";

/** Flow phases of one session, as shown in the side panel header. */
export type SidePanelPhase =
  | "idle"
  | "generating"
  | "searching"
  | "preview"
  | "awaiting_approval"
  | "mutating"
  | "reviewing"
  | "done"
  | "error";

export type SidePanelHistoryKind =
  | "message"
  | "recipe"
  | "preview"
  | "approval"
  | "review"
  | "clarification"
  | "tool_activity"
  | "flow_result"
  | "error";

/**
 * One entry of the conversation thread. `data` carries the structured payload
 * (recipe, preview, clarification question, search results…) so the thread can
 * be rebuilt from the state alone; `text` is always a readable French line.
 * Labels coming from the Leclerc catalogue are untrusted: the UI must render
 * them as inert text, never as HTML.
 */
export interface SidePanelHistoryEntry {
  role: "user" | "assistant";
  kind: SidePanelHistoryKind;
  text: string;
  /** Optional structured payload (JSON-serializable, catalogue data untrusted). */
  data?: unknown;
  /** ISO timestamp. */
  at: string;
}

/** Model cache / download status shown in the side panel settings. */
export interface SidePanelModelState {
  /** Runtime-download cache of the manifest-verified model (ticket #52 pipeline). */
  cacheState: "unknown" | "absent" | "downloading" | "ready";
  /** Whether the model artifacts bundled in the extension (models/**) are present. */
  bundledReady?: boolean;
  /** Manifest model id, when known. */
  modelId?: string;
  /** Manifest-declared total size, in bytes. */
  sizeBytes?: number;
  /** Current download progress, while cacheState is "downloading". */
  progress?: { file: string; totalBytes: number; totalSizeBytes: number };
  /** Last model-related error, if any. */
  lastError?: string;
}

/** Everything the panel renders from: settings + conversation + pending asks. */
export interface SidePanelState {
  /** Explicitly selected provider, or "none" until the user picks one. */
  provider: SidePanelProviderId | "none";
  phase: SidePanelPhase;
  /** True when a Mistral key is stored. The key itself is NEVER in the state. */
  mistralKeySet: boolean;
  history: SidePanelHistoryEntry[];
  /** Pending global approval, shown with the Approuver/Refuser buttons. */
  pendingApproval?: { summary: string; preview: CartPreview };
  /** Pending clarification question, shown with the candidate buttons. */
  pendingClarification?: ClarificationQuestion;
  pendingReview?: ProductReview;
  cartProgress?: CartProgress;
  /** Whether a resume of an interrupted run is available. */
  resumeAvailable: boolean;
  /** True while a flow run is in progress (in this service worker instance). */
  flowActive: boolean;
  model: SidePanelModelState;
}

// ---- requests (panel → background) -------------------------------------------

export type SidePanelRequest =
  | { type: "get_state" }
  | { type: "set_provider"; providerId: SidePanelProviderId }
  | { type: "set_mistral_key"; apiKey: string }
  | { type: "delete_mistral_key" }
  | { type: "start_flow"; message: string; servings: number; exclusions?: string[] }
  | { type: "approve" }
  | { type: "refuse"; reason?: string }
  | { type: "clarify_answer"; answer: ClarificationAnswer }
  | { type: "remove_prepared"; flowId: string; ingredientIndex: number }
  | { type: "finish_review"; flowId: string }
  | { type: "cancel_prepared"; flowId: string }
  | { type: "review_answer"; flowId: string; choices: ProductReviewChoice[] }
  | { type: "resume" }
  | { type: "reset_session" }
  | { type: "model_download_consent"; accepted: boolean }
  | { type: "model_cache_clear" }
  | { type: "model_status" };

export interface SidePanelRequestEnvelope {
  channel: typeof SIDEPANEL_REQUEST_CHANNEL;
  request: SidePanelRequest;
}

/** Typed response to any request: a result object, never a thrown exception. */
export type SidePanelRequestResult =
  | { ok: true; state?: SidePanelState }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isClarificationAnswer(value: unknown): value is ClarificationAnswer {
  if (!isObject(value)) return false;
  if (value.skip === true) return true;
  return isNonEmptyString(value.productId);
}

function isSidePanelRequest(value: unknown): value is SidePanelRequest {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "get_state":
    case "delete_mistral_key":
    case "approve":
    case "resume":
    case "reset_session":
    case "model_cache_clear":
    case "model_status":
      return true;
    case "set_provider":
      return (
        value.providerId === "simulated" || value.providerId === "webgpu" || value.providerId === "mistral"
      );
    case "set_mistral_key":
      return isNonEmptyString(value.apiKey);
    case "start_flow": {
      const servings = value.servings;
      if (!isNonEmptyString(value.message)) return false;
      if (typeof servings !== "number" || !Number.isInteger(servings) || servings < 1) return false;
      const exclusions = value.exclusions;
      if (exclusions !== undefined) {
        if (!Array.isArray(exclusions) || !exclusions.every(isNonEmptyString)) return false;
      }
      return true;
    }
    case "refuse":
      return value.reason === undefined || typeof value.reason === "string";
    case "finish_review":
    case "cancel_prepared":
      return isNonEmptyString(value.flowId);
    case "remove_prepared":
      return isNonEmptyString(value.flowId) && Number.isSafeInteger(value.ingredientIndex) && Number(value.ingredientIndex) >= 0;
    case "review_answer":
      return isNonEmptyString(value.flowId) && Array.isArray(value.choices) && value.choices.every((choice) => isObject(choice)
        && Number.isInteger(choice.ingredientIndex)
        && ((choice.skip === true && choice.productId === undefined) || (isNonEmptyString(choice.productId) && choice.skip === undefined))
        && (choice.quantity === undefined || (Number.isSafeInteger(choice.quantity) && Number(choice.quantity) >= 1 && Number(choice.quantity) <= 999)));
    case "clarify_answer":
      return isClarificationAnswer(value.answer);
    case "model_download_consent":
      return typeof value.accepted === "boolean";
    default:
      return false;
  }
}

/** Discriminator: is a runtime message a side panel request envelope? */
export function isSidePanelRequestEnvelope(value: unknown): value is SidePanelRequestEnvelope {
  return (
    isObject(value) &&
    value.channel === SIDEPANEL_REQUEST_CHANNEL &&
    isSidePanelRequest(value.request)
  );
}

// ---- events (background → panel) ----------------------------------------------

/** The flow result as shown to the user (the full trace stays in the worker). */
export interface FlowResultPayload {
  status: ShoppingOutcomeStatus;
  recipe?: GeneratedRecipe;
  preview?: CartPreview;
  issues: ShoppingFlowIssue[];
  gap?: {
    applied: unknown[];
    failed: Array<{ line: unknown; error: unknown }>;
    notAttempted: unknown[];
  };
  cart?: Cart;
  /** French diagnostic when the provider could not run. */
  diagnostic?: string;
  /** Consent-only alternative provider proposal — plain data, never called. */
  proposal?: ProviderProposal;
  error?: { code: string; message: string };
  resumeAvailable: boolean;
}

export type SidePanelEvent =
  | { type: "state"; state: SidePanelState }
  | { type: "phase"; phase: SidePanelPhase; detail?: string }
  | { type: "recipe"; recipe: GeneratedRecipe }
  | { type: "preview"; preview: CartPreview }
  | { type: "approval_request"; summary: string; preview: CartPreview }
  | { type: "clarification"; question: ClarificationQuestion }
  | { type: "tool_activity"; name: string; ok: boolean; summary: string; error?: string }
  | { type: "flow_result"; result: FlowResultPayload }
  | { type: "error"; code: string; message: string };

export interface SidePanelEventEnvelope {
  channel: typeof SIDEPANEL_EVENT_CHANNEL;
  event: SidePanelEvent;
}

const SIDE_PANEL_EVENT_TYPES = [
  "state",
  "phase",
  "recipe",
  "preview",
  "approval_request",
  "clarification",
  "tool_activity",
  "flow_result",
  "error",
] as const;

/** Discriminator: is a runtime message a side panel event envelope? */
export function isSidePanelEventEnvelope(value: unknown): value is SidePanelEventEnvelope {
  return (
    isObject(value) &&
    value.channel === SIDEPANEL_EVENT_CHANNEL &&
    isObject(value.event) &&
    (SIDE_PANEL_EVENT_TYPES as readonly unknown[]).includes(value.event.type)
  );
}

// ---- offscreen raw generation (side panel local model path) --------------------

/**
 * Raw text generation request to the offscreen document (the only context with
 * WebGPU access). The prompt is a plain string built by buildSidePanelPrompt;
 * the offscreen pipeline runs with the pinned deterministic parameters.
 */
export interface OffscreenGenerateMsg {
  type: "offscreen_generate";
  /** Fully built plain-text prompt (system/user/assistant turns). */
  prompt: string;
  /** Active picker/storage model id (background-owned). */
  modelId: string;
  /** Transformers.js repo id. */
  repoId: string;
  /** ONNX dtype to load. */
  dtype: string;
  /** WebGPU-exclusive for the side panel flow — no CPU/WASM fallback. */
  device: "webgpu" | "wasm";
  /** Generation token budget. */
  maxNewTokens?: number;
  /** Optional correlation id for logs. */
  traceId?: string;
}

export interface OffscreenGenerateResultMsg {
  type: "offscreen_generate_result";
  ok: boolean;
  text?: string;
  device?: string;
  error?: string;
}

// ---- session snapshot (chrome.storage.session payload) ------------------------

export const SESSION_SNAPSHOT_FORMAT_VERSION = 1 as const;

export interface SidePanelSessionSnapshot {
  formatVersion: number;
  provider: SidePanelProviderId | "none";
  phase: SidePanelPhase;
  mistralKeySet: boolean;
  mutationApproved: boolean;
  flowActive: boolean;
  history: SidePanelHistoryEntry[];
  pendingApproval?: { summary: string; preview: CartPreview };
  pendingClarification?: ClarificationQuestion;
  pendingReview?: ProductReview;
  cartProgress?: CartProgress;
  resume?: ShoppingFlowResume;
}

// ---- the session state machine -------------------------------------------------

export type SessionMutationCheck =
  | { ok: true }
  | { ok: false; code: "APPROVAL_REQUIRED"; message: string };

export type SessionResult = { ok: true } | { ok: false; error: string };

const MUTATION_BLOCKED_MESSAGE =
  "Mutation refusée : aucune autorisation valide pour cette référence et cette quantité.";

/**
 * The session state machine of the side panel.
 *
 * The background drives it through the observable steps of the shopping flow
 * and persists serialize() into chrome.storage.session after every transition,
 * so the conversation, the phase and a pending approval survive a service
 * worker suspension. The BLOCKING rule of the slice lives here:
 * assertMutationPermitted() only returns ok after the explicit approval event
 * (approve()), and the approval never carries over to a next flow.
 */
export class SidePanelSession {
  private provider: SidePanelProviderId | "none" = "none";
  private phase: SidePanelPhase = "idle";
  private mistralKeySet = false;
  private mutationApproved = false;
  private flowActive = false;
  private history: SidePanelHistoryEntry[] = [];
  private pendingApproval: { summary: string; preview: CartPreview } | undefined;
  private pendingClarification: ClarificationQuestion | undefined;
  private pendingReview: ProductReview | undefined;
  private cartProgress: CartProgress | undefined;
  private resume: ShoppingFlowResume | undefined;
  private modelState: SidePanelModelState = { cacheState: "unknown" };
  private lastPreview: CartPreview | undefined;

  getState(): SidePanelState {
    return {
      provider: this.provider,
      phase: this.phase,
      mistralKeySet: this.mistralKeySet,
      history: [...this.history],
      ...(this.pendingApproval ? { pendingApproval: { ...this.pendingApproval } } : {}),
      ...(this.pendingClarification ? { pendingClarification: this.pendingClarification } : {}),
      ...(this.pendingReview ? { pendingReview: this.pendingReview } : {}),
      ...(this.cartProgress ? { cartProgress: this.cartProgress } : {}),
      resumeAvailable: this.resume !== undefined || !!(this.cartProgress && !this.cartProgress.finished && (this.cartProgress.intent || this.cartProgress.entries.some((entry) => ["failed", "verification_pending", "searching", "verifying", "choice_needed"].includes(entry.status)))),
      flowActive: this.flowActive,
      model: this.modelState,
    };
  }

  // -- settings ------------------------------------------------------------

  selectProvider(providerId: SidePanelProviderId): SessionResult {
    if (this.flowActive) {
      return {
        ok: false,
        error: "Un parcours est en cours : le fournisseur ne peut pas changer maintenant.",
      };
    }
    this.provider = providerId;
    return { ok: true };
  }

  /** The API key itself never enters the machine — only this boolean does. */
  setMistralKeySet(present: boolean): void {
    this.mistralKeySet = present;
  }

  setModelState(model: SidePanelModelState): void {
    this.modelState = model;
  }

  // -- flow lifecycle --------------------------------------------------------

  startFlow(request: { message: string; servings: number; exclusions?: string[] }): SessionResult {
    if (this.cartProgress && !this.cartProgress.finished) return { ok: false, error: "Termine la vérification du panier précédent ou reprends ce parcours." };
    if (this.flowActive) {
      return { ok: false, error: "Un parcours est déjà en cours." };
    }
    if (!isNonEmptyString(request.message)) {
      return { ok: false, error: "La demande est vide." };
    }
    if (typeof request.servings !== "number" || !Number.isInteger(request.servings) || request.servings < 1) {
      return { ok: false, error: "Le nombre de convives doit être un entier ≥ 1." };
    }
    if (request.exclusions !== undefined) {
      if (!Array.isArray(request.exclusions) || !request.exclusions.every(isNonEmptyString)) {
        return { ok: false, error: "Les exclusions doivent être des libellés non vides." };
      }
    }
    if (this.provider === "none") {
      return {
        ok: false,
        error: "Sélectionne d'abord un fournisseur (scénario simulé, modèle local WebGPU ou Mistral).",
      };
    }
    this.phase = "generating";
    this.flowActive = true;
    this.mutationApproved = false;
    this.pendingApproval = undefined;
    this.pendingClarification = undefined;
    this.pendingReview = undefined;
    this.resume = undefined;
    this.lastPreview = undefined;
    this.cartProgress = undefined;
    this.appendHistory("user", "message", request.message.trim());
    return { ok: true };
  }

  /** Recipe parsed and accepted: the deterministic searches start. */
  markSearching(): void {
    if (this.phase !== "generating") {
      throw new Error(`Transition invalide : markSearching attendu en phase generating (phase=${this.phase}).`);
    }
    this.phase = "searching";
  }

  /** Cart preview computed: shown before the approval request. */
  presentPreview(preview: CartPreview): void {
    if (this.phase !== "searching") {
      throw new Error(`Transition invalide : presentPreview attendu en phase searching (phase=${this.phase}).`);
    }
    this.phase = "preview";
    this.lastPreview = preview;
    this.appendHistory("assistant", "preview", `Aperçu du panier : ${preview.lines.length} article(s), total ${preview.total.toFixed(2)} €.`, preview);
  }

  /** Global approval request: the only door to the mutations opens here. */
  awaitApproval(summary: string): void {
    if (this.phase !== "preview") {
      throw new Error(`Transition invalide : awaitApproval attendu en phase preview (phase=${this.phase}).`);
    }
    this.phase = "awaiting_approval";
    if (!this.lastPreview) {
      throw new Error("awaitApproval sans aperçu présenté.");
    }
    this.pendingApproval = { summary, preview: this.lastPreview };
    this.appendHistory("assistant", "approval", summary, this.lastPreview);
  }

  /**
   * The explicit approval event. This is the ONLY transition that permits
   * mutations; the returned preview is what the user approved.
   */
  approve(): { ok: true; preview: CartPreview } | { ok: false; error: string } {
    if (this.phase !== "awaiting_approval" || !this.pendingApproval) {
      return { ok: false, error: "Aucune approbation en attente." };
    }
    const approved = this.pendingApproval;
    this.pendingApproval = undefined;
    this.mutationApproved = true;
    this.phase = "mutating";
    return { ok: true, preview: approved.preview };
  }

  /** The explicit refusal: the flow stops, the cart stays untouched. */
  refuse(reason?: string): SessionResult {
    if (this.phase !== "awaiting_approval") {
      return { ok: false, error: "Aucune approbation en attente." };
    }
    this.pendingApproval = undefined;
    this.mutationApproved = false;
    this.flowActive = false;
    this.phase = "idle";
    this.appendHistory(
      "assistant",
      "flow_result",
      reason ? `Ajout au panier refusé (${reason}) : aucun article n'a été ajouté.` : "Ajout au panier refusé : aucun article n'a été ajouté.",
    );
    return { ok: true };
  }

  /**
   * Progressive writes require the exact durable intent. Historical snapshots
   * retain their explicit approval gate. Bindings consult this before dispatch.
   */
  assertMutationPermitted(productId?: string, quantity?: number): SessionMutationCheck {
    const progress = this.cartProgress;
    const intent = progress?.intent;
    if (progress && !progress.finished && intent && intent.productId === productId && intent.target === quantity) return { ok: true };
    if (this.mutationApproved) return { ok: true };
    return { ok: false, code: "APPROVAL_REQUIRED", message: MUTATION_BLOCKED_MESSAGE };
  }

  // -- clarification -----------------------------------------------------------

  /** A deterministic matching ambiguity is asked to the user. */
  awaitClarification(question: ClarificationQuestion): void {
    if (this.phase !== "searching") {
      throw new Error(`Transition invalide : awaitClarification attendu en phase searching (phase=${this.phase}).`);
    }
    this.pendingClarification = question;
    this.appendHistory("assistant", "clarification", question.message, question);
  }

  /** The user's explicit answer to the pending clarification. */
  answerClarification(answer: ClarificationAnswer): { ok: true; answer: ClarificationAnswer } | { ok: false; error: string } {
    if (!this.pendingClarification) {
      return { ok: false, error: "Aucune clarification en attente." };
    }
    if (!isClarificationAnswer(answer)) {
      return { ok: false, error: "Réponse de clarification invalide." };
    }
    this.pendingClarification = undefined;
    this.pendingReview = undefined;
    return { ok: true, answer };
  }

  setCartProgress(progress: CartProgress): void {
    if (this.cartProgress && this.cartProgress.flowId !== progress.flowId && !this.cartProgress.finished) throw new Error("Un autre panier est encore en révision.");
    this.cartProgress = progress;
  }

  getCartProgress(): CartProgress | undefined { return this.cartProgress; }

  beginProgressiveResume(): SessionResult {
    if (this.flowActive || !this.cartProgress || this.cartProgress.finished) return { ok: false, error: "Reprise indisponible." };
    this.flowActive = true;
    this.phase = "searching";
    this.pendingReview = undefined;
    return { ok: true };
  }

  finishReview(): SessionResult {
    if (this.flowActive || !this.cartProgress || this.cartProgress.intent) return { ok: false, error: "Une vérification ou une mutation reste en attente." };
    this.cartProgress.finished = true;
    this.phase = "done";
    return { ok: true };
  }

  awaitProductReview(review: ProductReview): void {
    if (this.phase !== "searching" || this.pendingReview) throw new Error("Révision des choix indisponible.");
    this.pendingReview = review;
    this.appendHistory("assistant", "review", "Vérifie les choix et les ingrédients incertains.", review);
  }

  answerProductReview(choices: ProductReviewChoice[]): SessionResult {
    const review = this.pendingReview;
    if (!review || !isSidePanelRequest({ type: "review_answer", flowId: this.cartProgress?.flowId ?? "legacy-review", choices })) return { ok: false, error: "Révision invalide ou absente." };
    if (choices.length !== review.items.length || review.items.some((item) => {
      const matches = choices.filter((choice) => choice.ingredientIndex === item.ingredientIndex);
      if (matches.length !== 1) return true;
      const choice = matches[0];
      if (choice.skip) return false;
      const product = item.candidates.find((candidate) => candidate.productId === choice.productId);
      return !product || (product.quantityNote !== undefined && choice.quantity === undefined);
    })) return { ok: false, error: "Choisis un produit et sa quantité, ou passe chaque ingrédient." };
    this.pendingReview = undefined;
    return { ok: true };
  }

  // -- termination + resume ------------------------------------------------------

  /** Terminal transition after the flow result arrives. */
  finishFlow(status: ShoppingOutcomeStatus): void {
    this.flowActive = false;
    this.mutationApproved = false;
    this.pendingApproval = undefined;
    this.pendingClarification = undefined;
    this.pendingReview = undefined;
    if (this.cartProgress && !this.cartProgress.finished) {
      this.phase = "reviewing";
    } else if (status === "refused" || status === "cancelled") {
      this.phase = "idle";
    } else if (status === "completed") {
      this.phase = "done";
      this.resume = undefined;
    } else {
      this.phase = "error";
    }
  }

  /**
   * Re-enter the preview → approval journey for a resume run (the previous
   * approval never carries over: a FRESH explicit approval is required before
   * any further mutation). Only valid while a resume object is stored.
   */
  beginResume(preview: CartPreview): SessionResult {
    if (this.resume === undefined) {
      return { ok: false, error: "Aucune reprise disponible." };
    }
    if (this.flowActive) {
      return { ok: false, error: "Un parcours est déjà en cours." };
    }
    this.phase = "preview";
    this.flowActive = true;
    this.mutationApproved = false;
    this.pendingApproval = undefined;
    this.pendingClarification = undefined;
    this.pendingReview = undefined;
    this.lastPreview = preview;
    this.appendHistory(
      "assistant",
      "preview",
      `Aperçu du panier : ${preview.lines.length} article(s), total ${preview.total.toFixed(2)} €.`,
      preview,
    );
    return { ok: true };
  }

  /** Stored resume object of an interrupted (partial failure) run. */
  setResume(resume: ShoppingFlowResume): void {
    this.resume = resume;
  }

  getResume(): ShoppingFlowResume | undefined {
    return this.resume;
  }

  clearResume(): void {
    this.resume = undefined;
  }

  // -- history -------------------------------------------------------------------

  appendHistory(role: "user" | "assistant", kind: SidePanelHistoryKind, text: string, data?: unknown): void {
    this.history.push({
      role,
      kind,
      text,
      ...(data !== undefined ? { data } : {}),
      at: new Date().toISOString(),
    });
  }

  /** New conversation: history and flow cleared; settings (provider) kept. */
  reset(): void {
    this.history = [];
    this.phase = "idle";
    this.flowActive = false;
    this.mutationApproved = false;
    this.pendingApproval = undefined;
    this.pendingClarification = undefined;
    this.pendingReview = undefined;
    this.resume = undefined;
    this.lastPreview = undefined;
  }

  // -- snapshot (chrome.storage.session payload) ----------------------------------

  serialize(): SidePanelSessionSnapshot {
    return {
      formatVersion: SESSION_SNAPSHOT_FORMAT_VERSION,
      provider: this.provider,
      phase: this.phase,
      mistralKeySet: this.mistralKeySet,
      mutationApproved: this.mutationApproved,
      flowActive: this.flowActive,
      history: [...this.history],
      ...(this.pendingApproval ? { pendingApproval: this.pendingApproval } : {}),
      ...(this.pendingClarification ? { pendingClarification: this.pendingClarification } : {}),
      ...(this.pendingReview ? { pendingReview: this.pendingReview } : {}),
      ...(this.cartProgress ? { cartProgress: this.cartProgress } : {}),
      ...(this.resume ? { resume: this.resume } : {}),
    };
  }

  static restore(snapshot: SidePanelSessionSnapshot): SidePanelSession {
    if (!isObject(snapshot) || snapshot.formatVersion !== SESSION_SNAPSHOT_FORMAT_VERSION) {
      throw new Error("Instantané de session sidepanel de format inconnu.");
    }
    const session = new SidePanelSession();
    session.provider = snapshot.provider;
    session.phase = snapshot.phase;
    session.mistralKeySet = snapshot.mistralKeySet === true;
    session.mutationApproved = snapshot.mutationApproved === true;
    session.flowActive = snapshot.flowActive === true;
    session.history = Array.isArray(snapshot.history) ? [...snapshot.history] : [];
    session.pendingApproval = snapshot.pendingApproval;
    session.pendingClarification = snapshot.pendingClarification;
    session.pendingReview = snapshot.pendingReview;
    session.cartProgress = snapshot.cartProgress;
    session.resume = snapshot.resume;
    return session;
  }
}

// ---- prompt builder for the offscreen raw-generation path ----------------------

/**
 * Deterministic plain-text prompt from provider messages, for Transformers.js
 * pipelines that ship without a chat template (same shape as the existing
 * buildPrompt of the shopping-list path). The previous assistant answers are
 * replayed in order so the single guided repair round sees the conversation.
 */
export function buildSidePanelPrompt(messages: readonly ProviderMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(`SYSTEM:\n${message.content}`);
    } else if (message.role === "user") {
      parts.push(`USER:\n${message.content}`);
    } else if (message.role === "assistant") {
      parts.push(`ASSISTANT:\n${message.content}`);
    } else {
      // Tool messages never occur in the recipe flow; kept as inert data.
      parts.push(`TOOL:\n${message.content}`);
    }
  }
  parts.push("ASSISTANT:");
  return parts.join("\n\n");
}

// ---- simulated provider script (offline demo of the full journey) ---------------

const SIMULATED_BASE_INGREDIENTS = [
  { name: "filets de poulet", quantity: 800, unit: "g" },
  { name: "lait de coco", quantity: 400, unit: "ml" },
  { name: "poudre de curry", quantity: 20, unit: "g" },
  { name: "riz basmati", quantity: 400, unit: "g" },
  { name: "oignons", quantity: 2, unit: "pièce" },
  { name: "ail", quantity: 2, unit: "gousse" },
  { name: "gingembre frais", quantity: 30, unit: "g" },
] as const;

const SIMULATED_STEPS = [
  "Émincer les oignons et l'ail, râper le gingembre.",
  "Faire revenir les filets de poulet dans une cocotte avec un filet d'huile, 5 minutes.",
  "Ajouter les oignons, l'ail et le gingembre, puis la poudre de curry ; faire revenir 2 minutes.",
  "Verser le lait de coco, couvrir et laisser mijoter 20 minutes.",
  "Servir avec le riz basmati.",
] as const;

function foldExclusion(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Scripted recipe steps for the SimulatedProvider: a deterministic, offline
 * recipe that satisfies the strict @leclerc/contracts parser and honours the
 * requested servings and exclusions. Two steps are scripted (initial
 * generation + the single guided repair round, which returns the same valid
 * recipe). This exists so the FULL journey — recipe → real searches →
 * preview → approval → real cart — can be exercised on a Leclerc tab without
 * any model; it is never used unless the user explicitly selects the
 * simulated provider.
 */
export function buildSimulatedRecipeScript(request: {
  message: string;
  servings: number;
  exclusions?: string[];
}): Array<{ text: string }> {
  const exclusions = (request.exclusions ?? []).map(foldExclusion);
  let ingredients: Array<{ name: string; quantity: number; unit: string }> =
    SIMULATED_BASE_INGREDIENTS.filter(
      (ingredient) => !exclusions.some((excluded) => foldExclusion(ingredient.name).includes(excluded)),
    ).map((ingredient) => ({ name: ingredient.name, quantity: ingredient.quantity, unit: ingredient.unit }));
  if (ingredients.length === 0) {
    ingredients = [{ name: "légumes de saison", quantity: 500, unit: "g" }];
  }
  const recipe = {
    title: `Recette simulée — ${request.message.trim().slice(0, 80)}`,
    servings: request.servings,
    ingredients: ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
    })),
    steps: [...SIMULATED_STEPS],
    prepMinutes: 15,
    cookMinutes: 30,
    category: "plat principal",
  };
  const text = JSON.stringify(recipe);
  return [{ text }, { text }];
}
