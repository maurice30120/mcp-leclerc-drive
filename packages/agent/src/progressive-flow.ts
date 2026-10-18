import type { GeneratedRecipe } from "@leclerc/contracts";
import type { ApprovalGate, CartPreview, ClarificationHandler } from "./approval.js";
import { createCartProgress, ProgressiveCart, type CartProgress, type ProgressCheckpoint } from "./cart-progress.js";
import type { ToolExecutor } from "./engine.js";
import { selectProducts, type ProductReviewHandler } from "./product-selection.js";
import type { ProviderMessage } from "./provider.js";
import type { ShoppingFlowIssue, ShoppingFlowRequest, ShoppingFlowResult } from "./shopping-flow.js";
import type { TraceBuilder } from "./trace.js";

export async function runProgressiveSelection(config: {
  recipe: GeneratedRecipe;
  request: ShoppingFlowRequest;
  progress?: CartProgress;
  executor: ToolExecutor;
  gate: ApprovalGate;
  trace: TraceBuilder;
  checkpoint?: ProgressCheckpoint;
  generate(messages: ProviderMessage[]): Promise<string | undefined>;
  takeRead(): boolean;
  takeMutationCall(): boolean;
  review?: ProductReviewHandler;
  clarification?: ClarificationHandler;
  signal?: AbortSignal;
}): Promise<ShoppingFlowResult> {
  const { recipe, request, executor, gate, trace, signal } = config;
  let progress = config.progress;
  let issues: ShoppingFlowIssue[] = [];
  let error: string | undefined;
  try {
    progress ??= await createCartProgress(recipe, request, executor);
    const cart = new ProgressiveCart(progress, executor, gate, trace, config.checkpoint, config.takeMutationCall);
    trace.events.push({ type: "preparation_authorized", timestamp: trace.now(), flowId: progress.flowId });
    await cart.save();
    if (progress.intent) await cart.reconcile(!signal?.aborted);
    if (!signal?.aborted && !progress.finished) {
      const result = await selectProducts({ recipe, request, executor, trace, signal, state: progress.selection,
        generate: config.generate, takeRead: config.takeRead, review: config.review, clarification: config.clarification,
        reviewOnlyUncertain: true,
        onCheckpoint: async (selection) => { progress!.selection = selection; await cart.save(); },
        onSelected: async (index, line) => {
          if (signal?.aborted) return;
          try { await cart.add(index, line); }
          catch (error) {
            if (!progress!.intent) await cart.state(index, "failed", error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
        onProgress: async (index, status, message) => {
          if (progress!.entries[index].added === 0) await cart.state(index, status, message);
        },
      });
      issues = result.issues;
    }
    // Authoritative final view, also after a no-op retry.
    await cart.read();
    await cart.save();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    trace.error("PROGRESSIVE_CART_INTERRUPTED", error);
  }
  const entries = progress?.entries ?? [];
  const lines = entries.filter((entry) => entry.line && entry.added > entry.removed).map((entry) => ({ ...entry.line!, quantity: entry.added - entry.removed,
    lineTotal: Math.round((entry.added - entry.removed) * entry.line!.unitPrice * 100) / 100 }));
  const preview: CartPreview = { recipeTitle: recipe.title, servings: recipe.servings, lines, total: Math.round(lines.reduce((sum, line) => sum + line.lineTotal, 0) * 100) / 100 };
  return { status: signal?.aborted ? "cancelled" : error ? "partial_failure" : "completed", recipe, preview, trace: trace.events, issues,
    ...(progress ? { progress, cart: progress.cart } : {}),
    ...(error ? { error: { code: "PROGRESSIVE_CART_INTERRUPTED", message: error } } : {}) };
}
