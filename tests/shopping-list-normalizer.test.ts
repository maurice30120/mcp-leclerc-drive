import { test, assert } from "./helpers.ts";

import { normalizeShoppingList } from "../src/orchestrator/shopping-list.ts";

test("shopping normalizer: direct ingredient with leading weight", () => {
  const r = normalizeShoppingList("achète 500 g de lardons fumés");
  assert.equal(r?.ok, true);
  assert.equal(r?.plan.items[0].query, "lardons fumés");
  assert.equal(r?.plan.items[0].quantity, 1);
  assert.equal(r?.plan.items[0].constraints, "500 g");
});

test("shopping normalizer: comma-separated list with unit count and measures", () => {
  const r = normalizeShoppingList("lait demi-écrémé 1L, oeufs x6, farine 1kg");
  assert.equal(r?.ok, true);
  assert.deepEqual(r?.plan.items.map((item) => item.query), [
    "lait demi-écrémé",
    "oeufs",
    "farine",
  ]);
  assert.equal(r?.plan.items[0].constraints, "1 l");
  assert.equal(r?.plan.items[1].quantity, 6);
  assert.equal(r?.plan.items[2].constraints, "1 kg");
});

test("shopping normalizer: multiline list", () => {
  const r = normalizeShoppingList("- riz basmati 1 kg\n- poulet x2\n- tomates cerises 250 g");
  assert.equal(r?.ok, true);
  assert.deepEqual(r?.plan.items.map((item) => item.query), [
    "riz basmati",
    "poulet",
    "tomates cerises",
  ]);
  assert.equal(r?.plan.items[1].quantity, 2);
});

test("shopping normalizer: explicit package count", () => {
  const r = normalizeShoppingList("2 paquets de pâtes spaghetti");
  assert.equal(r?.ok, true);
  assert.equal(r?.plan.items[0].query, "pâtes spaghetti");
  assert.equal(r?.plan.items[0].quantity, 2);
  assert.equal(r?.plan.items[0].constraints, "paquets");
});

test("shopping normalizer: recipe-only request asks for ingredients", () => {
  const r = normalizeShoppingList("carbonara pour 4");
  assert.equal(r?.ok, true);
  assert.equal(r?.plan.items.length, 0);
  assert.deepEqual(r?.plan.questions, [
    "Donne-moi les ingrédients à acheter pour cette recette.",
  ]);
});
