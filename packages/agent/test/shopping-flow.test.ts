import { describe, expect, it } from "vitest";
import { runShoppingFlow, resumeShoppingFlow } from "../src/shopping-flow.js";
import { bindingFromContract, type ToolBinding } from "../src/engine.js";
import { ProviderUnavailableError, SimulatedProvider } from "../src/index.js";
import type { ModelProvider, ProviderProposal } from "../src/index.js";
import { addToCart, getCart, searchProduct, toolError } from "@leclerc/contracts";
import type { Cart, Product, ToolError } from "@leclerc/contracts";

// ---- inline fake capability bindings (the real mocks live in @leclerc/harness)

const emptyCart: Cart = { items: [], itemCount: 0, total: 0, storeId: "053701" };

class FakeStore {
  cart: Cart = { ...emptyCart, items: [] };
  addCalls: Array<{ productId: string; quantity: number }> = [];
  applied: Array<{ productId: string; quantity: number }> = [];
  searchCalls: string[] = [];
  getCartCalls = 0;
  /** Product id whose add_to_cart must fail (fault injection). */
  failAddFor: string | null = null;
  /** Deterministic search results per query. */
  searchIndex: Record<string, Product[]> = {};

  bindings(): ToolBinding[] {
    return [
      bindingFromContract(searchProduct, async (input) => {
        this.searchCalls.push(input.query);
        const products = this.searchIndex[input.query] ?? [];
        return products.length === 0
          ? toolError("EMPTY_RESULT", `Aucun produit trouvé pour « ${input.query} ».`)
          : { ok: true, output: { products } };
      }),
      bindingFromContract(addToCart, async (input) => {
        this.addCalls.push({ productId: input.productId, quantity: input.quantity });
        if (this.failAddFor === input.productId) {
          return toolError("CART_MUTATION_REFUSED", "Injection de panne : ajout refusé.");
        }
        this.applied.push({ productId: input.productId, quantity: input.quantity });
        this.cart = {
          ...emptyCart,
          items: this.applied.map((c) => ({
            product: { id: c.productId, label: c.productId, price: 1, available: true },
            quantity: c.quantity,
            lineTotal: c.quantity,
          })),
          itemCount: this.applied.length,
          total: this.applied.reduce((s, c) => s + c.quantity, 0),
        };
        return { ok: true, output: { cart: this.cart } };
      }),
      bindingFromContract(getCart, async () => {
        this.getCartCalls++;
        return { ok: true, output: { cart: this.cart } };
      }),
    ];
  }
}

const chicken: Product = { id: "P-1001", label: "Filets de poulet 600 g", price: 7.2, available: true, packaging: "600 g" };
const curry: Product = { id: "P-1002", label: "Poudre de curry 100 g", price: 2.85, available: true, packaging: "100 g" };
const rice: Product = { id: "P-1004", label: "Riz basmati 1 kg", price: 3.4, available: true, packaging: "1 kg" };
const coconut400: Product = { id: "P-1003", label: "Lait de coco 400 ml", price: 1.95, available: true, packaging: "400 ml" };
const coconut200: Product = { id: "P-2001", label: "Lait de coco 200 ml", price: 1.35, available: true, packaging: "200 ml" };

const RECIPE = {
  title: "Poulet au curry",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g" },
    { name: "poudre de curry", quantity: 20, unit: "g" },
  ],
  steps: ["Couper le poulet en dés.", "Ajouter le curry et laisser mijoter."],
};
const RECIPE_JSON = JSON.stringify(RECIPE);

const RECIPE_3 = {
  ...RECIPE,
  ingredients: [...RECIPE.ingredients, { name: "riz basmati", quantity: 500, unit: "g" }],
};
const RECIPE_3_JSON = JSON.stringify(RECIPE_3);

function defaultStore(): FakeStore {
  const store = new FakeStore();
  store.searchIndex = {
    "filets de poulet": [chicken],
    "poudre de curry": [curry],
    "riz basmati": [rice],
    "lait de coco": [coconut400, coconut200],
  };
  return store;
}

