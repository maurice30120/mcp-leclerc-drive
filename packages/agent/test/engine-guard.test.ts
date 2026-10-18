import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../src/approval.js";
import type { ApprovalDecision } from "../src/approval.js";
import { bindingFromContract, ToolExecutor } from "../src/engine.js";
import { createTraceBuilder } from "../src/trace.js";
import { addToCart, getCart, searchProduct } from "@leclerc/contracts";
import type { Cart, Product } from "@leclerc/contracts";

const preview = {
  recipeTitle: "Poulet au curry",
  servings: 4,
  lines: [
    {
      productId: "P-1001",
      label: "Filets de poulet 600 g",
      ingredient: "filets de poulet",
      quantity: 2,
      unitPrice: 7.2,
      lineTotal: 14.4,
      packaging: "600 g",
      matchScore: 2,
    },
  ],
  total: 14.4,
};

describe("ApprovalGate", () => {
  it("starts unapproved and delegates the decision to the injected handler", async () => {
    const gate = new ApprovalGate(() => ({ approved: true }));
    expect(gate.isApproved()).toBe(false);
    const decision = await gate.requestApproval({
      kind: "global_cart_mutation",
      summary: "1 article",
      preview,
    });
    expect(decision.approved).toBe(true);
    expect(gate.isApproved()).toBe(true);
  });

  it("keeps the gate closed on refusal", async () => {
    const gate = new ApprovalGate(() => ({ approved: false, reason: "trop cher" }));
    const decision: ApprovalDecision = await gate.requestApproval({
      kind: "global_cart_mutation",
      summary: "1 article",
      preview,
    });
    expect(decision).toEqual({ approved: false, reason: "trop cher" });
    expect(gate.isApproved()).toBe(false);
  });

  it("supports asynchronous handlers (scenario events)", async () => {
    const gate = new ApprovalGate(async () => {
      await Promise.resolve();
      return { approved: true };
    });
    expect(await gate.requestApproval({ kind: "global_cart_mutation", summary: "s", preview })).toEqual({
      approved: true,
    });
  });
});

// ---- executor guard: the approval gate is the only door to mutations ----

const chicken: Product = {
  id: "P-1001",
  label: "Filets de poulet 600 g",
  price: 7.2,
  available: true,
  packaging: "600 g",
};

const emptyCart: Cart = { items: [], itemCount: 0, total: 0, storeId: "053701" };

function makeExecutor(handler: () => { approved: boolean }) {
  const trace = createTraceBuilder();
  const gate = new ApprovalGate(handler);
  const executed: Array<{ name: string; input: unknown }> = [];
  const executor = new ToolExecutor(
    {
      bindings: [
        bindingFromContract(searchProduct, async (input) => {
          executed.push({ name: "search_product", input });
          return { ok: true, output: { products: [chicken] } };
        }),
        bindingFromContract(addToCart, async (input) => {
          executed.push({ name: "add_to_cart", input });
          return { ok: true, output: { cart: { ...emptyCart, items: [{ product: chicken, quantity: 1, lineTotal: 7.2 }] } } };
        }),
        bindingFromContract(getCart, async () => {
          executed.push({ name: "get_cart", input: {} });
          return { ok: true, output: { cart: emptyCart } };
        }),
      ],
      gate,
      trace,
    },
  );
  return { executor, gate, trace, executed };
}

describe("ToolExecutor approval guard", () => {
  it("blocks a mutation without approval: NOT executed, APPROVAL_REQUIRED, safety_block traced", async () => {
    const { executor, trace, executed } = makeExecutor(() => ({ approved: false }));
    const result = await executor.call("add_to_cart", { product_id: "P-1001", quantity: 1 }, "deterministic");
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_REQUIRED",
      retryable: false,
    });
    expect(executed).toEqual([]); // the binding was never reached
    const events = trace.events;
    expect(events.some((e) => e.type === "safety_block" && e.name === "add_to_cart")).toBe(true);
    const blocked = events.find((e) => e.type === "tool_result" && !e.ok);
    expect(blocked).toBeDefined();
  });

  it("executes the mutation only once the gate is approved", async () => {
    const { executor, gate, executed } = makeExecutor(() => ({ approved: true }));
    await gate.requestApproval({ kind: "global_cart_mutation", summary: "s", preview });
    const result = await executor.call("add_to_cart", { product_id: "P-1001", quantity: 1 }, "deterministic");
    expect(result.ok).toBe(true);
    expect(executed).toEqual([{ name: "add_to_cart", input: { productId: "P-1001", quantity: 1 } }]);
  });

  it("runs read tools without any approval", async () => {
    const { executor, executed } = makeExecutor(() => ({ approved: false }));
    const result = await executor.call("search_product", { query: "poulet" }, "deterministic");
    expect(result.ok).toBe(true);
    expect(executed).toEqual([{ name: "search_product", input: { query: "poulet" } }]);
  });

  it("returns UNKNOWN_CAPABILITY without executing for an unbound name", async () => {
    const { executor, executed } = makeExecutor(() => ({ approved: true }));
    const result = await executor.call("nope", {}, "model");
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_CAPABILITY" });
    expect(executed).toEqual([]);
  });

  it("normalizes invalid input through the registry contract (INVALID_INPUT)", async () => {
    const { executor, executed } = makeExecutor(() => ({ approved: true }));
    const result = await executor.call("add_to_cart", { quantity: 1 }, "model");
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(executed).toEqual([]);
  });

  it("wraps a thrown exception into a normalized CAPABILITY_FAILED error", async () => {
    const trace = createTraceBuilder();
    const gate = new ApprovalGate(() => ({ approved: true }));
    const executor = new ToolExecutor({
      bindings: [
        bindingFromContract(getCart, async () => {
          throw new Error("boom");
        }),
      ],
      gate,
      trace,
    });
    const result = await executor.call("get_cart", {}, "deterministic");
    expect(result).toMatchObject({ ok: false, code: "CAPABILITY_FAILED", retryable: false });
  });
});
