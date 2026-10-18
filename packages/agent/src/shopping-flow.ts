/**
 * Recipe-to-cart flow shared by Chrome and the Node harness.
 *
 * The default path (ADR-0013) generates and validates a recipe, then evaluates
 * observed products in bounded batches. Solid choices are added immediately
 * through a write-ahead ledger and verified cart reads. Uncertain choices are
 * grouped for the human; the final cart is reviewed after addition.
 *
 * The explicit deterministic mode preserves the version-1 approval-gated
 * baseline for historical comparisons. No provider fallback is implicit.
 */

import type { Cart, Product, ToolError } from "@leclerc/contracts";
import {
  buildRepairPrompt,
  parseRecipeText,
  type GeneratedRecipe,
} from "@leclerc/contracts";
import {
  ApprovalGate,
  type ApprovalDecisionHandler,
  type ApprovalRequest,
  type CartPreview,
  type CartPreviewLine,
  type ClarificationAnswer,
  type ClarificationHandler,
  type ClarificationQuestion,
} from "./approval.js";
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_TURNS, ToolExecutor, type ToolBinding } from "./engine.js";
import { GENERATION_PARAMS, RECIPE_SYSTEM_PROMPT } from "./prompts.js";
import type { ModelProvider, ProviderProposal, ProviderMessage } from "./provider.js";
import { ProviderUnavailableError } from "./provider.js";
import { createTraceBuilder, type TraceBuilder, type TraceEvent } from "./trace.js";
import { fold, matchIngredient, purchaseQuantity } from "./product-matching.js";
import { type ProductReviewHandler } from "./product-selection.js";
import type { CartProgress, ProgressCheckpoint } from "./cart-progress.js";
import { runProgressiveSelection } from "./progressive-flow.js";
export { purchaseQuantity } from "./product-matching.js";

// ---- public types -------------------------------------------------------------

export type ShoppingOutcomeStatus =
  | "completed"
  | "refused"
  | "recipe_invalid"
  | "provider_unavailable"
  | "partial_failure"
  | "cancelled"
  | "limits_exceeded";

export interface ShoppingFlowRequest {
  /** Free-form French user request. */
  message: string;
  /** Requested servings the recipe must target. */
  servings: number;
  /** Ingredient names that must not appear in the recipe. */
  excludedIngredients?: string[];
}

export interface ShoppingFlowLimits {
  /** Max provider generate() calls (default DEFAULT_MAX_TURNS). */
  maxTurns?: number;
  /** Max tool executions in the flow (default DEFAULT_MAX_TOOL_CALLS). */
  maxToolCalls?: number;
}

export interface ShoppingFlowConfig {
  provider: ModelProvider;
  /** Capability bindings (real adapter in Chrome, harness mocks in Node). */
  bindings: readonly ToolBinding[];
  request: ShoppingFlowRequest;
  /** Historical deterministic baseline only; progressive preparation needs no global click. */
  approval?: ApprovalDecisionHandler;
  /** Optional clarification answers, injected as scenario events. */
  clarification?: ClarificationHandler;
  /** Historical baseline for version-1 scenarios; live runs use model selection. */
  selectionMode?: "model" | "deterministic";
  review?: ProductReviewHandler;
  progress?: CartProgress;
  checkpoint?: ProgressCheckpoint;
  limits?: ShoppingFlowLimits;
  signal?: AbortSignal;
}

export type ShoppingFlowIssueKind =
  | "ingredient_not_found"
  | "ambiguous_unresolved"
  | "packaging_default";

