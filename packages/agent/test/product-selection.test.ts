import { expect, it } from "vitest";
import { addToCart, getCart, listHabitualProducts, searchProduct, updateQuantity, toolError, type Product } from "@leclerc/contracts";
import { bindingFromContract, runShoppingFlow, SimulatedProvider, type ProductReview, type ProductReviewChoice, type ShoppingFlowLimits } from "../src/index.js";

const dry: Product = { id: "dry", label: "Haricots blancs secs 500 g", price: 2, available: true, packaging: "500 g" };
const cooked: Product = { id: "cooked", label: "Haricots blancs cuits en conserve 400 g", price: 1, available: true, packaging: "400 g" };
const recipe = { title: "Haricots mijotés", servings: 4,
  ingredients: [{ name: "haricots blancs secs", quantity: 750, unit: "g" }], steps: ["Faire tremper les haricots puis les cuire."] };
const select = (index = 0, product = dry) => ({ ingredientIndex: index, action: "select", productId: product.id,
  compatibility: "exact", labelEvidence: product.label, reason: "Produit sec adapté, quantité calculable à partir du paquet." });
const automatic = (review: ProductReview): ProductReviewChoice[] => review.items.map((item) => item.selectedProductId
  ? { ingredientIndex: item.ingredientIndex, productId: item.selectedProductId } : { ingredientIndex: item.ingredientIndex, skip: true });

async function run(options: {
  products?: Record<string, Product[]>;
  habitual?: Product[];
  decisions?: unknown[];
  steps?: string[];
  ingredients?: typeof recipe.ingredients;
  review?: (review: ProductReview) => ProductReviewChoice[];
  limits?: ShoppingFlowLimits;
  signal?: AbortSignal;
  onSearch?: () => void;
  habitsError?: boolean;
  selectionError?: string;
} = {}) {
  const searches: string[] = [];
  const mutations: unknown[] = [];
  const reviews: ProductReview[] = [];
  const chronology: string[] = [];
  let habitsCalls = 0;
  const cartQuantities = new Map<string, number>();
  const allProducts = [dry, cooked, ...(options.habitual ?? []), ...Object.values(options.products ?? {}).flat()];
  const cart = () => ({ storeId: "1", items: [...cartQuantities].map(([id, quantity]) => ({ product: allProducts.find((p) => p.id === id)!, quantity, lineTotal: quantity * (allProducts.find((p) => p.id === id)?.price ?? 0) })), itemCount: cartQuantities.size, total: 0 });
  const provider = new SimulatedProvider({ script: [
    { text: JSON.stringify({ ...recipe, steps: options.steps ?? recipe.steps, ingredients: options.ingredients ?? recipe.ingredients }) },
    ...(options.selectionError ? [{ error: options.selectionError }] : []),
    ...(options.decisions ?? [[select()]]).map((decisions) => ({ text: typeof decisions === "string" ? decisions : JSON.stringify({ decisions }) })),
  ] });
  const result = await runShoppingFlow({ provider, request: { message: "Des haricots pour 4, avec mes produits habituels", servings: 4 },
    limits: options.limits, signal: options.signal,
    bindings: [
      bindingFromContract(listHabitualProducts, async () => { habitsCalls++; return options.habitsError ? toolError("SESSION_EXPIRED", "Session expirée") : { ok: true, output: { products: options.habitual ?? [] } }; }),
      bindingFromContract(searchProduct, async ({ query }) => {
        searches.push(query); chronology.push("search"); options.onSearch?.();
        return { ok: true, output: { products: options.products?.[query] ?? [dry, cooked] } };
      }),
      bindingFromContract(addToCart, async (input) => { mutations.push(input); return { ok: true, output: { cart: { items: [], itemCount: 0, total: 0, storeId: "1" } } }; }),
      bindingFromContract(updateQuantity, async (input) => { mutations.push(input); cartQuantities.set(input.productId, input.quantity); return { ok: true, output: { cart: cart() } }; }),
      bindingFromContract(getCart, async () => ({ ok: true, output: { cart: cart() } })),
    ], review: (review) => { reviews.push(review); chronology.push("review"); return (options.review ?? automatic)(review); },
    approval: () => { chronology.push("approval"); return { approved: false }; },
  });
  return { result, searches, mutations, reviews, chronology, habitsCalls, provider };
}

