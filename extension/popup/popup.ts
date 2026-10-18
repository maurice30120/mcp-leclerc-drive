/**
 * Popup UI controller — the user-facing surface of the local-model orchestrator.
 *
 * Flow:
 *   1. On open, render immediately without loading the local model. The model
 *      is loaded only when the user asks to plan a list.
 *   2. User types an explicit shopping list → *Préparer* → background →
 *      offscreen model → validated Plan.
 *   3. For each plan item, the popup runs `search_products` (via background →
 *      content relay → MAIN bridge) and shows candidates. The user picks a
 *      product + quantity per item.
 *   4. *Valider* sends `add_to_cart` mutations — and ONLY then. Before
 *      validation, no cart line is touched (read-only searches excluded).
 *
 * Product labels returned by Leclerc are rendered as inert text (textContent),
 * never as HTML, so a malicious label cannot inject markup or scripts.
 */

import type { Plan, PlanItem } from "../../src/orchestrator/plan.js";
import type {
  BackgroundToPopupMsg,
  LeclercRunMsg,
  OrchestrateRequestMsg,
  ReloadOffscreenMsg,
  ReloadOffscreenResultMsg,
  SetModelMsg,
  OrchestrationDebug,
} from "../../src/orchestrator/messages.js";
import {
  MODELS,
  DEFAULT_MODEL_ID,
  findModel,
} from "../../src/orchestrator/models.js";
import {
  BYOK_PROVIDERS,
  findByokProvider,
} from "../../src/orchestrator/byok.js";
import type { Product } from "../../src/types.js";
import {
  addToCartCallsForSelections,
  searchCallsForPlan,
} from "../../src/orchestrator/workflow.js";

// ---- DOM refs --------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const statusEl = $<HTMLParagraphElement>("model-status");
const promptEl = $<HTMLTextAreaElement>("prompt");
const planBtn = $<HTMLButtonElement>("plan-btn");
const planError = $<HTMLParagraphElement>("plan-error");
const planSection = $<HTMLElement>("plan-section");
const questionsEl = $<HTMLElement>("questions");
const itemsEl = $<HTMLElement>("items");
const validateBtn = $<HTMLButtonElement>("validate-btn");
const resultsSection = $<HTMLElement>("results-section");
const resultsEl = $<HTMLUListElement>("results");
const debugSection = $<HTMLElement>("debug-section");
const debugOutput = $<HTMLPreElement>("debug-output");
const openLeclerc = $<HTMLAnchorElement>("open-leclerc");
const captureBtn = $<HTMLButtonElement>("capture-btn");
const captureStatus = $<HTMLParagraphElement>("capture-status");
const modelSelect = $<HTMLSelectElement>("model-select");
const webgpuCheckbox = $<HTMLInputElement>("webgpu-checkbox");

// ---- BYOK (bring your own key) — remote provider instead of local model ---

const byokProviderSelect = $<HTMLSelectElement>("byok-provider-select");
const byokFields = $<HTMLElement>("byok-fields");
const byokKeyInput = $<HTMLInputElement>("byok-key");
const byokModelInput = $<HTMLInputElement>("byok-model");
const byokHelp = $<HTMLParagraphElement>("byok-help");
const byokStatus = $<HTMLParagraphElement>("byok-status");
const modelPicker = $<HTMLElement>("model-picker");
const webgpuToggle = $<HTMLElement>("webgpu-toggle");

/** Same shape the background reads from chrome.storage.local key `byok`. */
interface ByokStorage {
  provider?: string;
  openaiKey?: string;
  vibeKey?: string;
  openaiModel?: string;
  vibeModel?: string;
}

const LOCAL_OPTION = document.createElement("option");
LOCAL_OPTION.value = "";
LOCAL_OPTION.textContent = "Modèle local (défaut)";
byokProviderSelect.appendChild(LOCAL_OPTION);
for (const p of BYOK_PROVIDERS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  byokProviderSelect.appendChild(opt);
}

function byokFieldValues(stored: ByokStorage): { key: string; model: string } {
  const provider = byokProviderSelect.value;
  if (provider === "openai") {
    return { key: stored.openaiKey ?? "", model: stored.openaiModel ?? "" };
  }
  if (provider === "vibe") {
    return { key: stored.vibeKey ?? "", model: stored.vibeModel ?? "" };
  }
  return { key: "", model: "" };
}

