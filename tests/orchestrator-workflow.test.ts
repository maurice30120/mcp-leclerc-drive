/**
 * Recipe orchestration workflow — mocked model output to Leclerc tool calls.
 */
import { test, assert } from "./helpers.ts";
import { parsePlan } from "../src/orchestrator/plan.ts";
import {
  addToCartCallsForSelections,
  searchCallsForPlan,
} from "../src/orchestrator/workflow.ts";
import { validateCommand } from "../src/orchestrator/dispatcher.ts";

const LECLERC_HOST = "fd9-courses.leclercdrive.fr";

test("recipe generation: parses a mocked recipe into searchable ingredients", () => {
  const rawModelOutput = JSON.stringify({
    items: [
      { query: "farine de blé", quantity: 1, constraints: "1 kg" },
      { query: "oeufs plein air", quantity: 1, constraints: "boîte de 6" },
      { query: "lait demi-écrémé", quantity: 2, constraints: "1 L" },
      { query: "beurre doux", quantity: 1, notes: "pour cuisson" },
    ],
  });

  const parsed = parsePlan(rawModelOutput);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.deepEqual(parsed.plan.items.map((item) => item.query), [
    "farine de blé",
    "oeufs plein air",
    "lait demi-écrémé",
    "beurre doux",
  ]);
  assert.equal(parsed.plan.items[2].quantity, 2);
  assert.equal(parsed.plan.items[0].constraints, "1 kg");
});

test("tool calls: recipe plan produces one read-only search_products call per ingredient", () => {
  const parsed = parsePlan(JSON.stringify({
    items: [
      { query: "pâtes lasagnes", quantity: 1 },
      { query: "sauce tomate basilic", quantity: 2 },
      { query: "emmental râpé", quantity: 1 },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const calls = searchCallsForPlan(parsed.plan);
  assert.deepEqual(calls, [
    { type: "leclerc_run", command: "search_products", args: { query: "pâtes lasagnes" } },
    { type: "leclerc_run", command: "search_products", args: { query: "sauce tomate basilic" } },
    { type: "leclerc_run", command: "search_products", args: { query: "emmental râpé" } },
  ]);
  for (const call of calls) {
    const validated = validateCommand(call.command, call.args, "evil.example.com");
    assert.equal(validated.ok, true);
    if (validated.ok) assert.equal(validated.call.command, "search_products");
  }
});

test("tool calls: selected catalogue products produce add_to_cart mutations", () => {
  const parsed = parsePlan(JSON.stringify({
    items: [
      { query: "farine de blé", quantity: 1 },
      { query: "lait demi-écrémé", quantity: 2 },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const built = addToCartCallsForSelections(parsed.plan, [
    { itemIndex: 0, productId: "3601029854412" },
    { itemIndex: 1, productId: "3564700012345", quantity: 3 },
  ]);

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.calls, [
    {
      type: "leclerc_run",
      command: "add_to_cart",
      args: { product_id: "3601029854412", quantity: 1 },
    },
    {
      type: "leclerc_run",
      command: "add_to_cart",
      args: { product_id: "3564700012345", quantity: 3 },
    },
  ]);

  for (const call of built.calls) {
    const validated = validateCommand(call.command, call.args, LECLERC_HOST);
    assert.equal(validated.ok, true);
    if (validated.ok) assert.equal(validated.call.command, "add_to_cart");
  }
});

test("tool calls: add_to_cart is refused until every recipe item has a selection", () => {
  const parsed = parsePlan(JSON.stringify({
    items: [
      { query: "farine", quantity: 1 },
      { query: "sucre", quantity: 1 },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const built = addToCartCallsForSelections(parsed.plan, [
    { itemIndex: 0, productId: "p-farine" },
  ]);

  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.error, /Tous les items/i);
});

test("tool calls: model hallucinated product_id is ignored; selected product id is used", () => {
  const parsed = parsePlan(JSON.stringify({
    items: [
      {
        query: "mozzarella",
        quantity: 2,
        product_id: "hallucinated-id",
        id: "also-wrong",
      },
    ],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const item = parsed.plan.items[0] as Record<string, unknown>;
  assert.equal(item.product_id, undefined);
  assert.equal(item.id, undefined);

  const built = addToCartCallsForSelections(parsed.plan, [
    { itemIndex: 0, productId: "real-catalogue-id" },
  ]);
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.deepEqual(built.calls[0].args, {
      product_id: "real-catalogue-id",
      quantity: 2,
    });
  }
});