const REQUEST = {
  message: "un poulet au curry sans crème pour quatre personnes et prépare les courses",
  servings: 4,
  excludedIngredients: ["crème"],
};

// ---- A01: happy path ------------------------------------------------------------

it("matches the ingredient identity across singular/plural and rejects unrelated prepared foods", async () => {
  const store = new FakeStore();
  store.searchIndex["haricots blancs secs"] = [
    { id: "dry", label: "Haricot blanc sec - 500g", price: 2, available: true, packaging: "500 g" },
    { id: "slices", label: "Tranches végé aux haricots blancs secs", price: 2, available: true },
    { id: "meal", label: "Plat cuisiné haricots blancs secs", price: 2, available: true },
  ];
  const result = await runShoppingFlow({
    provider: new SimulatedProvider({ script: [{ text: JSON.stringify({
      ...RECIPE, servings: 5,
      ingredients: [{ name: "haricots blancs secs", quantity: 750, unit: "g" }],
    }) }] }),
    bindings: store.bindings(), request: { message: "un cassoulet pour 5", servings: 5 },
    approval: () => ({ approved: false }),
  });
  expect(result.preview?.lines.map((line) => [line.productId, line.quantity])).toEqual([["dry", 2]]);
  expect(store.addCalls).toEqual([]);
});

it("counts five sausages using catalogue piece counts even when a weight is also printed", async () => {
  const store = new FakeStore();
  store.searchIndex["saucisses de Toulouse"] = [{
    id: "sausages", label: "Saucisses de Toulouse x4 - 500g", price: 4, available: true,
    packaging: "500 g / 4 pièce",
  }];
  const result = await runShoppingFlow({
    provider: new SimulatedProvider({ script: [{ text: JSON.stringify({
      ...RECIPE, servings: 5,
      ingredients: [{ name: "saucisses de Toulouse", quantity: 5, unit: "pièce" }],
    }) }] }),
    bindings: store.bindings(), request: { message: "un cassoulet pour 5", servings: 5 },
    approval: () => ({ approved: false }),
  });
  expect(result.preview?.lines[0].quantity).toBe(2);
  expect(result.issues).toEqual([]);
});

describe("runShoppingFlow — happy path", () => {
  it("completes: recipe, deterministic searches, packaging ceil, approval, sequential adds", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });

    expect(result.status).toBe("completed");
    expect(result.recipe?.title).toBe("Poulet au curry");
    expect(result.recipe?.servings).toBe(4);

    // Packaging ceil rule: 800 g / 600 g packs -> 2 ; 20 g / 100 g packs -> 1.
    expect(result.preview?.lines.map((l) => [l.productId, l.quantity])).toEqual([
      ["P-1001", 2],
      ["P-1002", 1],
    ]);
    expect(result.preview?.total).toBe(2 * 7.2 + 1 * 2.85);

    // Only after approval: sequential add_to_cart calls with real catalogue ids.
    expect(store.addCalls).toEqual([
      { productId: "P-1001", quantity: 2 },
      { productId: "P-1002", quantity: 1 },
    ]);
    expect(store.searchCalls).toEqual(["filets de poulet", "poudre de curry"]);

    // Cart re-read at the end.
    expect(result.cart?.itemCount).toBe(2);
    expect(store.getCartCalls).toBe(1);

    // Gap report for a completed run.
    expect(result.gap?.applied.length).toBe(2);
    expect(result.gap?.failed).toEqual([]);
    expect(result.gap?.notAttempted).toEqual([]);
  });

  it("records ZERO mutation tool calls before the approval decision (A04 ordering)", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    const events = result.trace;
    const approvalIdx = events.findIndex((e) => e.type === "approval_decision");
    expect(approvalIdx).toBeGreaterThan(-1);
    const mutationBefore = events.findIndex(
      (e) => e.type === "tool_call" && e.name === "add_to_cart" && approvalIdx > -1 && events.indexOf(e) < approvalIdx,
    );
    expect(mutationBefore).toBe(-1);
    const mutationAfter = events.filter((e) => e.type === "tool_call" && e.name === "add_to_cart");
    expect(mutationAfter.length).toBe(2);
  });

  it("keeps the trace evaluable: user_message, model_text, tool events, approval, all timestamped", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    const types = result.trace.map((e) => e.type);
    expect(types[0]).toBe("user_message");
    expect(types).toContain("model_text");
    expect(types).toContain("approval_request");
    expect(types).toContain("approval_decision");
    expect(types.filter((t) => t === "tool_call").length).toBeGreaterThanOrEqual(2);
    for (const event of result.trace) {
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
  });
});