function renderByokUi(stored: ByokStorage): void {
  const providerId = byokProviderSelect.value;
  const provider = findByokProvider(providerId);
  const remote = provider !== null;
  byokFields.hidden = !remote;
  // The local picker + WebGPU toggle are irrelevant on a remote provider.
  modelPicker.hidden = remote;
  webgpuToggle.hidden = remote;
  if (!remote) {
    setStatus("idle", "modèle local, chargement au lancement");
    return;
  }
  const { key, model } = byokFieldValues(stored);
  byokKeyInput.value = key;
  byokKeyInput.placeholder = provider.keyHelp;
  byokModelInput.value = model;
  byokModelInput.placeholder = provider.modelHint;
  byokHelp.textContent =
    provider.id === "vibe"
      ? "Clé La Plateforme incluse dans ton forfait Vibe (api.mistral.ai)."
      : "Clé OpenAI (platform.openai.com/api-keys).";
  setStatus("idle", `${provider.label}, modèle ${model || provider.modelHint}`);
}

async function readByokStorage(): Promise<ByokStorage> {
  const v = (await chrome.storage.local.get("byok")) as { byok?: ByokStorage };
  return v.byok ?? {};
}

async function loadByok(): Promise<void> {
  const stored = await readByokStorage();
  byokProviderSelect.value = findByokProvider(stored.provider)?.id ?? "";
  renderByokUi(stored);
}

/**
 * Persist the current BYOK form state. Must be called AFTER the fields were
 * re-rendered for the active provider (a provider switch re-renders first),
 * otherwise a provider's key would be copied into the other provider's slot.
 */
async function persistByok(): Promise<void> {
  const stored = await readByokStorage();
  const next: ByokStorage = { ...stored, provider: byokProviderSelect.value };
  if (next.provider === "openai") {
    next.openaiKey = byokKeyInput.value.trim();
    next.openaiModel = byokModelInput.value.trim();
  } else if (next.provider === "vibe") {
    next.vibeKey = byokKeyInput.value.trim();
    next.vibeModel = byokModelInput.value.trim();
  } else {
    next.provider = "";
  }
  await chrome.storage.local.set({ byok: next });
  byokStatus.hidden = false;
  if (next.provider && !byokKeyInput.value.trim()) {
    byokStatus.className = "error";
    byokStatus.textContent = "Clé manquante : la planification échouera jusqu'à ce que tu saisisses une clé.";
  } else {
    byokStatus.className = "note ok";
    byokStatus.textContent = next.provider
      ? "Clé enregistrée localement."
      : "Modèle local réactivé.";
  }
}

byokProviderSelect.addEventListener("change", async () => {
  // Re-render the fields for the new provider (they show its stored values)
  // before persisting, so keys never leak across provider slots.
  await loadByok();
  await persistByok();
});
byokKeyInput.addEventListener("change", () => void persistByok());
byokModelInput.addEventListener("change", () => void persistByok());

void loadByok();

// ---- extension messaging helpers ------------------------------------------

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface OrchestrateReply {
  type: "offscreen_orchestrate_result";
  ok: boolean;
  plan?: Plan;
  error?: string;
  debug?: OrchestrationDebug;
}