export interface ShoppingFlowIssue {
  kind: ShoppingFlowIssueKind;
  ingredient: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface GapReport {
  /** Lines successfully added to the cart. */
  applied: CartPreviewLine[];
  /** Lines whose add_to_cart failed, with the typed error. */
  failed: Array<{ line: CartPreviewLine; error: ToolError }>;
  /** Lines never attempted (stopped after a failure). */
  notAttempted: CartPreviewLine[];
}

/** Everything needed to complete the remaining mutations after a new approval. */
export interface ShoppingFlowResume {
  preview: CartPreview;
  /** Lines still to add. */
  pending: CartPreviewLine[];
  /** Lines already applied before the interruption. */
  applied: CartPreviewLine[];
  /** The first failure that interrupted the run, when there was one. */
  failed: { line: CartPreviewLine; error: ToolError } | undefined;
}

export interface ShoppingFlowError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ShoppingFlowResult {
  status: ShoppingOutcomeStatus;
  trace: TraceEvent[];
  progress?: CartProgress;
  recipe?: GeneratedRecipe;
  preview?: CartPreview;
  issues: ShoppingFlowIssue[];
  gap?: GapReport;
  resume?: ShoppingFlowResume;
  /** Cart state re-read after the mutations (or on interruption). */
  cart?: Cart;
  /** French diagnostic when the provider could not run. */
  diagnostic?: string;
  /** Consent-only alternative provider proposal — plain data, never called. */
  proposal?: ProviderProposal;
  error?: ShoppingFlowError;
}

/**
 * Default consent-only Mistral proposal attached to a provider_unavailable
 * outcome when the thrown error carried none. Never instantiated, never
 * executed: the user must explicitly consent first.
 */
export const MISTRAL_FALLBACK_PROPOSAL: ProviderProposal = {
  providerId: "mistral-byok",
  label: "Mistral (clé personnelle)",
  consentRequired: true,
  reason:
    "Le modèle local est indisponible ; Mistral ne sera utilisé qu'après votre accord explicite (clé personnelle, jamais automatiquement).",
};

export interface ResumeShoppingFlowConfig {
  bindings: readonly ToolBinding[];
  resume: ShoppingFlowResume;
  approval: ApprovalDecisionHandler;
  limits?: ShoppingFlowLimits;
  signal?: AbortSignal;
}

// ---- deterministic matching and quantity rules ---------------------------------

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// ---- internal helpers ----------------------------------------------------------

class CallBudget {
  used = 0;
  constructor(public max: number) {}
  /** Consume one slot; false when the budget is exhausted. */
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}

type RawGenerationOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: "cancelled" }
  | { ok: false; kind: "limits_exceeded" }
  | { ok: false; kind: "provider_unavailable"; diagnostic: string; proposal?: ProviderProposal }
  | { ok: false; kind: "provider_error"; message: string };

interface MutationPhaseOutcome {
  applied: CartPreviewLine[];
  failed: { line: CartPreviewLine; error: ToolError } | undefined;
  notAttempted: CartPreviewLine[];
  budgetExhausted: boolean;
  cancelled: boolean;
}

interface MutationPhaseInput {
  executor: ToolExecutor;
  trace: TraceBuilder;
  lines: CartPreviewLine[];
  signal?: AbortSignal;
  budget: CallBudget;
}

/**
 * Sequential mutations: each line is added one at a time; the FIRST failure
 * stops the run and the remaining lines become notAttempted.
 */
async function runMutations(input: MutationPhaseInput): Promise<MutationPhaseOutcome> {
  const { executor, trace, lines, signal, budget } = input;
  const applied: CartPreviewLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (signal?.aborted) {
      return { applied, failed: undefined, notAttempted: lines.slice(i), budgetExhausted: false, cancelled: true };
    }
    if (!budget.take()) {
      return { applied, failed: undefined, notAttempted: lines.slice(i), budgetExhausted: true, cancelled: false };
    }
    const result = await executor.call(
      "add_to_cart",
      { product_id: line.productId, quantity: line.quantity },
      "deterministic",
    );
    if (!result.ok) {
      return {
        applied,
        failed: { line, error: result },
        notAttempted: lines.slice(i + 1),
        budgetExhausted: false,
        cancelled: false,
      };
    }
    applied.push(line);
  }
  return { applied, failed: undefined, notAttempted: [], budgetExhausted: false, cancelled: false };
}

