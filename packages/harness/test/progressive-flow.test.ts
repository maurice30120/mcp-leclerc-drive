import { expect, it } from "vitest";
import {
  ApprovalGate, ProgressiveCart, SimulatedProvider, ToolExecutor, bindingFromContract, createTraceBuilder, runShoppingFlow,
  type CartProgress, type ProductReview, type ProductReviewChoice, type ToolBinding,
} from "@leclerc/agent";
import { getCart, listHabitualProducts, searchProduct, updateQuantity, toolError, type Product } from "@leclerc/contracts";
import { createMockLeclerc } from "../src/mocks/mock-leclerc.js";
import { FIXTURE_PRODUCTS } from "../src/mocks/fixtures.js";

const rice = FIXTURE_PRODUCTS.find((p) => p.id === "P-1004")!;
const coconut = FIXTURE_PRODUCTS.find((p) => p.id === "P-1003")!;
const extra: Product = { ...coconut, id: "P-3001", label: "Lait de coco bio 400 ml" };
const recipe = { title: "Riz coco", servings: 4, ingredients: [{ name: "riz basmati", quantity: 500, unit: "g" }, { name: "lait de coco", quantity: 400, unit: "ml" }], steps: ["Cuire le riz dans le lait de coco."] };
const choose = (index: number, product: Product) => ({ ingredientIndex: index, action: "select", productId: product.id, labelEvidence: product.label, compatibility: "exact", reason: "Produit adapté et quantité calculable." });
const json = (decisions: unknown[]) => ({ text: JSON.stringify({ decisions }) });

function environment() {
  const mock = createMockLeclerc({ products: [...FIXTURE_PRODUCTS, extra] });
  mock.call("set_store", { storeId: "053701" });
  const writes: { productId: string; quantity: number }[] = [];
  let loseWriteResponse = false;
  let loseVerification = false;
  let written = false;
  const bindings: ToolBinding[] = [
    bindingFromContract(searchProduct, async (input) => mock.call("search_product", input)),
    bindingFromContract(listHabitualProducts, async () => mock.call("list_habitual_products")),
    bindingFromContract(getCart, async () => {
      if (written && loseVerification) { loseVerification = false; return toolError("TRANSIENT_ERROR", "Réponse de lecture perdue"); }
      return mock.call("get_cart");
    }),
    bindingFromContract(updateQuantity, async (input) => {
      writes.push(input); written = true;
      const result = mock.call("update_quantity", { product_id: input.productId, quantity: input.quantity });
      if (loseWriteResponse) { loseWriteResponse = false; return toolError("TRANSIENT_ERROR", "Réponse de mutation perdue"); }
      return result;
    }),
  ];
  const amount = (id: string) => mock.state.cart.items.find((item) => item.product.id === id)?.quantity ?? 0;
  const request = { message: "Riz coco pour quatre", servings: 4 };
  const run = (options: { provider?: SimulatedProvider; progress?: CartProgress; review?: (review: ProductReview) => ProductReviewChoice[]; checkpoint?: (p: CartProgress) => void; signal?: AbortSignal } = {}) => runShoppingFlow({
    bindings, request, provider: options.provider ?? new SimulatedProvider({ script: [{ text: JSON.stringify(recipe) }, json([choose(0, rice), choose(1, coconut)])] }),
    ...options, approval: () => { throw new Error("Aucune approbation globale ne doit être demandée."); },
  });
  const remove = async (progress: CartProgress, index: number) => {
    const gate = new ApprovalGate(() => ({ approved: false }));
    const trace = createTraceBuilder();
    const controller = new ProgressiveCart(progress, new ToolExecutor({ bindings, gate, trace }), gate, trace);
    await controller.remove(index);
    return progress;
  };
  return { mock, bindings, run, remove, amount, writes, loseResponse: () => { loseWriteResponse = true; }, loseRead: () => { written = false; loseVerification = true; } };
}

it("adds a solid choice before the grouped human question; three plausible choices stay pending", async () => {
  const env = environment();
  let reviewed = false;
  const provider = new SimulatedProvider({ script: [{ text: JSON.stringify(recipe) }, json([choose(0, rice), {
    ...choose(1, coconut), candidateIds: [coconut.id, "P-2001", extra.id],
  }])] });
  const result = await env.run({ provider, review: (review) => {
    reviewed = true;
    expect(env.amount(rice.id)).toBe(1);
    expect(env.amount(coconut.id)).toBe(0);
    expect(review.items).toHaveLength(1);
    expect(review.items[0].candidates).toHaveLength(3);
    return [{ ingredientIndex: 1, productId: coconut.id }];
  } });
  expect(reviewed).toBe(true);
  expect(result.status).toBe("completed");
  expect(env.amount(coconut.id)).toBe(1);
  expect(result.trace.some((event) => event.type === "approval_request")).toBe(false);
  expect(result.progress?.entries.map((entry) => entry.status)).toEqual(["added", "added"]);
});

