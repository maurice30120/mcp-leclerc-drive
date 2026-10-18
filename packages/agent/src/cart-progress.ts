import type { Cart, GeneratedRecipe } from "@leclerc/contracts";
import { GENERATED_RECIPE_SCHEMA_VERSION, parseRecipeText } from "@leclerc/contracts";
import type { ApprovalGate, CartPreviewLine } from "./approval.js";
import type { ToolExecutor } from "./engine.js";
import type { ProductSelectionState } from "./product-selection.js";
import type { ShoppingFlowRequest } from "./shopping-flow.js";
import type { TraceBuilder } from "./trace.js";

export type IngredientStatus = "searching" | "verifying" | "added" | "choice_needed" | "failed" | "verification_pending" | "skipped" | "removed";
export interface ProgressEntry {
  ingredientIndex: number;
  ingredient: string;
  status: IngredientStatus;
  line?: CartPreviewLine;
  /** Confirmed contributions only. Never inferred from a successful HTTP response. */
  added: number;
  removed: number;
  error?: string;
}
export interface CartIntent {
  ingredientIndex: number;
  productId: string;
  before: number;
  target: number;
  operation: "add" | "remove";
  delta: number;
}
export interface CartProgress {
  formatVersion: 1;
  flowId: string;
  recipe: GeneratedRecipe;
  request: ShoppingFlowRequest;
  storeId: string;
  baseline: Record<string, number>;
  entries: ProgressEntry[];
  selection?: ProductSelectionState;
  intent?: CartIntent;
  cart?: Cart;
  finished: boolean;
}
export type ProgressCheckpoint = (progress: CartProgress) => Promise<void> | void;

export class CartProgressError extends Error {}

/** Reject corrupt durable journals instead of starting a second, empty run. */
export function isCartProgress(value: unknown): value is CartProgress {
  if (!value || typeof value !== "object") return false;
  const p = value as CartProgress;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 999;
  let recipeValid = false;
  try {
    const { schemaVersion, ...recipe } = p.recipe;
    recipeValid = schemaVersion === GENERATED_RECIPE_SCHEMA_VERSION && parseRecipeText(JSON.stringify(recipe)).ok;
  } catch { return false; }
  if (p.formatVersion !== 1 || typeof p.flowId !== "string" || !p.flowId || typeof p.storeId !== "string" || !p.storeId
    || typeof p.finished !== "boolean" || !recipeValid || typeof p.request?.message !== "string"
    || p.request.servings !== p.recipe.servings || !p.baseline || Object.values(p.baseline).some((n) => !count(n))
    || !Array.isArray(p.entries) || p.entries.length !== p.recipe.ingredients.length) return false;
  if (p.entries.some((entry, index) => !entry || entry.ingredientIndex !== index || entry.ingredient !== p.recipe.ingredients[index].name
    || !count(entry.added) || !count(entry.removed) || entry.removed > entry.added
    || !["searching", "verifying", "added", "choice_needed", "failed", "verification_pending", "skipped", "removed"].includes(entry.status)
    || (entry.line !== undefined && (!entry.line.productId || !count(entry.line.quantity) || entry.line.quantity === 0
      || !Number.isFinite(entry.line.unitPrice) || entry.line.unitPrice < 0)))) return false;
  if (p.intent) {
    const i = p.intent;
    if (!count(i.ingredientIndex) || !p.entries[i.ingredientIndex]?.line || p.entries[i.ingredientIndex].line!.productId !== i.productId
      || !count(i.before) || !count(i.target) || !count(i.delta) || i.delta === 0
      || !["add", "remove"].includes(i.operation)
      || i.target !== i.before + (i.operation === "add" ? i.delta : -i.delta)) return false;
  }
  if (p.selection && (!Array.isArray(p.selection.pools) || p.selection.pools.length !== p.entries.length
    || !Array.isArray(p.selection.queries) || p.selection.queries.length !== p.entries.length
    || !p.selection.queries.every((queries) => Array.isArray(queries) && queries.length <= 3 && queries.every((q) => typeof q === "string"))
    || !Array.isArray(p.selection.decisions) || !Array.isArray(p.selection.habitualIds)
    || !count(p.selection.round) || p.selection.round > 3 || typeof p.selection.complete !== "boolean")) return false;
  return true;
}