/** Re-read the cart through the executor (budget permitting). */
async function readCart(executor: ToolExecutor, budget: CallBudget): Promise<Cart | undefined> {
  if (!budget.take()) return undefined;
  const result = await executor.call("get_cart", {}, "deterministic");
  return result.ok ? (result.output as { cart: Cart }).cart : undefined;
}

// ---- runShoppingFlow ------------------------------------------------------------

export async function runShoppingFlow(config: ShoppingFlowConfig): Promise<ShoppingFlowResult> {
  const { provider, request, signal, clarification } = config;
  const maxTurns = config.limits?.maxTurns ?? DEFAULT_MAX_TURNS;
  const budget = new CallBudget(config.limits?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const trace = createTraceBuilder();
  const gate = new ApprovalGate(config.approval ?? (() => ({ approved: false })));
  const executor = new ToolExecutor({ bindings: config.bindings, gate, trace });
  const issues: ShoppingFlowIssue[] = [];

  trace.userMessage(request.message);

  const cancelledResult = (): ShoppingFlowResult => ({
    status: "cancelled",
    trace: trace.events,
    issues,
  });
  if (signal?.aborted) return cancelledResult();

  // -- recipe generation (frozen prompt, pinned params) --

  let generationCalls = 0;
  const generateRaw = async (messages: ProviderMessage[], maxTokens: number = GENERATION_PARAMS.maxTokens): Promise<RawGenerationOutcome> => {
    if (signal?.aborted) return { ok: false, kind: "cancelled" };
    if (generationCalls >= maxTurns) return { ok: false, kind: "limits_exceeded" };
    const started = Date.now();
    let success = false;
    generationCalls++;
    try {
      const response = await provider.generate({
        messages,
        ...GENERATION_PARAMS,
        maxTokens,
        responseFormat: "json_object",
        ...(signal ? { signal } : {}),
      });
      success = response.finishReason !== "error" && response.finishReason !== "cancelled";
      const durationMs = Date.now() - started;
      if (signal?.aborted || response.finishReason === "cancelled") {
        return { ok: false, kind: "cancelled" };
      }
      const text = response.text ?? "";
      if (text !== "") trace.modelText(text, durationMs);
      if (maxTokens === 4096 && response.finishReason === "error") {
        return { ok: false, kind: "provider_error", message: text || "Évaluation du modèle impossible." };
      }
      if (maxTokens === 4096 && response.finishReason === "length") {
        return { ok: false, kind: "provider_error", message: "Réponse du modèle tronquée pendant la sélection. Reprends le parcours pour réessayer." };
      }
      // A scripted provider error still flows into the strict parse: an
      // unreadable output is a recipe problem, handled by the repair rule.
      return { ok: true, text };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        trace.error("PROVIDER_UNAVAILABLE", err.diagnostic);
        return {
          ok: false,
          kind: "provider_unavailable",
          diagnostic: err.diagnostic,
          proposal: err.proposal,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      trace.error("PROVIDER_ERROR", `Appel du modèle impossible : ${message}`);
      return { ok: false, kind: "provider_error", message };
    } finally {
      trace.events.push({ type: "model_call", timestamp: trace.now(), purpose: maxTokens === 4096 ? "selection" : "recipe", durationMs: Date.now() - started, success });
    }
  };

  const runPrepared = (recipe: GeneratedRecipe) => {
    budget.max = config.limits?.maxToolCalls ?? Math.max(DEFAULT_MAX_TOOL_CALLS, recipe.ingredients.length * 6 + 4);
    return runProgressiveSelection({
      recipe, request: config.progress?.request ?? request, executor, gate, trace, signal,
      progress: config.progress, checkpoint: config.checkpoint, review: config.review, clarification,
      takeRead: () => budget.used < budget.max - 3 && budget.take(),
      takeMutationCall: () => budget.take(),
      generate: async (messages) => {
        const result = await generateRaw(messages, 4096);
        if (!result.ok && result.kind !== "limits_exceeded" && result.kind !== "cancelled") {
          throw new Error("diagnostic" in result ? result.diagnostic : "message" in result ? result.message : "Évaluation du modèle impossible.");
        }
        return result.ok ? result.text : undefined;
      },
    });
  };
  if (config.progress) return runPrepared(config.progress.recipe);

  const generationMessages: ProviderMessage[] = [
    { role: "system", content: RECIPE_SYSTEM_PROMPT },
    { role: "user", content: request.message },
  ];

  const first = await generateRaw(generationMessages);
  if (!first.ok) {
    if (first.kind === "cancelled") return cancelledResult();
    if (first.kind === "limits_exceeded") {
      return {
        status: "limits_exceeded",
        trace: trace.events,
        issues,
        error: { code: "LIMITS_EXCEEDED", message: "Budget d'appels au modèle épuisé avant la génération de la recette." },
      };
    }
    if (first.kind === "provider_unavailable") {
      return {
        status: "provider_unavailable",
        trace: trace.events,
        issues,
        diagnostic: first.diagnostic,
        proposal: first.proposal ?? MISTRAL_FALLBACK_PROPOSAL,
      };
    }
    return {
      status: "recipe_invalid",
      trace: trace.events,
      issues,
      error: { code: "PROVIDER_ERROR", message: first.message },
    };
  }

  // -- strict parse + at most one guided repair --

  let parsed = parseRecipeText(first.text);
  let recipe: GeneratedRecipe | undefined = parsed.ok ? parsed.recipe : undefined;

  if (!recipe) {
    if (signal?.aborted) return cancelledResult();
    trace.repairAttempt(1, parsed.ok ? [] : parsed.issues);
    generationMessages.push(
      { role: "assistant", content: first.text },
      { role: "user", content: buildRepairPrompt(parsed.ok ? "" : parsed.raw, parsed.ok ? [] : parsed.issues) },
    );
    const second = await generateRaw(generationMessages);
    if (!second.ok) {
      if (second.kind === "cancelled") return cancelledResult();
      if (second.kind === "limits_exceeded") {
        return {
          status: "limits_exceeded",
          trace: trace.events,
          issues,
          error: { code: "LIMITS_EXCEEDED", message: "Budget d'appels au modèle épuisé pendant la réparation de la recette." },
        };
      }
      if (second.kind === "provider_unavailable") {
        return {
          status: "provider_unavailable",
          trace: trace.events,
          issues,
          diagnostic: second.diagnostic,
          proposal: second.proposal ?? MISTRAL_FALLBACK_PROPOSAL,
        };
      }
      return {
        status: "recipe_invalid",
        trace: trace.events,
        issues,
        error: { code: "PROVIDER_ERROR", message: second.message },
      };
    }
    parsed = parseRecipeText(second.text);
    recipe = parsed.ok ? parsed.recipe : undefined;
  }

  if (!recipe) {
    const message =
      "Recette invalide même après l'unique réparation guidée : aucune recherche ni mutation du panier n'a été effectuée.";
    const lastIssues = parsed.ok ? [] : parsed.issues;
    trace.error("RECIPE_INVALID", message, { issues: lastIssues });
    return {
      status: "recipe_invalid",
      trace: trace.events,
      issues,
      error: { code: "RECIPE_INVALID", message, details: { issues: lastIssues } },
    };
  }

  // -- servings check --

  if (recipe.servings !== request.servings) {
    const message = `La recette générée vise ${recipe.servings} convives alors que ${request.servings} ont été demandés : recette non conforme.`;
    trace.error("RECIPE_INVALID", message);
    return {
      status: "recipe_invalid",
      trace: trace.events,
      issues,
      recipe,
      error: { code: "RECIPE_INVALID", message },
    };
  }

  // -- exclusion check --

  for (const excluded of request.excludedIngredients ?? []) {
    const hit = recipe.ingredients.find((ingredient) =>
      fold(ingredient.name).includes(fold(excluded)),
    );
    if (hit) {
      const message = `La recette contient « ${hit.name} » alors que « ${excluded} » est exclu : recette non conforme.`;
      trace.error("RECIPE_INVALID", message);
      return {
        status: "recipe_invalid",
        trace: trace.events,
        issues,
        recipe,
        error: { code: "RECIPE_INVALID", message },
      };
    }
  }

  // -- deterministic product requests + searches + matching --

  const lines: CartPreviewLine[] = [];
  if (config.selectionMode === "deterministic") {
  for (const ingredient of recipe.ingredients) {
    if (signal?.aborted) return cancelledResult();
    if (!budget.take()) {
      trace.error("LIMITS_EXCEEDED", "Budget d'appels d'outils épuisé pendant les recherches produits.");
      return {
        status: "limits_exceeded",
        trace: trace.events,
        issues,
        recipe,
        error: { code: "LIMITS_EXCEEDED", message: "Budget d'appels d'outils épuisé pendant les recherches produits." },
      };
    }
    const search = await executor.call("search_product", { query: ingredient.name }, "deterministic");
    if (!search.ok) {
      issues.push({
        kind: "ingredient_not_found",
        ingredient: ingredient.name,
        message: `Ingrédient « ${ingredient.name} » introuvable dans le catalogue : ${search.message}`,
        details: { code: search.code },
      });
      continue;
    }
    const products = ((search.output as { products?: Product[] }).products ?? []).filter(
      (product) => product.available,
    );
    if (products.length === 0) {
      issues.push({
        kind: "ingredient_not_found",
        ingredient: ingredient.name,
        message: `Aucun produit disponible pour « ${ingredient.name} » : article non ajouté.`,
      });
      continue;
    }

    const match = matchIngredient(ingredient.name, products);
    let selected: Product | undefined;
    let score = 0;
    if (match.kind === "selected") {
      selected = match.product;
      score = match.score;
    } else if (match.kind === "ambiguous") {
      const question: ClarificationQuestion = {
        kind: "ambiguous_match",
        ingredient: ingredient.name,
        candidates: match.candidates.map((product) => ({
          productId: product.id,
          label: product.label,
          price: product.price,
          ...(product.packaging ? { packaging: product.packaging } : {}),
        })),
        message: `Plusieurs produits du catalogue correspondent à « ${ingredient.name} ». Lequel faut-il ajouter au panier ?`,
      };
      if (clarification) {
        const answer: ClarificationAnswer = await clarification(question);
        trace.clarification(question, answer);
        if ("productId" in answer) {
          const chosen = match.candidates.find((product) => product.id === answer.productId);
          if (chosen) {
            selected = chosen;
            score = match.score;
          }
        }
      } else {
        trace.clarification(question);
      }
      if (!selected) {
        issues.push({
          kind: "ambiguous_unresolved",
          ingredient: ingredient.name,
          message: `Produit ambigu pour « ${ingredient.name} » (candidates : ${match.candidates
            .map((p) => p.id)
            .join(", ")}) : article non ajouté.`,
        });
        continue;
      }
    } else {
      issues.push({
        kind: "ingredient_not_found",
        ingredient: ingredient.name,
        message: `Aucun produit du catalogue ne correspond à « ${ingredient.name} » : article non ajouté.`,
      });
      continue;
    }

    const purchase = purchaseQuantity(
      { quantity: ingredient.quantity, unit: ingredient.unit },
      selected.packaging,
    );
    if (purchase.note) {
      issues.push({ kind: "packaging_default", ingredient: ingredient.name, message: purchase.note });
    }
    lines.push({
      productId: selected.id,
      label: selected.label,
      ingredient: ingredient.name,
      quantity: purchase.quantity,
      unitPrice: selected.price,
      lineTotal: round2(purchase.quantity * selected.price),
      ...(selected.packaging ? { packaging: selected.packaging } : {}),
      matchScore: score,
      ...(purchase.note ? { note: purchase.note } : {}),
    });
  }

  } else {
    return runPrepared(recipe);
  }

  // -- cart preview --

  const preview: CartPreview = {
    recipeTitle: recipe.title,
    servings: recipe.servings,
    lines,
    total: round2(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
  };

  // -- global approval: the ONLY door to the mutations --

  if (signal?.aborted) return cancelledResult();
  const approvalRequest: ApprovalRequest = {
    kind: "global_cart_mutation",
    summary: `Ajouter ${lines.length} article(s) au panier pour « ${recipe.title} » (${recipe.servings} personnes) — total ${preview.total.toFixed(2)} €.`,
    preview,
  };
  trace.approvalRequest(approvalRequest);
  const decision = await gate.requestApproval(approvalRequest);
  trace.approvalDecision(decision);
  if (!decision.approved) {
    return { status: "refused", trace: trace.events, recipe, preview, issues };
  }

  // -- sequential mutations, stop at first failure --

  const phase = await runMutations({ executor, trace, lines, signal, budget });
  if (phase.cancelled) {
    return { status: "cancelled", trace: trace.events, recipe, preview, issues };
  }
  const cart = await readCart(executor, budget);
  const gap: GapReport = {
    applied: phase.applied,
    failed: phase.failed ? [phase.failed] : [],
    notAttempted: phase.notAttempted,
  };
  if (phase.failed || phase.budgetExhausted) {
    return {
      status: "partial_failure",
      trace: trace.events,
      recipe,
      preview,
      issues,
      gap,
      ...(cart ? { cart } : {}),
      resume: {
        preview,
        pending: phase.notAttempted,
        applied: phase.applied,
        failed: phase.failed,
      },
    };
  }
  return {
    status: "completed",
    trace: trace.events,
    recipe,
    preview,
    issues,
    gap,
    ...(cart ? { cart } : {}),
  };
}

// ---- resumeShoppingFlow ----------------------------------------------------------

/**
 * Complete the pending mutations of an interrupted run. The approval gate is
 * fresh: a NEW global approval is always required, the previous one never
 * carries over.
 */
export async function resumeShoppingFlow(
  config: ResumeShoppingFlowConfig,
): Promise<ShoppingFlowResult> {
  const { resume, signal } = config;
  const budget = new CallBudget(config.limits?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const trace = createTraceBuilder();
  const gate = new ApprovalGate(config.approval);
  const executor = new ToolExecutor({ bindings: config.bindings, gate, trace });

  if (signal?.aborted) {
    return { status: "cancelled", trace: trace.events, issues: [] };
  }

  const approvalRequest: ApprovalRequest = {
    kind: "global_cart_mutation",
    summary: `Reprendre « ${resume.preview.recipeTitle} » : ajouter les ${resume.pending.length} article(s) restant(s) — total restant ${resume.pending
      .reduce((sum, line) => sum + line.lineTotal, 0)
      .toFixed(2)} €.`,
    preview: resume.preview,
  };
  trace.approvalRequest(approvalRequest);
  const decision = await gate.requestApproval(approvalRequest);
  trace.approvalDecision(decision);
  if (!decision.approved) {
    return { status: "refused", trace: trace.events, preview: resume.preview, issues: [] };
  }

  const phase = await runMutations({ executor, trace, lines: resume.pending, signal, budget });
  if (phase.cancelled) {
    return { status: "cancelled", trace: trace.events, preview: resume.preview, issues: [] };
  }
  const cart = await readCart(executor, budget);

  const applied = [...resume.applied, ...phase.applied];
  const failed = [
    ...(resume.failed ? [resume.failed] : []),
    ...(phase.failed ? [phase.failed] : []),
  ];
  const gap: GapReport = { applied, failed, notAttempted: phase.notAttempted };

  if (phase.failed || phase.budgetExhausted) {
    return {
      status: "partial_failure",
      trace: trace.events,
      preview: resume.preview,
      issues: [],
      gap,
      ...(cart ? { cart } : {}),
      resume: {
        preview: resume.preview,
        pending: phase.notAttempted,
        applied,
        failed: resume.failed ?? phase.failed,
      },
    };
  }
  return {
    status: "completed",
    trace: trace.events,
    preview: resume.preview,
    issues: [],
    gap,
    ...(cart ? { cart } : {}),
  };
}