// ---- A05: refusal ----------------------------------------------------------------

describe("runShoppingFlow — refusal", () => {
  it("refused approval: no mutation executed at all", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: false, reason: "trop cher" }),
    });
    expect(result.status).toBe("refused");
    expect(store.addCalls).toEqual([]);
    const decision = result.trace.find((e) => e.type === "approval_decision");
    expect(decision).toMatchObject({ type: "approval_decision", decision: "refused" });
    // The preview was still built and submitted for decision.
    expect(result.preview?.lines.length).toBe(2);
  });
});

// ---- A06: repair-once / invalid ---------------------------------------------------

describe("runShoppingFlow — recipe validation", () => {
  it("repairs an invalid recipe exactly once (A06a)", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: "voici la recette : ```json {...}```" }, { text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("completed");
    const repairs = result.trace.filter((e) => e.type === "repair_attempt");
    expect(repairs.length).toBe(1);
  });

  it("gives up with an explicit error after one failed repair (A06b), zero mutations", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: "pas du json" }, { text: "toujours pas du json" }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("recipe_invalid");
    expect(store.addCalls).toEqual([]);
    expect(store.searchCalls).toEqual([]);
    const errorEvent = result.trace.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", code: "RECIPE_INVALID" });
    expect(result.error?.message).toBeTruthy();
  });

  it("rejects a recipe whose servings do not match the request", async () => {
    const wrongServings = JSON.stringify({ ...RECIPE, servings: 2 });
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: wrongServings }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("recipe_invalid");
    expect(store.searchCalls).toEqual([]);
  });

  it("rejects a recipe containing an excluded ingredient (A02)", async () => {
    const withCreme = JSON.stringify({
      ...RECIPE,
      ingredients: [...RECIPE.ingredients, { name: "crème fraîche épaisse", quantity: 10, unit: "cl" }],
    });
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: withCreme }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("recipe_invalid");
    expect(store.addCalls).toEqual([]);
  });
});

// ---- A07 / A09: matching, not-found, ambiguity ------------------------------------