function quantity(cart: Cart, productId: string): number {
  return cart.items.filter((item) => item.product.id === productId).reduce((sum, item) => sum + item.quantity, 0);
}

/** Absolute targets + write-ahead checkpoint + authoritative reread make retries idempotent. */
export class ProgressiveCart {
  constructor(
    readonly progress: CartProgress,
    private readonly executor: ToolExecutor,
    private readonly gate: ApprovalGate,
    private readonly trace: TraceBuilder,
    private readonly checkpoint: ProgressCheckpoint = () => {},
    private readonly takeCall: () => boolean = () => true,
  ) {}

  async save(): Promise<void> { await this.checkpoint(structuredClone(this.progress)); }

  async state(index: number, status: IngredientStatus, message?: string): Promise<void> {
    const entry = this.progress.entries[index];
    entry.status = status;
    entry.error = message;
    this.trace.events.push({ type: "ingredient_progress", timestamp: this.trace.now(), ingredientIndex: index, status, ...(message ? { message } : {}) });
    await this.save();
  }

  async read(): Promise<Cart> {
    if (!this.takeCall()) throw new CartProgressError("Budget d'appels atteint avant vérification du panier.");
    const result = await this.executor.call("get_cart", {}, "deterministic");
    if (!result.ok) {
      // Surface the real read failure instead of masking it behind a generic refusal.
      throw new CartProgressError(`Lecture fiable du panier impossible ; aucun nouvel ajout ne sera tenté : ${result.message}`);
    }
    const cart = (result.output as { cart?: Cart }).cart;
    if (!cart || !Array.isArray(cart.items) || !cart.storeId || cart.items.some((item) => !item.product?.id || !Number.isSafeInteger(item.quantity) || item.quantity < 0)) {
      throw new CartProgressError("Lecture fiable du panier impossible ; aucun nouvel ajout ne sera tenté.");
    }
    if (cart.storeId !== this.progress.storeId) throw new CartProgressError("Le magasin a changé : reprise bloquée pour préserver le panier.");
    this.progress.cart = cart;
    return cart;
  }

  private async confirm(intent: CartIntent, cart: Cart): Promise<boolean> {
    if (quantity(cart, intent.productId) !== intent.target) return false;
    const entry = this.progress.entries[intent.ingredientIndex];
    if (intent.operation === "add") entry.added += intent.delta;
    else entry.removed += intent.delta;
    this.progress.intent = undefined;
    this.trace.events.push({ type: "cart_verified", timestamp: this.trace.now(), ingredientIndex: intent.ingredientIndex,
      productId: intent.productId, quantity: intent.delta, operation: intent.operation });
    await this.state(intent.ingredientIndex, intent.operation === "add" ? "added" : "removed");
    return true;
  }

  /** Reconcile a possibly completed request BEFORE considering another write. */
  async reconcile(retry: boolean): Promise<void> {
    const intent = this.progress.intent;
    if (!intent) return;
    const cart = await this.read();
    if (await this.confirm(intent, cart)) return;
    if (quantity(cart, intent.productId) !== intent.before) {
      await this.state(intent.ingredientIndex, "verification_pending", "Quantité modifiée hors du parcours ; vérification manuelle nécessaire.");
      throw new CartProgressError(this.progress.entries[intent.ingredientIndex].error);
    }
    if (!retry) throw new CartProgressError("Une mutation reste à vérifier avant de continuer.");
    // Setting the SAME absolute target cannot add the same requirement twice.
    await this.write(intent);
  }

