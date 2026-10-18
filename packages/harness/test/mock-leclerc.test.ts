import { describe, expect, it } from "vitest";
import type { Cart, ToolResult } from "@leclerc/contracts";
import { bindCapabilities, createMockLeclerc } from "../src/index.js";

function unwrap<T>(res: ToolResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.output;
}

function err(res: ToolResult<unknown>) {
  if (res.ok) throw new Error(`expected error, got ok: ${JSON.stringify(res.output)}`);
  return res;
}

/** Fresh mock with the Tours drive already selected (session-scoped caps ready). */
function envWithStore() {
  const env = createMockLeclerc();
  const res = env.call("set_store", { storeId: "053701" });
  if (!res.ok) throw new Error("set_store failed in fixture helper");
  return env;
}

describe("capability execution through the registry (issue #42)", () => {
  it("find_stores returns structured stores and EMPTY_RESULT when nothing matches", async () => {
    const env = createMockLeclerc();
    const ok = unwrap(await env.call("find_stores", { query: "Tours" }));
    expect(ok.stores.map((s) => s.id)).toContain("053701");
    const perpignan = unwrap(await env.call("find_stores", { query: "Perpignan" }));
    expect(perpignan.stores.map((s) => s.id)).toEqual(["066900"]);
    const postal = unwrap(await env.call("find_stores", { query: "37200" }));
    expect(postal.stores.map((s) => s.id)).toEqual(["053701"]);
    const ko = err(await env.call("find_stores", { query: "Bora-Bora" }));
    expect(ko.code).toBe("EMPTY_RESULT");
  });

  it("set_store selects the active drive, get_store re-reads it, INVALID_ID otherwise", async () => {
    const env = createMockLeclerc();
    const ko = err(await env.call("set_store", { storeId: "999999" }));
    expect(ko.code).toBe("INVALID_ID");
    const ok = unwrap(await env.call("set_store", { storeId: "053701" }));
    expect(ok.store.id).toBe("053701");
    const read = unwrap(await env.call("get_store", {}));
    expect(read.store.id).toBe("053701");
  });

  it("session-scoped capabilities fail with SESSION_EXPIRED before a store is selected", async () => {
    const env = createMockLeclerc();
    for (const name of [
      "get_store",
      "search_product",
      "list_habitual_products",
      "get_cart",
      "add_to_cart",
    ]) {
      const input =
        name === "search_product" ? { query: "poulet" } :
        name === "add_to_cart" ? { product_id: "P-1001" } : {};
      const ko = err(await env.call(name, input));
      expect(ko.code, name).toBe("SESSION_EXPIRED");
      expect(ko.retryable, name).toBe(true);
    }
  });

  it("search_product is deterministic, accent-insensitive and stable-ranked", async () => {
    const env = envWithStore();
    const poulet = unwrap(await env.call("search_product", { query: "filets de poulet" }));
    expect(poulet.products.map((p) => p.id)).toEqual(["P-1001"]);

    const coco = unwrap(await env.call("search_product", { query: "lait de coco" }));
    expect(coco.products.map((p) => p.id)).toEqual(["P-1003", "P-2001"]);

    // Accent-insensitive: query without accents matches the accented label.
    const creme = unwrap(await env.call("search_product", { query: "creme fraiche" }));
    expect(creme.products.map((p) => p.id)).toEqual(["P-1007"]);

    // Reproducible: same query, same env and a fresh env give identical results.
    const again = unwrap(await env.call("search_product", { query: "lait de coco" }));
    expect(again).toEqual(coco);
    const freshEnv = envWithStore();
    const fresh = unwrap(await freshEnv.call("search_product", { query: "lait de coco" }));
    expect(fresh).toEqual(coco);

    // A07: absent ingredient yields EMPTY_RESULT, never an invented product.
    const ko = err(await env.call("search_product", { query: "sauce worcestershire" }));
    expect(ko.code).toBe("EMPTY_RESULT");

    // Unavailable products are returned with available:false (visible, not hidden).
    const mangue = unwrap(await env.call("search_product", { query: "mangue" }));
    expect(mangue.products.map((p) => [p.id, p.available])).toEqual([["P-1009", false]]);
  });

  it("list_habitual_products returns the three habituels, never the excluded cream", async () => {
    const env = envWithStore();
    const res = unwrap(await env.call("list_habitual_products", {}));
    expect(res.products.map((p) => p.id)).toEqual(["P-1004", "P-1005", "P-1006"]);
    expect(res.products.some((p) => p.id === "P-1007")).toBe(false);
  });

  it("get_cart starts empty", async () => {
    const env = envWithStore();
    const cart = unwrap(await env.call("get_cart", {})).cart;
    expect(cart.items).toEqual([]);
    expect(cart.itemCount).toBe(0);
    expect(cart.total).toBe(0);
    expect(cart.storeId).toBe("053701");
  });
});