interface LeclercRunReply {
  type: "leclerc_run_result";
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface ModelStatusReply {
  type: "model_status";
  status: "idle" | "loading" | "ready" | "error";
  modelId?: string;
  detail?: string;
}

interface ReloadOffscreenReply extends ReloadOffscreenResultMsg {}

interface SaveCaptureReply {
  type: "save_capture_result";
  ok: boolean;
  capture?: { id: string; url: string; title?: string };
  error?: string;
}

// ---- status ----------------------------------------------------------------

function setStatus(state: "idle" | "loading" | "ready" | "error", detail?: string): void {
  statusEl.className = `status ${state}`;
  const label =
    state === "idle"
      ? "Modèle : en attente"
      : state === "loading"
        ? "Modèle : chargement…"
        : state === "ready"
          ? "Modèle : prêt"
          : "Modèle : erreur";
  statusEl.textContent = detail ? `${label} — ${detail}` : label;
}

// Do not pre-warm on popup open: loading ONNX/Transformers from an extension
// popup can crash some Chrome Canary/macOS builds. The first planning run loads
// the model explicitly.
setStatus("idle", "chargement au lancement");
planBtn.disabled = false;

// ---- Model picker (lightest → heaviest, default = smallest stable) ---------

// Populate the select ordered lightest → heaviest.
for (const m of MODELS) {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = `${m.label} (${m.paramsB}B, ~${m.sizeGb}GB)`;
  modelSelect.appendChild(opt);
}

void chrome.storage.local.get("modelId").then((v) => {
  const id = (v as { modelId?: string }).modelId ?? DEFAULT_MODEL_ID;
  modelSelect.value = findModel(id).id;
});

modelSelect.addEventListener("change", async () => {
  const modelId = modelSelect.value;
  try {
    const r = await send<ReloadOffscreenReply>({
      type: "set_model",
      modelId,
    } satisfies SetModelMsg);
    if (r?.ok) {
      setStatus("idle", `modèle appliqué, device=${r.device ?? "?"}`);
    } else {
      setStatus("error", r?.error ?? "changement de modèle échoué");
    }
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
});

// ---- WebGPU toggle (default OFF; override of the model's recommended ----
//      device; independent of the model picker) ---------------------------
// WASM (CPU, non-GPU) is the default: WebGPU crashes the Chrome GPU process
// on some macOS setups. Check the box to opt back into WebGPU.
void chrome.storage.local.get("webgpu").then((v) => {
  const stored = (v as { webgpu?: boolean }).webgpu;
  webgpuCheckbox.checked = stored === true;
});

webgpuCheckbox.addEventListener("change", async () => {
  await chrome.storage.local.set({ webgpu: webgpuCheckbox.checked });
  // Reset the offscreen document so the device override takes effect on the
  // next run, without loading ONNX just because the checkbox changed.
  try {
    const r = await send<ReloadOffscreenReply>({ type: "reload_offscreen" } satisfies ReloadOffscreenMsg);
    if (r?.ok) {
      setStatus("idle", `device=${r.device ?? "?"} au prochain lancement`);
    } else {
      setStatus("error", r?.error ?? "rechargement échoué");
    }
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
});

interface ItemState {
  item: PlanItem;
  candidates: Product[];
  selectedProductId: string | null;
  quantity: number;
  result?: { ok: boolean; message: string };
}

let itemStates: ItemState[] = [];
let activeTraceId: string | undefined;
let debugState: Record<string, unknown> = {};

planBtn.addEventListener("click", () => void onPlan());

async function onPlan(): Promise<void> {
  const text = promptEl.value.trim();
  if (!text) return;
  const traceId = makeTraceId();
  activeTraceId = traceId;
  planBtn.disabled = true;
  planError.hidden = true;
  setStatus("loading");
  itemsEl.innerHTML = "";
  resultsSection.hidden = true;
  validateBtn.disabled = true;
  debugState = { traceId, input: text };
  renderDebug();
  console.info("[mcp-leclerc-drive][popup] orchestrate start", debugState);

  try {
    const reply = await send<OrchestrateReply>({
      type: "orchestrate",
      traceId,
      text,
    } satisfies OrchestrateRequestMsg);
    debugState = {
      ...debugState,
      offscreen: reply?.debug,
      plan: reply?.plan,
    };
    if (!reply || !reply.ok || !reply.plan) {
      planError.textContent = reply?.error ?? "Échec de la planification.";
      planError.hidden = false;
      setStatus("error");
      debugState = { ...debugState, error: reply?.error ?? "Échec de la planification." };
      renderDebug();
      return;
    }
    setStatus("ready");
    debugState = {
      ...debugState,
      searchCalls: searchCallsForPlan(reply.plan, traceId),
    };
    renderDebug();
    console.info("[mcp-leclerc-drive][popup] orchestrate success", debugState);
    renderPlan(reply.plan);
  } catch (err) {
    planError.textContent = err instanceof Error ? err.message : String(err);
    planError.hidden = false;
    setStatus("error");
    debugState = {
      ...debugState,
      error: err instanceof Error ? err.message : String(err),
    };
    renderDebug();
  } finally {
    planBtn.disabled = false;
  }
}

function renderPlan(plan: Plan): void {
  planSection.hidden = false;

  if (plan.questions && plan.questions.length > 0) {
    questionsEl.hidden = false;
    questionsEl.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = "À préciser :";
    questionsEl.appendChild(title);
    for (const q of plan.questions) {
      const p = document.createElement("p");
      p.textContent = "• " + q;
      questionsEl.appendChild(p);
    }
  } else {
    questionsEl.hidden = true;
  }

  itemStates = plan.items.map((item) => ({
    item,
    candidates: [],
    selectedProductId: null,
    quantity: item.quantity,
  }));
  itemsEl.innerHTML = "";
  for (let i = 0; i < itemStates.length; i++) {
    itemsEl.appendChild(renderItem(i));
    void searchForItem(i);
  }
  updateValidateState();
}

function renderItem(i: number): HTMLElement {
  const state = itemStates[i];
  const card = document.createElement("div");
  card.className = "item";
  card.dataset.index = String(i);

  const head = document.createElement("div");
  head.className = "item-head";
  head.textContent = state.item.query;
  card.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "item-meta";
  const parts: string[] = [];
  if (state.item.constraints) parts.push(state.item.constraints);
  if (state.item.notes) parts.push(state.item.notes);
  meta.textContent = parts.join(" — ");
  if (meta.textContent) card.appendChild(meta);

  const candidates = document.createElement("ul");
  candidates.className = "candidates";
  const loading = document.createElement("li");
  loading.className = "candidate";
  loading.textContent = "Recherche…";
  candidates.appendChild(loading);
  card.appendChild(candidates);

  const qty = document.createElement("div");
  qty.className = "qty";
  const qtyLabel = document.createElement("span");
  qtyLabel.textContent = "Quantité :";
  const qtyInput = document.createElement("input");
  qtyInput.type = "number";
  qtyInput.min = "1";
  qtyInput.max = "99";
  qtyInput.value = String(state.quantity);
  qtyInput.addEventListener("change", () => {
    const n = Math.max(1, Math.min(99, Math.trunc(Number(qtyInput.value) || 1)));
    qtyInput.value = String(n);
    state.quantity = n;
  });
  qty.appendChild(qtyLabel);
  qty.appendChild(qtyInput);
  card.appendChild(qty);

  const result = document.createElement("div");
  result.className = "item-result";
  result.hidden = true;
  card.appendChild(result);

  return card;
}

async function searchForItem(i: number): Promise<void> {
  const state = itemStates[i];
  const card = itemsEl.querySelector<HTMLElement>(`.item[data-index="${i}"]`);
  if (!card) return;
  const candidatesEl = card.querySelector<HTMLUListElement>(".candidates");
  if (!candidatesEl) return;

  try {
    const reply = await send<LeclercRunReply>({
      ...searchCallsForPlan({ items: [state.item] }, activeTraceId)[0],
    } satisfies LeclercRunMsg);
    if (!reply || !reply.ok) {
      candidatesEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "candidate";
      li.textContent = "Erreur : " + (reply?.error ?? "recherche impossible");
      candidatesEl.appendChild(li);
      return;
    }
    const data = reply.data as { kind: string; products: Product[] } | undefined;
    const products = data?.products ?? [];
    state.candidates = products;
    renderCandidates(i, candidatesEl);
  } catch (err) {
    candidatesEl.innerHTML = "";
    const li = document.createElement("li");
    li.className = "candidate";
    li.textContent = "Erreur : " + (err instanceof Error ? err.message : String(err));
    candidatesEl.appendChild(li);
  } finally {
    updateValidateState();
  }
}

function renderCandidates(i: number, ul: HTMLUListElement): void {
  const state = itemStates[i];
  ul.innerHTML = "";
  if (state.candidates.length === 0) {
    const li = document.createElement("li");
    li.className = "candidate";
    li.textContent = "Aucun produit trouvé.";
    ul.appendChild(li);
    return;
  }
  state.candidates.forEach((p, idx) => {
    const li = document.createElement("li");
    li.className = "candidate" + (p.available ? "" : " unavailable");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `item-${i}`;
    radio.value = p.id;
    radio.disabled = !p.available;
    radio.addEventListener("change", () => {
      state.selectedProductId = p.id;
      updateValidateState();
    });
    const label = document.createElement("span");
    label.className = "label";
    // textContent → labels are untrusted data, never rendered as HTML.
    label.textContent = p.label + (p.brand ? ` — ${p.brand}` : "");
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = p.price ? `${p.price.toFixed(2)} €` : "";
    li.appendChild(radio);
    li.appendChild(label);
    li.appendChild(price);
    ul.appendChild(li);
  });
}

function updateValidateState(): void {
  const allSelected =
    itemStates.length > 0 && itemStates.every((s) => s.selectedProductId !== null);
  validateBtn.disabled = !allSelected;
}

// ---- validation (mutations only here) --------------------------------------

validateBtn.addEventListener("click", () => void onValidate());

async function onValidate(): Promise<void> {
  validateBtn.disabled = true;
  resultsSection.hidden = false;
  resultsEl.innerHTML = "";
  let allOk = true;
  const builtCalls = addToCartCallsForSelections(
    { items: itemStates.map((state) => state.item) },
    itemStates.flatMap((state, i) =>
      state.selectedProductId
        ? [{ itemIndex: i, productId: state.selectedProductId, quantity: state.quantity }]
        : [],
    ),
    activeTraceId,
  );
  debugState = {
    ...debugState,
    addToCartCalls: builtCalls.ok ? builtCalls.calls : builtCalls,
  };
  renderDebug();
  console.info("[mcp-leclerc-drive][popup] validate", debugState);

  if (!builtCalls.ok) {
    const li = document.createElement("li");
    li.textContent = "Échec : " + builtCalls.error;
    resultsEl.appendChild(li);
    validateBtn.disabled = false;
    return;
  }

  for (let i = 0; i < itemStates.length; i++) {
    const state = itemStates[i];
    const card = itemsEl.querySelector<HTMLElement>(`.item[data-index="${i}"]`);
    const resultEl = card?.querySelector<HTMLDivElement>(".item-result");
    const call = builtCalls.calls[i];

    const li = document.createElement("li");
    li.textContent = `${state.item.query} … `;
    resultsEl.appendChild(li);

    try {
      const reply = await send<LeclercRunReply>(call satisfies LeclercRunMsg);
      if (reply && reply.ok) {
        li.textContent += "ajouté ✓";
        if (resultEl) {
          resultEl.hidden = false;
          resultEl.className = "item-result ok";
          resultEl.textContent = "Ajouté au panier.";
        }
      } else {
        allOk = false;
        const err = reply?.error ?? "échec";
        li.textContent += `échec : ${err}`;
        if (resultEl) {
          resultEl.hidden = false;
          resultEl.className = "item-result err";
          resultEl.textContent = "Erreur : " + err;
        }
      }
    } catch (err) {
      allOk = false;
      const msg = err instanceof Error ? err.message : String(err);
      li.textContent += `échec : ${msg}`;
    }
  }

  if (allOk && itemStates.length > 0) {
    const done = document.createElement("li");
    done.textContent = "Tous les articles ont été ajoutés au panier.";
    resultsEl.appendChild(done);
  }
  validateBtn.disabled = false;
}

function makeTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function renderDebug(): void {
  debugSection.hidden = false;
  debugOutput.textContent = JSON.stringify(debugState, null, 2);
}

// ---- recipe page capture ---------------------------------------------------

captureBtn.addEventListener("click", () => {
  void onCapture();
});

async function onCapture(): Promise<void> {
  captureBtn.disabled = true;
  captureStatus.hidden = false;
  captureStatus.className = "note";
  captureStatus.textContent = "Sauvegarde…";
  try {
    const reply = await send<SaveCaptureReply>({ type: "save_capture" });
    if (reply.ok && reply.capture) {
      captureStatus.className = "note ok";
      captureStatus.textContent =
        `Page capturée : ${reply.capture.title ?? reply.capture.url} ` +
        `(id ${reply.capture.id}). Elle sera proposée à ton agent MCP.`;
    } else {
      captureStatus.className = "error";
      captureStatus.textContent = reply.error ?? "Échec de la capture.";
    }
  } catch (err) {
    captureStatus.className = "error";
    captureStatus.textContent = "Échec de la capture : " + (err instanceof Error ? err.message : String(err));
  }
  captureBtn.disabled = false;
}

// ---- footer link -----------------------------------------------------------

openLeclerc.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: "https://www.leclercdrive.fr/" });
});

// Background may push unsolicited status updates (e.g. model errors).
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "model_status"
  ) {
    const m = msg as BackgroundToPopupMsg as ModelStatusReply;
    if (m.status === "ready") setStatus("ready", m.detail);
    else if (m.status === "error") setStatus("error", m.detail);
  }
  return false;
});
