/**
 * validateCommand — read vs mutation classification, arg coercion, host guard.
 */
import { test, assert } from "./helpers.ts";
import {
  validateCommand,
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