describe("cart mutations update quantities and totals, re-readable via get_cart", () => {
  it("add_to_cart accumulates lines and recomputes line totals and cart total", async () => {
    const env = envWithStore();
    const add = unwrap(await env.call("add_to_cart", { product_id: "P-1001", quantity: 2 })).cart;
    expect(add.itemCount).toBe(1);
    expect(add.items[0].quantity).toBe(2);
    expect(add.items[0].lineTotal).toBe(14.4);
    expect(add.total).toBe(14.4);

    const add2 = unwrap(await env.call("add_to_cart", { product_id: "P-1002" })).cart;
    expect(add2.itemCount).toBe(2);
    expect(add2.total).toBe(17.25);

    // Adding the same product again increments instead of duplicating the line.
    const addAgain = unwrap(await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 }))
      .cart;
    expect(addAgain.itemCount).toBe(2);
    expect(addAgain.items.find((i) => i.product.id === "P-1001")?.quantity).toBe(3);

    // Fractional-safe rounding: 3 x 1.95 = 5.85.
    const addCoco = unwrap(await env.call("add_to_cart", { product_id: "P-1003", quantity: 3 }))
      .cart;
    expect(addCoco.items.find((i) => i.product.id === "P-1003")?.lineTotal).toBe(5.85);
    // 3 x 7.20 + 1 x 2.85 + 3 x 1.95 = 30.30.
    expect(addCoco.total).toBe(30.3);
  });

  it("update_quantity sets or removes (0) and remove_from_cart drops the line", async () => {
    const env = envWithStore();
    await env.call("add_to_cart", { product_id: "P-1001", quantity: 2 });
    await env.call("add_to_cart", { product_id: "P-1002" });
    await env.call("add_to_cart", { product_id: "P-1003", quantity: 3 });

    const upd = unwrap(await env.call("update_quantity", { product_id: "P-1001", quantity: 1 }))
      .cart;
    expect(upd.total).toBe(15.9);
    expect(upd.items.find((i) => i.product.id === "P-1001")?.quantity).toBe(1);

    const zero = unwrap(await env.call("update_quantity", { product_id: "P-1002", quantity: 0 }))
      .cart;
    expect(zero.itemCount).toBe(2);
    expect(zero.total).toBe(13.05);

    const removed = unwrap(await env.call("remove_from_cart", { product_id: "P-1003" })).cart;
    expect(removed.itemCount).toBe(1);
    expect(removed.total).toBe(7.2);

    // Mutations are re-readable through the read capability.
    const reread = unwrap(await env.call("get_cart", {})).cart;
    expect(reread).toEqual(removed);
    expect(reread.items[0].product.id).toBe("P-1001");
  });

  it("update_quantity upserts an absolute quantity and retries do not duplicate it", async () => {
    const env = envWithStore();
    await env.call("update_quantity", { product_id: "P-1002", quantity: 2 });
    const again = unwrap(await env.call("update_quantity", { product_id: "P-1002", quantity: 2 })) as { cart: Cart };
    expect(again.cart.items.find((item) => item.product.id === "P-1002")?.quantity).toBe(2);
  });

  it("refuses natural fault cases without touching the cart", async () => {
    const env = envWithStore();
    await env.call("add_to_cart", { product_id: "P-1001", quantity: 1 });
    const before = unwrap(await env.call("get_cart", {})).cart;

    const unknown = err(await env.call("add_to_cart", { product_id: "P-9999" }));
    expect(unknown.code).toBe("PRODUCT_NOT_FOUND");

    const unavailable = err(await env.call("add_to_cart", { product_id: "P-1009" }));
    expect(unavailable.code).toBe("PRODUCT_UNAVAILABLE");

    const removeAbsent = err(await env.call("remove_from_cart", { product_id: "P-1002" }));
    expect(removeAbsent.code).toBe("CART_MUTATION_REFUSED");

    const after = unwrap(await env.call("get_cart", {})).cart;
    expect(after).toEqual(before);
  });
});

