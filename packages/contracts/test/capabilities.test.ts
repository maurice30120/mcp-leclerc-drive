import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  FAULT_CODES,
  getCapability,
  isMutation,
  listCapabilities,
} from "../src/index.js";

describe("capability registry", () => {
  it("defines the nine historical capabilities exactly once each", () => {
    expect(CAPABILITY_NAMES).toHaveLength(9);
    const names = CAPABILITY_NAMES.slice().sort();
    expect(new Set(names).size).toBe(9);
    expect(names).toEqual(
      [
        "add_to_cart",
        "find_stores",
        "get_cart",
        "get_store",
        "list_habitual_products",
        "remove_from_cart",
        "search_product",
        "set_store",
        "update_quantity",
      ].sort(),
    );
  });

  it("returns each contract by name and never an ad-hoc definition", () => {
    for (const c of listCapabilities()) {
      expect(getCapability(c.name)).toBe(c);
    }
    expect(getCapability("not_a_capability")).toBeUndefined();
  });

  it("marks exactly the three cart mutations as mutations", () => {
    expect(CAPABILITIES.filter((c) => isMutation(c.name)).map((c) => c.name).sort()).toEqual([
      "add_to_cart",
      "remove_from_cart",
      "update_quantity",
    ]);
    expect(isMutation("get_cart")).toBe(false);
    expect(isMutation("set_store")).toBe(false);
  });

  it("gives every contract a description, schemas and error codes", () => {
    for (const c of CAPABILITIES) {
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.inputSchema.type).toBe("object");
      expect(c.outputSchema.type).toBe("object");
      expect(c.errorCodes.length).toBeGreaterThan(0);
    }
  });

  it("lets mutation contracts produce all seven injectable fault families except empty search", () => {
    for (const name of ["add_to_cart", "update_quantity", "remove_from_cart"]) {
      const c = getCapability(name);
      expect(c).toBeDefined();
      if (!c) continue;
      const codes = c.errorCodes as readonly string[];
      for (const fault of ["PRODUCT_NOT_FOUND", "PRODUCT_UNAVAILABLE", "CART_MUTATION_REFUSED", "INVALID_ID", "SESSION_EXPIRED", "TRANSIENT_ERROR"]) {
        expect(codes).toContain(fault);
      }
      expect(FAULT_CODES).toContain("EMPTY_RESULT");
    }
  });
});

describe("capability input validation", () => {
  it("validates search_product input", () => {
    const ok = getCapability("search_product")?.validateInput({ query: "poulet" });
    expect(ok?.ok).toBe(true);
    const ko = getCapability("search_product")?.validateInput({ query: "  " });
    expect(ko?.ok).toBe(false);
    if (ko && !ko.ok) {
      expect(ko.code).toBe("INVALID_INPUT");
    }
  });

  it("validates add_to_cart input and defaults quantity to 1", () => {
    const cap = getCapability("add_to_cart");
    const ok = cap?.validateInput({ product_id: "P-1" });
    expect(ok?.ok).toBe(true);
    if (ok?.ok) {
      expect(ok.value).toEqual({ productId: "P-1", quantity: 1 });
    }
    const ko = cap?.validateInput({ product_id: "P-1", quantity: 0 });
    expect(ko?.ok).toBe(false);
    const missing = cap?.validateInput({});
    expect(missing?.ok).toBe(false);
  });

  it("validates update_quantity input with a required target quantity", () => {
    const cap = getCapability("update_quantity");
    const ok = cap?.validateInput({ product_id: "P-1", quantity: 0 });
    expect(ok?.ok).toBe(true);
    const ko = cap?.validateInput({ product_id: "P-1" });
    expect(ko?.ok).toBe(false);
  });

  it("accepts empty objects for the no-input read capabilities", () => {
    for (const name of ["get_cart", "get_store", "list_habitual_products"]) {
      const res = getCapability(name)?.validateInput({});
      expect(res?.ok).toBe(true);
    }
  });

  it("rejects non-object inputs with INVALID_INPUT", () => {
    const res = getCapability("get_cart")?.validateInput("nope");
    expect(res?.ok).toBe(false);
    if (res && !res.ok) {
      expect(res.code).toBe("INVALID_INPUT");
    }
  });

  it("validates set_store and find_stores inputs", () => {
    const set = getCapability("set_store")?.validateInput({ storeId: "053701" });
    expect(set?.ok).toBe(true);
    const find = getCapability("find_stores")?.validateInput({ query: "Tours" });
    expect(find?.ok).toBe(true);
    const ko = getCapability("set_store")?.validateInput({ storeId: "" });
    expect(ko?.ok).toBe(false);
  });
});