it("preserves preexisting quantities when adding and undoing only the agent's contribution", async () => {
  const env = environment();
  env.mock.call("update_quantity", { product_id: rice.id, quantity: 5 });
  const result = await env.run();
  expect(env.amount(rice.id)).toBe(6);
  expect(result.progress?.entries[0].added).toBe(1);
  await env.remove(result.progress!, 0);
  expect(env.amount(rice.id)).toBe(5);
  expect(env.amount(coconut.id)).toBe(1);
  expect(result.progress?.entries[0]).toMatchObject({ added: 1, removed: 1, status: "removed" });
  const writes = env.writes.length;
  await env.remove(result.progress!, 0);
  expect(env.writes).toHaveLength(writes);
});

it("runs a second recipe on the cart filled by the first (dirty cart is the normal case)", async () => {
  const env = environment();
  const first = await env.run();
  expect(first.status).toBe("completed");
  expect(env.amount(rice.id)).toBe(1);
  const second = await env.run();
  expect(second.status).toBe("completed");
  expect(second.progress?.baseline[rice.id]).toBe(1);
  expect(env.amount(rice.id)).toBe(2);
  await env.remove(second.progress!, 0);
  expect(env.amount(rice.id)).toBe(1);
  expect(env.amount(coconut.id)).toBe(2);
});

it("surfaces the underlying read failure instead of the generic initial-cart message", async () => {
  const mock = createMockLeclerc({ products: FIXTURE_PRODUCTS });
  mock.call("set_store", { storeId: "053701" });
  const bindings: ToolBinding[] = [
    bindingFromContract(searchProduct, async (input) => mock.call("search_product", input)),
    bindingFromContract(listHabitualProducts, async () => mock.call("list_habitual_products")),
    bindingFromContract(getCart, async () => toolError("CAPABILITY_FAILED", "Lecture du panier impossible : onglet Leclerc injoignable.")),
    bindingFromContract(updateQuantity, async (input) => mock.call("update_quantity", { product_id: input.productId, quantity: input.quantity })),
  ];
  const result = await runShoppingFlow({
    bindings,
    request: { message: "Riz coco pour quatre", servings: 4 },
    provider: new SimulatedProvider({ script: [{ text: JSON.stringify(recipe) }] }),
    approval: () => { throw new Error("Aucune approbation globale ne doit être demandée."); },
  });
  expect(result.status).toBe("partial_failure");
  expect(result.error?.message).toContain("Le panier initial doit être lisible avant de commencer");
  expect(result.error?.message).toContain("onglet Leclerc injoignable");
});

it("keeps independent contributions when two ingredients choose the same product", async () => {
  const env = environment();
  env.mock.call("update_quantity", { product_id: rice.id, quantity: 3 });
  const provider = new SimulatedProvider({ script: [{ text: JSON.stringify({ ...recipe, ingredients: [{ name: "riz basmati", quantity: 500, unit: "g" }, { name: "riz", quantity: 250, unit: "g" }] }) }, json([choose(0, rice), choose(1, rice)])] });
  const result = await env.run({ provider });
  expect(env.amount(rice.id)).toBe(5);
  await env.remove(result.progress!, 0);
  expect(env.amount(rice.id)).toBe(4);
  await env.remove(result.progress!, 1);
  expect(env.amount(rice.id)).toBe(3);
});

it("a lost mutation response is confirmed from the cart without re-adding", async () => {
  const env = environment(); env.loseResponse();
  const result = await env.run();
  expect(result.status).toBe("completed");
  expect(env.amount(rice.id)).toBe(1);
  expect(env.writes.filter((write) => write.productId === rice.id)).toHaveLength(1);
  expect(result.progress?.entries[0].added).toBe(1);
});