describe("registry contract enforcement (never raw exceptions)", () => {
  it("rejects unknown capability names with UNKNOWN_CAPABILITY", async () => {
    const env = createMockLeclerc();
    const ko = err(await env.call("teleport_cart", {}));
    expect(ko.code).toBe("UNKNOWN_CAPABILITY");
  });

  it("rejects invalid inputs with INVALID_INPUT and leaves state unchanged", async () => {
    const env = envWithStore();
    const cases: [string, unknown][] = [
      ["add_to_cart", { product_id: "P-1001", quantity: 0 }],
      ["add_to_cart", { product_id: "P-1001", quantity: 1.5 }],
      ["add_to_cart", {}],
      ["update_quantity", { product_id: "P-1001" }],
      ["search_product", { query: "   " }],
      ["search_product", "poulet"],
      ["set_store", { storeId: "" }],
    ];
    for (const [name, input] of cases) {
      const ko = err(await env.call(name, input));
      expect(ko.code, `${name} ${JSON.stringify(input)}`).toBe("INVALID_INPUT");
    }
    const cart = unwrap(await env.call("get_cart", {})).cart;
    expect(cart.items).toEqual([]);
  });

  it("resolves through bindCapabilities, the executor seam for the agent", async () => {
    const env = envWithStore();
    const exec = bindCapabilities(env);
    const ok = unwrap(await exec("search_product", { query: "poulet" }));
    expect(ok.products.map((p) => p.id)).toEqual(["P-1001"]);
    const ko = err(await exec("not_a_capability", {}));
    expect(ko.code).toBe("UNKNOWN_CAPABILITY");
  });

  it("exposes the raw mock state for scenario assertions without extra tool calls", async () => {
    const env = envWithStore();
    await env.call("add_to_cart", { product_id: "P-1005", quantity: 2 });
    expect(env.state.selectedStore?.id).toBe("053701");
    const cart: Cart = env.state.cart;
    expect(cart.itemCount).toBe(1);
    expect(cart.total).toBe(3.2);
  });
});

describe("fresh state and determinism (issue #42)", () => {
  it("gives every createMockLeclerc call a fresh, isolated environment", async () => {
    const a = envWithStore();
    const b = envWithStore();
    await a.call("add_to_cart", { product_id: "P-1001", quantity: 5 });
    const unavailable = err(await a.call("add_to_cart", { product_id: "P-1009", quantity: 1 }));
    expect(unavailable.code).toBe("PRODUCT_UNAVAILABLE");

    const cartA = unwrap(await a.call("get_cart", {})).cart;
    const cartB = unwrap(await b.call("get_cart", {})).cart;
    expect(cartA.itemCount).toBe(1);
    expect(cartB.items).toEqual([]);

    // Fixture data itself is never mutated by scenarios.
    const c = envWithStore();
    const products = unwrap(await c.call("search_product", { query: "mangue" })).products;
    expect(products[0].available).toBe(false);
    expect(products[0].price).toBe(2.5);
  });

  it("reset() restores fixture state, clears faults and per-call counters", async () => {
    const env = envWithStore();
    await env.call("add_to_cart", { product_id: "P-1001", quantity: 2 });
    env.setFaultPlan([{ code: "PRODUCT_NOT_FOUND", capability: "add_to_cart" }]);
    err(await env.call("add_to_cart", { product_id: "P-1002" }));

    env.reset();

    expect(env.state.selectedStore).toBeUndefined();
    expect(env.state.cart.items).toEqual([]);
    const store = unwrap(await env.call("set_store", { storeId: "066900" }));
    expect(store.store.city).toBe("Perpignan");
    const add = unwrap(await env.call("add_to_cart", { product_id: "P-1002" }));
    expect(add.cart.itemCount).toBe(1);
  });
});