describe("runShoppingFlow — matching", () => {
  it("signals a not-found ingredient and proceeds with the others (A07)", async () => {
    const store = defaultStore();
    store.searchIndex["sauce worcestershire"] = [];
    const recipe = JSON.stringify({
      ...RECIPE,
      ingredients: [...RECIPE.ingredients, { name: "sauce worcestershire", quantity: 5, unit: "cl" }],
    });
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: recipe }] }),
      bindings: store.bindings(),
      request: { message: "poulet au curry", servings: 4 },
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("completed");
    expect(result.issues.some((i) => i.kind === "ingredient_not_found" && i.ingredient === "sauce worcestershire")).toBe(true);
    expect(result.preview?.lines.length).toBe(2);
  });

  it("asks a clarification on an ambiguous match and uses the answered product (A09)", async () => {
    const store = defaultStore();
    const recipe = JSON.stringify({
      ...RECIPE,
      ingredients: [{ name: "lait de coco", quantity: 400, unit: "ml" }],
    });
    const questions: unknown[] = [];
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: recipe }] }),
      bindings: store.bindings(),
      request: { message: "curry au lait de coco", servings: 4 },
      approval: () => ({ approved: true }),
      clarification: (q) => {
        questions.push(q);
        return { productId: "P-2001" };
      },
    });
    expect(result.status).toBe("completed");
    expect(questions.length).toBe(1);
    const question = questions[0] as { candidates: Array<{ productId: string }> };
    expect(question.candidates.map((c) => c.productId)).toEqual(["P-1003", "P-2001"]);
    expect(result.preview?.lines[0]).toMatchObject({ productId: "P-2001", quantity: 2 });
    const clarificationEvent = result.trace.find((e) => e.type === "clarification");
    expect(clarificationEvent).toMatchObject({ type: "clarification" });
  });

  it("skips an ambiguous ingredient when the answer is skip (issue recorded)", async () => {
    const store = defaultStore();
    const recipe = JSON.stringify({
      ...RECIPE,
      ingredients: [{ name: "lait de coco", quantity: 400, unit: "ml" }],
    });
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: recipe }] }),
      bindings: store.bindings(),
      request: { message: "curry", servings: 4 },
      approval: () => ({ approved: true }),
      clarification: () => ({ skip: true }),
    });
    expect(result.status).toBe("completed");
    expect(result.issues.some((i) => i.kind === "ambiguous_unresolved")).toBe(true);
    expect(result.preview?.lines).toEqual([]);
  });

  it("applies an explicit default quantity of 1 when packaging is missing or incompatible", async () => {
    const store = defaultStore();
    const noPack: Product = { id: "P-1010", label: "Bouillon de volaille", price: 1.5, available: true };
    store.searchIndex["bouillon de volaille"] = [noPack];
    const garlic: Product = { id: "P-1006", label: "Ail 200 g", price: 1.1, available: true, packaging: "200 g" };
    store.searchIndex["ail"] = [garlic];
    const recipe = JSON.stringify({
      ...RECIPE,
      ingredients: [
        { name: "bouillon de volaille", quantity: 3, unit: "pièce" },
        { name: "ail", quantity: 2, unit: "gousse" },
      ],
    });
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: recipe }] }),
      bindings: store.bindings(),
      request: { message: "bouillon ail", servings: 4 },
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("completed");
    expect(result.preview?.lines.map((l) => [l.productId, l.quantity])).toEqual([
      ["P-1010", 1],
      ["P-1006", 1],
    ]);
    expect(result.issues.filter((i) => i.kind === "packaging_default").length).toBe(2);
  });
});

// ---- cancellation / limits -------------------------------------------------------

describe("runShoppingFlow — cancellation and limits", () => {
  it("stops cleanly with status cancelled on a pre-aborted signal, provider untouched", async () => {
    const store = defaultStore();
    const provider = new SimulatedProvider({ script: [{ text: RECIPE_JSON }] });
    const controller = new AbortController();
    controller.abort();
    const result = await runShoppingFlow({
      provider,
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(provider.calls).toBe(0);
    expect(store.addCalls).toEqual([]);
  });

  it("stops with limits_exceeded when the tool-call budget runs out before mutations", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_JSON }] }),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
      limits: { maxToolCalls: 1 },
    });
    expect(result.status).toBe("limits_exceeded");
    expect(store.addCalls).toEqual([]);
  });
});

// ---- A10: provider unavailable ---------------------------------------------------

class UnavailableProvider implements ModelProvider {
  readonly id = "webgpu:onnx";
  readonly modelVersion = "onnx-test";
  readonly capabilities = { toolCalling: true, streaming: false };
  calls = 0;
  constructor(private readonly withProposal: boolean) {}
  async generate(): Promise<never> {
    this.calls++;
    const proposal: ProviderProposal | undefined = this.withProposal
      ? { providerId: "mistral-byok", label: "Mistral (clé personnelle)", consentRequired: true }
      : undefined;
    throw new ProviderUnavailableError(
      "session WebGPU impossible",
      "WebGPU est indisponible : création de session impossible sur cette machine.",
      proposal,
    );
  }
}