  private async write(intent: CartIntent): Promise<void> {
    this.progress.intent = intent;
    await this.state(intent.ingredientIndex, "verifying", "Vérification de la mutation du panier…");
    // Persist intent strictly before I/O. A failed checkpoint prevents the write.
    this.trace.events.push({ type: "cart_intent", timestamp: this.trace.now(), flowId: this.progress.flowId, ...intent });
    this.gate.permitPreparedQuantity(intent.productId, intent.target);
    let mutation;
    try {
      if (!this.takeCall()) throw new CartProgressError("Budget d'appels atteint avant mutation.");
      mutation = await this.executor.call("update_quantity", { product_id: intent.productId, quantity: intent.target }, "deterministic");
    } finally {
      this.gate.clearPreparedQuantity();
    }
    let cart: Cart;
    try { cart = await this.read(); }
    catch (error) {
      await this.state(intent.ingredientIndex, "verification_pending", "Résultat de la mutation inconnu ; relire le panier avant toute reprise.");
      throw error;
    }
    if (await this.confirm(intent, cart)) return;
    const unchanged = quantity(cart, intent.productId) === intent.before;
    await this.state(intent.ingredientIndex, unchanged ? "failed" : "verification_pending",
      mutation.ok ? "La quantité relue ne confirme pas la mutation." : mutation.message);
    // Keep the exact intent on failure, including failed HTTP requests that may have applied.
    throw new CartProgressError(this.progress.entries[intent.ingredientIndex].error);
  }

  async add(index: number, line: CartPreviewLine): Promise<void> {
    if (this.progress.finished) throw new CartProgressError("La révision de ce parcours est terminée.");
    if (!line.productId || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999) throw new CartProgressError("Ligne d'achat invalide.");
    if (this.progress.intent) await this.reconcile(true);
    const entry = this.progress.entries[index];
    if (!this.progress.selection?.pools[index]?.some((product) => product.id === line.productId && product.available)) throw new CartProgressError("Référence absente des résultats catalogue de ce besoin.");
    if (!entry || (entry.line && entry.line.productId !== line.productId)) throw new CartProgressError("Le produit d'un besoin déjà traité ne peut pas être remplacé implicitement.");
    if (entry.added > 0 || entry.status === "removed") return;
    entry.line = line;
    await this.save();
    const cart = await this.read();
    const before = quantity(cart, line.productId);
    const target = before + line.quantity;
    if (!Number.isSafeInteger(target) || target > 999) throw new CartProgressError("Quantité totale hors limites.");
    await this.write({ ingredientIndex: index, productId: line.productId, before, target, operation: "add", delta: line.quantity });
  }

  async remove(index: number): Promise<void> {
    if (this.progress.finished) throw new CartProgressError("La révision de ce parcours est terminée.");
    if (this.progress.intent) await this.reconcile(true);
    const entry = this.progress.entries[index];
    const owned = entry ? entry.added - entry.removed : 0;
    if (!entry?.line || owned <= 0) return;
    const cart = await this.read();
    const productId = entry.line.productId;
    const before = quantity(cart, productId);
    const totalOwned = this.progress.entries.filter((item) => item.line?.productId === productId).reduce((sum, item) => sum + item.added - item.removed, 0);
    if (before < (this.progress.baseline[productId] ?? 0) + totalOwned) {
      throw new CartProgressError("Le panier a changé : suppression bloquée pour préserver les quantités préexistantes.");
    }
    await this.write({ ingredientIndex: index, productId, before, target: before - owned, operation: "remove", delta: owned });
  }
}

export async function createCartProgress(recipe: GeneratedRecipe, request: ShoppingFlowRequest, executor: ToolExecutor): Promise<CartProgress> {
  const result = await executor.call("get_cart", {}, "deterministic");
  // A NON-EMPTY cart is expected and supported: existing quantities become the
  // protected baseline. Only an unreadable cart blocks a new run, and the real
  // cause must reach the user instead of the generic message.
  if (!result.ok) throw new CartProgressError(`Le panier initial doit être lisible avant de commencer : ${result.message}`);
  const cart = (result.output as { cart?: Cart }).cart;
  if (!cart?.storeId || !Array.isArray(cart.items)) throw new CartProgressError("Le panier initial doit être lisible avant de commencer : réponse sans panier exploitable.");
  const baseline: Record<string, number> = {};
  for (const item of cart.items) {
    if (!item.product?.id || !Number.isSafeInteger(item.quantity) || item.quantity < 0) throw new CartProgressError("Quantité initiale invalide.");
    baseline[item.product.id] = (baseline[item.product.id] ?? 0) + item.quantity;
  }
  return { formatVersion: 1, flowId: globalThis.crypto.randomUUID(), recipe, request, storeId: cart.storeId, baseline, cart,
    entries: recipe.ingredients.map((ingredient, ingredientIndex) => ({ ingredientIndex, ingredient: ingredient.name, status: "searching", added: 0, removed: 0 })), finished: false };
}
