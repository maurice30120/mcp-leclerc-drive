/**
 * validateCommand — read vs mutation classification, arg coercion, host guard.
 */
import { test, assert } from "./helpers.ts";
import {
  validateCommand,
  validateAddMany,
  executeAddMany,
  MAX_ADD_MANY_ITEMS,
  isMutationCall,
  isReadCall,
  type DispatchCall,
} from "../src/orchestrator/dispatcher.ts";
import { isLeclercHost } from "../src/leclerc/api.ts";

const LECRERC_HOST = "fd9-courses.leclercdrive.fr";
const EVIL_HOST = "evil.example.com";

test("validateCommand: rejects unknown commands", () => {
  const r = validateCommand("nuke_cart", {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /inconnue/i);
});

test("validateCommand: search_products trims + requires non-empty query", () => {
  assert.equal(validateCommand("search_products", { query: "   " }).ok, false);
  const r = validateCommand("search_products", { query: "  lait  " });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.call.query, "lait");
});

test("validateCommand: get_cart / get_store are valid reads", () => {
  assert.equal(validateCommand("get_cart", {}).ok, true);
  assert.equal(validateCommand("get_store", {}).ok, true);
});

test("validateCommand: add_to_cart requires product_id + quantity>=1", () => {
  assert.equal(validateCommand("add_to_cart", { quantity: 1 }).ok, false);
  assert.equal(validateCommand("add_to_cart", { product_id: "p1", quantity: 0 }).ok, false);
  const r = validateCommand("add_to_cart", { product_id: "p1", quantity: 2 }, LECRERC_HOST);
  assert.equal(r.ok, true);
  if (r.ok) {
    const c = r.call as Extract<DispatchCall, { command: "add_to_cart" }>;
    assert.equal(c.productId, "p1");
    assert.equal(c.quantity, 2);
  }
});

test("validateCommand: update_quantity accepts quantity 0 (remove)", () => {
  const r = validateCommand("update_quantity", { product_id: "p1", quantity: 0 }, LECRERC_HOST);
  assert.equal(r.ok, true);
});

test("validateCommand: remove_from_cart ignores quantity", () => {
  const r = validateCommand("remove_from_cart", { product_id: "p1" }, LECRERC_HOST);
  assert.equal(r.ok, true);
});

test("validateCommand: MUTATION refuses a non-Leclerc host", () => {
  assert.ok(isLeclercHost(LECRERC_HOST));
  assert.equal(isLeclercHost(EVIL_HOST), false);
  const r = validateCommand("add_to_cart", { product_id: "p1", quantity: 1 }, EVIL_HOST);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /Host refusé/i);
});

test("validateCommand: read commands do NOT require a host check", () => {
  const r = validateCommand("search_products", { query: "lait" }, EVIL_HOST);
  assert.equal(r.ok, true);
});

test("isMutationCall / isReadCall classify validated calls", () => {
  const read = validateCommand("get_cart", {});
  const mut = validateCommand("add_to_cart", { product_id: "p1", quantity: 1 }, LECRERC_HOST);
  assert.ok(read.ok && mut.ok);
  if (read.ok && mut.ok) {
    assert.equal(isMutationCall(mut.call), true);
    assert.equal(isReadCall(mut.call), false);
    assert.equal(isMutationCall(read.call), false);
    assert.equal(isReadCall(read.call), true);
  }
});

test("validateCommand: string product_id is accepted, numbers rejected", () => {
  assert.equal(
    validateCommand("add_to_cart", { product_id: 123, quantity: 1 }, LECRERC_HOST).ok,
    false,
  );
  assert.equal(
    validateCommand("add_to_cart", { product_id: "123", quantity: 1 }, LECRERC_HOST).ok,
    true,
  );
});

test("validateAddMany: normalizes quantities and validates the complete batch", () => {
  const r = validateAddMany(
    [{ product_id: "p1", quantity: 3 }, { product_id: "p2" }],
    LECRERC_HOST,
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.items, [
      { command: "add_to_cart", productId: "p1", quantity: 3 },
      { command: "add_to_cart", productId: "p2", quantity: 1 },
    ]);
  }
});

test("validateAddMany: rejects empty, oversized and malformed batches", () => {
  assert.equal(validateAddMany([], LECRERC_HOST).ok, false);
  assert.equal(validateAddMany(null, LECRERC_HOST).ok, false);
  assert.equal(
    validateAddMany(Array.from({ length: MAX_ADD_MANY_ITEMS + 1 }, (_, i) => ({ product_id: String(i) })), LECRERC_HOST).ok,
    false,
  );
  assert.equal(validateAddMany([{ product_id: "p1" }, null], LECRERC_HOST).ok, false);
  assert.equal(validateAddMany([{ product_id: "p1" }, { product_id: "p2", quantity: 0 }], LECRERC_HOST).ok, false);
  assert.equal(validateAddMany([{ product_id: 123 }], LECRERC_HOST).ok, false);
  assert.equal(validateAddMany([{ product_id: "p1", quantity: 1.5 }], LECRERC_HOST).ok, false);
});

test("validateAddMany: rejects duplicates and non-Leclerc hosts", () => {
  const duplicate = validateAddMany([{ product_id: "p1" }, { product_id: "p1" }], LECRERC_HOST);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.error, /répété/i);

  const invalidHost = validateAddMany([{ product_id: "p1" }], EVIL_HOST);
  assert.equal(invalidHost.ok, false);
  if (!invalidHost.ok) assert.match(invalidHost.error, /Host refusé/i);
});

test("executeAddMany: processes sequentially and continues after per-item failure", async () => {
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const result = await executeAddMany(
    [
      { command: "add_to_cart", productId: "a", quantity: 2 },
      { command: "add_to_cart", productId: "b", quantity: 1 },
      { command: "add_to_cart", productId: "c", quantity: 4 },
    ],
    async (item) => {
      calls.push(item.productId);
      running++;
      peak = Math.max(peak, running);
      try {
        await Promise.resolve();
        if (item.productId === "b") throw new Error("HTTP 403");
        return `panier-${item.productId}`;
      } finally {
        running--;
      }
    },
  );
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(peak, 1);
  assert.deepEqual(result.added.map((item) => item.productId), ["a", "c"]);
  assert.deepEqual(result.failed, [{ productId: "b", quantity: 1, error: "HTTP 403" }]);
  assert.equal(result.lastResult, "panier-c");
});