it("retains an unverified intent and resumes after rereading, without duplicating the applied requirement", async () => {
  const env = environment(); env.loseRead();
  let durable: CartProgress | undefined;
  const first = await env.run({ checkpoint: (p) => { durable = structuredClone(p); } });
  expect(first.status).toBe("partial_failure");
  expect(first.progress?.entries[0]).toMatchObject({ added: 0, status: "verification_pending" });
  expect(first.progress?.entries[1].added).toBe(0);
  expect(env.amount(rice.id)).toBe(1);
  expect(durable?.intent?.target).toBe(1);
  const resumed = await env.run({ progress: durable, provider: new SimulatedProvider({ script: [json([choose(1, coconut)])] }) });
  expect(resumed.status).toBe("completed");
  expect(env.amount(rice.id)).toBe(1);
  expect(env.amount(coconut.id)).toBe(1);
  expect(env.writes.filter((write) => write.productId === rice.id)).toHaveLength(1);
});

it("a failure that did not apply is retried with the original absolute target", async () => {
  const env = environment();
  env.mock.setFaultPlan([{ code: "TRANSIENT_ERROR", capability: "update_quantity", nth: 1 }]);
  const first = await env.run();
  expect(first.status).toBe("partial_failure");
  expect(env.amount(rice.id)).toBe(0);
  const resumed = await env.run({ progress: first.progress, provider: new SimulatedProvider({ script: [json([choose(1, coconut)])] }) });
  expect(resumed.status).toBe("completed");
  expect(env.amount(rice.id)).toBe(1);
  expect(env.writes.filter((write) => write.productId === rice.id).map((write) => write.quantity)).toEqual([1, 1]);
});

it("replaying the completed checkpoint adds nothing twice and does not regenerate the recipe", async () => {
  const env = environment(); const first = await env.run();
  const count = env.writes.length;
  const provider = new SimulatedProvider({ script: [] });
  const replay = await env.run({ progress: first.progress, provider });
  expect(replay.status).toBe("completed");
  expect(env.writes).toHaveLength(count);
  expect(provider.calls).toBe(0);
});

it("a durable checkpoint failure prevents the network mutation", async () => {
  const env = environment();
  const result = await env.run({ checkpoint: (p) => { if (p.intent) throw new Error("Stockage indisponible"); } });
  expect(result.status).toBe("partial_failure");
  expect(env.writes).toEqual([]);
  expect(env.amount(rice.id)).toBe(0);
});

it("interruption after server success but before durable confirmation is reconciled exactly once", async () => {
  const env = environment(); let durable: CartProgress | undefined; let stopped = false;
  const first = await env.run({ checkpoint: (p) => {
    if (p.entries[0].status === "added" || stopped) { stopped = true; throw new Error("Worker arrêté"); }
    durable = structuredClone(p);
  } });
  expect(first.status).toBe("partial_failure");
  expect(env.amount(rice.id)).toBe(1);
  expect(durable?.intent).toBeDefined();
  const resumed = await env.run({ progress: durable, provider: new SimulatedProvider({ script: [json([choose(1, coconut)])] }) });
  expect(resumed.progress?.entries[0].added).toBe(1);
  expect(env.amount(rice.id)).toBe(1);
});

it("protects preexisting quantities if the cart was changed outside the run", async () => {
  const env = environment(); env.mock.call("update_quantity", { product_id: rice.id, quantity: 5 });
  const result = await env.run();
  env.mock.call("update_quantity", { product_id: rice.id, quantity: 5 });
  await expect(env.remove(result.progress!, 0)).rejects.toThrow("préexistantes");
  expect(env.amount(rice.id)).toBe(5);
});

it("a failed undo is resumed as an undo, never as an extra addition", async () => {
  const env = environment(); const first = await env.run();
  env.loseRead();
  await expect(env.remove(first.progress!, 0)).rejects.toThrow();
  expect(first.progress?.intent?.operation).toBe("remove");
  const result = await env.run({ progress: first.progress, provider: new SimulatedProvider({ script: [] }) });
  expect(env.amount(rice.id)).toBe(0);
  expect(result.progress?.entries[0]).toMatchObject({ added: 1, removed: 1, status: "removed" });
});

it("the gate permits only the exact prepared reference and absolute quantity", async () => {
  const env = environment(); const gate = new ApprovalGate(() => ({ approved: false }));
  const executor = new ToolExecutor({ bindings: env.bindings, gate, trace: createTraceBuilder() });
  gate.permitPreparedQuantity(rice.id, 2);
  expect((await executor.call("update_quantity", { product_id: coconut.id, quantity: 2 }, "model")).ok).toBe(false);
  expect((await executor.call("update_quantity", { product_id: rice.id, quantity: 3 }, "model")).ok).toBe(false);
  expect((await executor.call("update_quantity", { product_id: rice.id, quantity: -1 }, "model")).ok).toBe(false);
  expect(env.writes).toEqual([]);
});