it("chooses the dry product and calculates two packages, with habits loaded once", async () => {
  const ctx = await run({ habitual: [dry] });
  expect(ctx.result.preview?.lines.map((line) => [line.productId, line.quantity])).toEqual([["dry", 2]]);
  expect(ctx.reviews).toHaveLength(0);
  expect(ctx.result.progress?.entries[0]).toMatchObject({ status: "added", added: 2 });
  expect(ctx.result.progress?.selection?.habitualIds).toContain("dry");
  expect(ctx.habitsCalls).toBe(1);
  expect(ctx.provider.calls).toBe(2);
  expect(ctx.mutations).toEqual([{ productId: "dry", quantity: 2 }]);
});

it("rejects an automatic cooked substitute even when the model calls it exact and habitual", async () => {
  const ctx = await run({ habitual: [cooked], decisions: [[select(0, cooked)]] });
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
  expect(ctx.reviews[0].items[0].reason).toContain("sec");
  expect(ctx.result.preview?.lines).toEqual([]);
});

it("uses the recipe's soaking step to detect an implicit need for dry beans", async () => {
  const ctx = await run({ ingredients: [{ name: "haricots blancs", quantity: 750, unit: "g" }], decisions: [[select(0, cooked)]] });
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
});

it("does not invent packaging, and requires an explicit package count in the grouped review", async () => {
  const unpacked = { ...dry, packaging: undefined };
  const ctx = await run({ products: { "haricots blancs secs": [unpacked] }, decisions: [[select(0, unpacked)]],
    review: (review) => { expect(review.items[0].uncertain).toBe(true); return [{ ingredientIndex: 0, productId: "dry", quantity: 3 }]; } });
  expect(ctx.result.preview?.lines[0].quantity).toBe(3);
  const missing = await run({ products: { "haricots blancs secs": [unpacked] }, review: () => [{ ingredientIndex: 0, productId: "dry" }] });
  expect(missing.result.preview?.lines).toEqual([]);
});

it.each([
  { decisions: [[{ ...select(), productId: "invented" }]] },
  { decisions: [[{ ...select(), labelEvidence: "un poids inventé" }]] },
  { decisions: [[select(), select()]] },
])("invalid or ungrounded evaluation becomes a human doubt: %j", async ({ decisions }) => {
  const ctx = await run({ decisions });
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
  expect(ctx.result.preview?.lines).toEqual([]);
  expect(ctx.mutations).toEqual([]);
});

it("re-evaluates only unresolved ingredients after a targeted search, then reviews them together", async () => {
  const rice: Product = { id: "rice", label: "Riz 1 kg", packaging: "1 kg", price: 2, available: true };
  const ctx = await run({ ingredients: [...recipe.ingredients, { name: "riz", quantity: 500, unit: "g" }],
    products: { "haricots blancs secs": [cooked], "riz": [rice], "haricots secs 500 g": [dry] },
    decisions: [[{ ingredientIndex: 0, action: "research", query: "haricots secs 500 g", reason: "Trouver un produit sec." }, select(1, rice)], [select()]],
  });
  expect(ctx.searches).toEqual(["haricots blancs secs", "riz", "haricots secs 500 g"]);
  expect(ctx.reviews).toHaveLength(0);
  expect(ctx.chronology).toEqual(["search", "search", "search"]);
  expect(ctx.result.preview?.lines).toHaveLength(2);
  expect(ctx.result.trace.filter((event) => event.type === "selection_round")).toHaveLength(2);
});

it("stops after three evaluations and three distinct searches even if the model wants another", async () => {
  const ctx = await run({ products: { "haricots blancs secs": [cooked], "haricots secs": [{ ...cooked, price: 2 }], "haricots secs 500g": [dry] },
    decisions: ["haricots secs", "haricots secs 500g", "encore"].map((query) => [{ ingredientIndex: 0, action: "research", query, reason: "Vérifier le conditionnement." }]),
  });
  expect(ctx.searches).toHaveLength(3);
  expect(ctx.provider.calls).toBe(4);
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
});