describe("runShoppingFlow — provider unavailable", () => {
  it("surfaces the diagnostic and the consent-only proposal, never instantiating the alternative (A10)", async () => {
    const store = defaultStore();
    const provider = new UnavailableProvider(true);
    const result = await runShoppingFlow({
      provider,
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("provider_unavailable");
    expect(result.diagnostic).toContain("WebGPU");
    expect(result.proposal).toMatchObject({ providerId: "mistral-byok", consentRequired: true });
    expect(provider.calls).toBe(1);
    expect(store.searchCalls).toEqual([]);
    expect(store.addCalls).toEqual([]);
  });

  it("attaches the default consent-only Mistral proposal when the error carries none", async () => {
    const store = defaultStore();
    const result = await runShoppingFlow({
      provider: new UnavailableProvider(false),
      bindings: store.bindings(),
      request: REQUEST,
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("provider_unavailable");
    expect(result.proposal).toMatchObject({ providerId: "mistral-byok", consentRequired: true });
  });
});

// ---- A08: partial failure, gap report, resume ------------------------------------

describe("runShoppingFlow — partial failure and resume", () => {
  it("stops at the first mutation failure, re-reads the cart and produces a gap report + resume (A08)", async () => {
    const store = defaultStore();
    store.failAddFor = "P-1002";
    const result = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_3_JSON }] }),
      bindings: store.bindings(),
      request: { message: "poulet au curry avec riz", servings: 4 },
      approval: () => ({ approved: true }),
    });
    expect(result.status).toBe("partial_failure");
    // First add applied, second failed, third never attempted.
    expect(store.addCalls.map((c) => c.productId)).toEqual(["P-1001", "P-1002"]);
    expect(result.gap?.applied.map((l) => l.productId)).toEqual(["P-1001"]);
    expect(result.gap?.failed.length).toBe(1);
    expect(result.gap?.failed[0]).toMatchObject({ line: { productId: "P-1002" } });
    expect((result.gap?.failed[0] as { error: ToolError }).error.code).toBe("CART_MUTATION_REFUSED");
    expect(result.gap?.notAttempted.map((l) => l.productId)).toEqual(["P-1004"]);
    // Cart was re-read after the failure.
    expect(store.getCartCalls).toBe(1);
    expect(result.cart?.itemCount).toBe(1);
    // Resume proposal: the pending line, the applied history and the failure.
    expect(result.resume?.pending.map((l) => l.productId)).toEqual(["P-1004"]);
    expect(result.resume?.applied.map((l) => l.productId)).toEqual(["P-1001"]);
    expect(result.resume?.failed).toMatchObject({ line: { productId: "P-1002" } });
  });

  it("resumeShoppingFlow completes the rest only after a NEW approval", async () => {
    const store = defaultStore();
    store.failAddFor = "P-1002";
    const partial = await runShoppingFlow({
      provider: new SimulatedProvider({ script: [{ text: RECIPE_3_JSON }] }),
      bindings: store.bindings(),
      request: { message: "poulet au curry avec riz", servings: 4 },
      approval: () => ({ approved: true }),
    });
    const resume = partial.resume;
    expect(resume).toBeDefined();
    if (!resume) throw new Error("resume missing");

    store.failAddFor = null;

    // A refused resume approval mutates nothing.
    const refused = await resumeShoppingFlow({
      bindings: store.bindings(),
      resume,
      approval: () => ({ approved: false }),
    });
    expect(refused.status).toBe("refused");
    expect(store.addCalls.map((c) => c.productId)).toEqual(["P-1001", "P-1002"]);

    // A new approval completes the pending line.
    const done = await resumeShoppingFlow({
      bindings: store.bindings(),
      resume,
      approval: () => ({ approved: true }),
    });
    expect(done.status).toBe("completed");
    expect(store.addCalls.map((c) => c.productId)).toEqual(["P-1001", "P-1002", "P-1004"]);
    expect(done.gap?.applied.map((l) => l.productId)).toEqual(["P-1001", "P-1004"]);
    expect(done.gap?.failed.map((f) => f.line.productId)).toEqual(["P-1002"]);
    expect(done.gap?.notAttempted).toEqual([]);
    expect(done.cart?.itemCount).toBe(2);
  });
});
