/**
 * parsePlan / validatePlan — parsing + validation of the model's JSON output.
 */
import { test, assert } from "./helpers.ts";
import {
  parsePlan,
  validatePlan,
  extractFirstJsonObject,
  MAX_QUANTITY,
} from "../src/orchestrator/plan.ts";

test("parsePlan: accepts a clean JSON plan wrapped in markdown fences", () => {
  const raw = '```json\n{"items":[{"query":"lait demi-écrémé bio","quantity":2}]}\n```';
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items.length, 1);
    assert.equal(r.plan.items[0].query, "lait demi-écrémé bio");
    assert.equal(r.plan.items[0].quantity, 2);
  }
});

test("parsePlan: tolerates trailing prose after the JSON object", () => {
  const raw = 'Voici le plan : {"items":[{"query":"pâtes","quantity":1}]} merci !';
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.items[0].query, "pâtes");
});

test("parsePlan: accepts a JSON object double-encoded as a JSON string", () => {
  const raw = JSON.stringify(
    '{"items":[{"query":"salade grecque","quantity":1,"constraints":"100 g"}]}',
  );
  const r = parsePlan(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items[0].query, "salade grecque");
    assert.equal(r.plan.items[0].constraints, "100 g");
  }
});

test("parsePlan: rejects an empty output", () => {
  const r = parsePlan("   ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /vide/i);
});

test("parsePlan: rejects output with no JSON object", () => {
  const r = parsePlan("je ne peux pas faire de plan");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /JSON/i);
});

test("parsePlan: rejects invalid JSON", () => {
  const r = parsePlan('{ items: [ broken }');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /JSON/i);
});

test("validatePlan: requires items array", () => {
  const r = validatePlan({ questions: ["x"] });
  assert.equal(r.ok, false);
});

test("validatePlan: empty items + questions is valid (clarification)", () => {
  const r = validatePlan({ items: [], questions: ["Quelle marque ?"] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items.length, 0);
    assert.deepEqual(r.plan.questions, ["Quelle marque ?"]);
  }
});

test("validatePlan: empty items without questions is rejected", () => {
  const r = validatePlan({ items: [] });
  assert.equal(r.ok, false);
});

test("validatePlan: requires a non-empty query per item", () => {
  const r = validatePlan({ items: [{ query: "  ", quantity: 1 }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /query/);
});

test("validatePlan: rejects copied schema placeholder as query", () => {
  const r = validatePlan({
    items: [{ query: "terme de recherche catalogue", quantity: 1 }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /placeholder/i);
});

test("validatePlan: quantity must be a positive integer", () => {
  const r = validatePlan({ items: [{ query: "lait", quantity: 0 }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /quantity/);
});

test("validatePlan: quantity is clamped to MAX_QUANTITY", () => {
  const r = validatePlan({ items: [{ query: "lait", quantity: 9999 }] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.items[0].quantity, MAX_QUANTITY);
});

test("validatePlan: string quantity is coerced", () => {
  const r = validatePlan({ items: [{ query: "lait", quantity: "3" }] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.items[0].quantity, 3);
});

test("validatePlan: DROPS hallucinated product_id / id fields (security)", () => {
  const r = validatePlan({
    items: [
      {
        query: "lait",
        quantity: 1,
        product_id: "999999",
        id: "888888",
      },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    const item = r.plan.items[0] as Record<string, unknown>;
    assert.equal("product_id" in item, false);
    assert.equal("id" in item, false);
  }
});

test("validatePlan: preserves optional constraints and notes", () => {
  const r = validatePlan({
    items: [{ query: "lait", quantity: 1, constraints: "1L bio", notes: "demi-écrémé" }],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items[0].constraints, "1L bio");
    assert.equal(r.plan.items[0].notes, "demi-écrémé");
  }
});

test("validatePlan: drops optional placeholder strings", () => {
  const r = validatePlan({
    items: [{ query: "lardons fumés", quantity: 1, constraints: "optionnel", notes: "optionnel" }],
    questions: ["optionnel"],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.items[0].constraints, undefined);
    assert.equal(r.plan.items[0].notes, undefined);
    assert.equal(r.plan.questions, undefined);
  }
});

test("extractFirstJsonObject: handles braces inside strings", () => {
  const raw = 'prefix {"a":"} weird","b":1} suffix';
  const got = extractFirstJsonObject(raw);
  assert.equal(got, '{"a":"} weird","b":1}');
});

test("extractFirstJsonObject: returns null when no object", () => {
  assert.equal(extractFirstJsonObject("no braces here"), null);
});