it("stops early when another query supplies no new information", async () => {
  const ctx = await run({ decisions: [[{ ingredientIndex: 0, action: "research", query: "haricots secs", reason: "Vérifier le paquet." }]] });
  expect(ctx.searches).toHaveLength(2);
  expect(ctx.provider.calls).toBe(2);
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
});

it("adds an uncertain choice only after the human answer and rejects references outside the candidates", async () => {
  const alternative = { ...dry, id: "alternative", label: "Haricots blancs secs 1 kg", packaging: "1 kg" };
  const ctx = await run({ products: { "haricots blancs secs": [dry, alternative] }, decisions: [[{ ingredientIndex: 0, action: "clarify", reason: "Deux produits plausibles." }]], review: () => [{ ingredientIndex: 0, productId: "alternative" }] });
  expect(ctx.result.preview?.lines[0]).toMatchObject({ productId: "alternative", quantity: 1 });
  const alien = await run({ decisions: [[{ ingredientIndex: 0, action: "clarify", reason: "Deux produits plausibles." }]], review: () => [{ ingredientIndex: 0, productId: "alien" }] });
  expect(alien.result.preview?.lines).toEqual([]);
});

it("caps a clarification at three real available candidates", async () => {
  const products = Array.from({ length: 12 }, (_, index) => ({ ...dry, id: String(index) }));
  const ctx = await run({ products: { "haricots blancs secs": products }, decisions: [[{ ingredientIndex: 0, action: "clarify", candidateIds: products.map((p) => p.id), reason: "Plusieurs marques possibles." }]] });
  expect(ctx.reviews[0].items[0].candidates).toHaveLength(3);
  expect(ctx.reviews[0].items[0].selectedProductId).toBeUndefined();
});

it("reports unavailable habits without assuming preferences or selecting a different provider", async () => {
  const ctx = await run({ habitsError: true });
  expect(ctx.result.trace.some((event) => event.type === "error" && event.code === "HABITS_UNAVAILABLE")).toBe(true);
  expect(ctx.result.progress?.selection?.habitualIds).toEqual([]);
  expect(ctx.result.preview?.lines[0].productId).toBe("dry");
});

it("honours cancellation during searches without opening a review or mutating the cart", async () => {
  const controller = new AbortController();
  const ctx = await run({ signal: controller.signal, onSearch: () => controller.abort() });
  expect(ctx.result.status).toBe("cancelled");
  expect(ctx.reviews).toEqual([]);
  expect(ctx.mutations).toEqual([]);
});

it("honours the total model-call budget without reverting to an automatic lexical selection", async () => {
  const ctx = await run({ limits: { maxTurns: 1 } });
  expect(ctx.provider.calls).toBe(1);
  expect(ctx.reviews[0].items[0].uncertain).toBe(true);
  expect(ctx.result.preview?.lines).toEqual([]);
});

it("accepts a complete JSON decision wrapped in a Markdown code fence", async () => {
  const ctx = await run({ decisions: ["```json\n" + JSON.stringify({ decisions: [select()] }) + "\n```"] });
  expect(ctx.reviews).toHaveLength(0);
  expect(ctx.result.progress?.entries[0]).toMatchObject({ status: "added", added: 2 });
});

it("keeps a malformed evaluation resumable instead of asking the human to replace the model", async () => {
  const ctx = await run({ decisions: ["du JSON invalide"] });
  expect(ctx.reviews).toEqual([]);
  expect(ctx.mutations).toEqual([]);
  expect(ctx.result.status).toBe("partial_failure");
  expect(ctx.result.error?.message).toContain("JSON");
  expect(ctx.result.progress?.selection?.evaluationsComplete).not.toBe(true);
});

it("surfaces the provider diagnostic instead of turning an API failure into human product choices", async () => {
  const ctx = await run({ selectionError: "Quota Mistral dépassé (HTTP 429)." });
  expect(ctx.reviews).toEqual([]);
  expect(ctx.mutations).toEqual([]);
  expect(ctx.result.error?.message).toContain("HTTP 429");
  expect(ctx.result.progress?.entries[0]).toMatchObject({ status: "failed" });
});
