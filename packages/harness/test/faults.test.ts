import { describe, expect, it } from "vitest";
import { getCapability, type FaultCode } from "@leclerc/contracts";
import { createMockLeclerc } from "../src/index.js";

function err(res: { ok: boolean; code?: unknown; message?: unknown }) {
  if (res.ok) throw new Error(`expected error, got ok: ${JSON.stringify(res)}`);
  return res as { ok: false; code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}

function envWithStore(faults?: Parameters<typeof createMockLeclerc>[0]) {
  const env = createMockLeclerc(faults);
  const res = env.call("set_store", { storeId: "053701" });
  if (!res.ok) throw new Error("set_store failed in fixture helper");
  return env;
}

describe("the seven injectable fault families (issue #42)", () => {
  const familyCases: { code: FaultCode; capability: string; input: unknown }[] = [
    { code: "PRODUCT_NOT_FOUND", capability: "add_to_cart", input: { product_id: "P-1001" } },
    { code: "PRODUCT_UNAVAILABLE", capability: "add_to_cart", input: { product_id: "P-1001" } },
    { code: "CART_MUTATION_REFUSED", capability: "add_to_cart", input: { product_id: "P-1001" } },
    { code: "INVALID_ID", capability: "set_store", input: { storeId: "053701" } },
    { code: "SESSION_EXPIRED", capability: "get_cart", input: {} },
    { code: "EMPTY_RESULT", capability: "search_product", input: { query: "poulet" } },
    { code: "TRANSIENT_ERROR", capability: "search_product", input: { query: "poulet" } },
  ];

  for (const { code, capability, input } of familyCases) {
    it(`injects ${code} on ${capability} as a verifiable normalized error`, async () => {
      // The plan is installed after setup so it cannot break the store selection.
      const env = envWithStore();
      env.setFaultPlan([{ code, capability }]);
      const ko = err(await env.call(capability, input));

      expect(ko.code).toBe(code);
      expect(ko.ok).toBe(false);
      expect(typeof ko.message).toBe("string");
      expect(ko.message.length).toBeGreaterThan(5);
      expect(ko.details?.injected).toBe(true);
      expect(ko.retryable).toBe(code === "TRANSIENT_ERROR" || code === "SESSION_EXPIRED");

      // The injected code must be one the capability contract declares.
      const contract = getCapability(capability);
      expect(contract).toBeDefined();
      expect(contract?.errorCodes).toContain(code);
    });
  }

  it("leaves the cart untouched when a mutation fault fires", async () => {
    const env = envWithStore({
      faults: [{ code: "CART_MUTATION_REFUSED", capability: "add_to_cart" }],
    });
    const addOk = await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 });
    // The plan targets add_to_cart globally, so the first add already fires.
    expect(addOk.ok).toBe(false);
    env.setFaultPlan([]);
    const recover = await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 });
    expect(recover.ok).toBe(true);
    env.setFaultPlan([{ code: "PRODUCT_UNAVAILABLE", capability: "update_quantity" }]);
    const ko = err(await env.call("update_quantity", { product_id: "P-1001", quantity: 2 }));
    expect(ko.code).toBe("PRODUCT_UNAVAILABLE");
    const cart = await env.call("get_cart", {});
    if (!cart.ok) throw new Error("get_cart failed");
    expect(cart.output.cart.itemCount).toBe(1);
    expect(cart.output.cart.items[0].quantity).toBe(1);
  });
});

describe("fault plan predicates", () => {
  it("scopes a fault to one capability without disturbing the others", async () => {
    const env = envWithStore({ faults: [{ code: "TRANSIENT_ERROR", capability: "search_product" }] });
    const ko = err(await env.call("search_product", { query: "poulet" }));
    expect(ko.code).toBe("TRANSIENT_ERROR");
    const ok = await env.call("list_habitual_products", {});
    expect(ok.ok).toBe(true);
    const add = await env.call("add_to_cart", { product_id: "P-1006" });
    expect(add.ok).toBe(true);
  });

  it("scopes a fault to one product id", async () => {
    const env = envWithStore({
      faults: [
        { code: "CART_MUTATION_REFUSED", capability: "add_to_cart", productId: "P-1002" },
      ],
    });
    const ok = await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 });
    expect(ok.ok).toBe(true);
    const ko = err(await env.call("add_to_cart", { product_id: "P-1002", quantity: 1 }));
    expect(ko.code).toBe("CART_MUTATION_REFUSED");
    const stillOk = await env.call("add_to_cart", { product_id: "P-1003", quantity: 1 });
    expect(stillOk.ok).toBe(true);
  });

  it("fires an nth-call fault exactly once at the nth matching call (A08 shape)", async () => {
    const env = envWithStore({
      faults: [
        { code: "TRANSIENT_ERROR", capability: "add_to_cart", nth: 2 },
      ],
    });
    const first = await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 });
    expect(first.ok).toBe(true);
    const second = err(await env.call("add_to_cart", { product_id: "P-1002", quantity: 1 }));
    expect(second.code).toBe("TRANSIENT_ERROR");
    expect(second.retryable).toBe(true);
    const third = await env.call("add_to_cart", { product_id: "P-1003", quantity: 1 });
    expect(third.ok).toBe(true);
    const cart = await env.call("get_cart", {});
    if (!cart.ok) throw new Error("get_cart failed");
    expect(cart.output.cart.itemCount).toBe(2);
  });

  it("combines nth with a product id and honors custom messages and details", async () => {
    const env = envWithStore({
      faults: [
        {
          code: "SESSION_EXPIRED",
          capability: "add_to_cart",
          productId: "P-1002",
          nth: 2,
          message: "Session expirée côté drive (faute injectée).",
          details: { scenario: "A08" },
        },
      ],
    });
    const ok = await env.call("add_to_cart", { product_id: "P-1002", quantity: 1 });
    expect(ok.ok).toBe(true);
    const ko = err(await env.call("add_to_cart", { product_id: "P-1002", quantity: 1 }));
    expect(ko.code).toBe("SESSION_EXPIRED");
    expect(ko.message).toBe("Session expirée côté drive (faute injectée).");
    expect(ko.details?.scenario).toBe("A08");
    expect(ko.details?.injected).toBe(true);
    // Only the first matching call fires; later matching calls succeed.
    const retry = await env.call("add_to_cart", { product_id: "P-1002", quantity: 1 });
    expect(retry.ok).toBe(true);
  });

  it("rejects fault plans with unknown codes or malformed rules at creation", () => {
    expect(() => createMockLeclerc({ faults: [{ code: "NOT_A_CODE" as never, capability: "get_cart" }] })).toThrow();
    expect(() => createMockLeclerc({ faults: [{ code: "TRANSIENT_ERROR", nth: 0 }] })).toThrow();
    expect(() => createMockLeclerc({ faults: [{ code: "TRANSIENT_ERROR", capability: "not_a_capability" }] })).toThrow();
  });
});
