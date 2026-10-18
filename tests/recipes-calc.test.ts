/**
 * Ingredient calculation (tickets 15–18): deterministic portions scaling,
 * temporary adaptations and strict grouping. Seam: the pure calculator,
 * resolver-injected — the tools layer resolves catalogue recipes locally and
 * personal recipes through the storage runtime.
 *
 * Spec rules under test:
 *   - quantities are multiplied by target/reference servings;
 *   - only identical normalized name + identical unit are summed; different
 *     units stay distinct even when a conversion would be possible;
 *   - adaptation quantities are expressed for the REFERENCE servings before
 *     the portions factor applies; they never modify the stored recipe;
 *   - each grouped line carries its per-recipe contributions and the total.
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe, type Recipe } from "../src/recipes/contract.ts";
import {
  calculateIngredients,
  formatQuantity,
  type CalcEntry,
} from "../src/recipes/calc.ts";

function mustParse(raw: unknown): Recipe {
  const v = parseRecipe(raw);
  if (!v.ok) throw new Error(v.error);
  return v.recipe;
}

const RECIPES: Record<string, Recipe> = {
  a: mustParse({
    id: "a",
    title: "Recette A",
    servings: 4,
    ingredients: [
      { name: "Farine de blé", quantity: 200, unit: "g" },
      { name: "Lait", quantity: 400, unit: "ml" },
      { name: "Œufs", quantity: 2, unit: "pièce" },
    ],
    steps: ["Étape A."],
    provenance: { origin: "catalogue", source: "mcp-leclerc-drive", licence: "MIT" },
  }),
  b: mustParse({
    id: "b",
    title: "Recette B",
    servings: 2,
    ingredients: [
      { name: "Farine de blé", quantity: 300, unit: "g" },
      { name: "Lait", quantity: 100, unit: "cl" }, // different unit: never merged
      { name: "Sel", quantity: 1, unit: "pincée" },
    ],
    steps: ["Étape B."],
    provenance: { origin: "catalogue", source: "mcp-leclerc-drive", licence: "MIT" },
  }),
};

const resolve = (id: string): Recipe | undefined => RECIPES[id];

test("calculate: scales quantities by target/reference servings", () => {
  const r = calculateIngredients([{ recipe_id: "a", target_servings: 8 }], resolve);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.result.entries.length, 1);
  const lines = r.result.entries[0].lines;
  assert.deepEqual(
    lines.find((l) => l.name === "farine de blé"),
    { name: "farine de blé", quantity: 400, unit: "g" },
  );
  assert.deepEqual(lines.find((l) => l.name === "lait"), { name: "lait", quantity: 800, unit: "ml" });
});

test("calculate: keeps exact fractions when scaling down (no premature rounding)", () => {
  const r = calculateIngredients([{ recipe_id: "a", target_servings: 3 }], resolve);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const flour = r.result.entries[0].lines.find((l) => l.name === "farine de blé");
  assert.equal(flour.quantity, 150); // 200 * 3/4
  const r2 = calculateIngredients([{ recipe_id: "b", target_servings: 3 }], resolve);
  if (!r2.ok) return;
  const flourB = r2.result.entries[0].lines.find((l) => l.name === "farine de blé");
  assert.equal(flourB.quantity, 450); // 300 * 3/2
});

test("calculate: groups only identical name + unit across recipes", () => {
  const r = calculateIngredients(
    [
      { recipe_id: "a", target_servings: 4 },
      { recipe_id: "b", target_servings: 2 },
    ],
    resolve,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const grouped = r.result.grouped;
  const flour = grouped.find((l) => l.name === "farine de blé" && l.unit === "g");
  assert.ok(flour, "farine groupée (même unité)");
  assert.equal(flour.total, 500); // 200 + 300
  assert.equal(flour.contributions.length, 2);
  assert.deepEqual(
    flour.contributions,
    [
      { recipe: "Recette A", quantity: 200 },
      { recipe: "Recette B", quantity: 300 },
    ],
  );
  // lait a / lait b: same name, different units → never merged.
  const laitMl = grouped.find((l) => l.name === "lait" && l.unit === "ml");
  const laitCl = grouped.find((l) => l.name === "lait" && l.unit === "cl");
  assert.ok(laitMl && laitCl, "unités différentes conservées séparées");
  assert.equal(laitMl.total, 400);
  assert.equal(laitCl.total, 100);
  assert.equal(laitMl.contributions.length, 1);
});

test("calculate: temporary substitution replaces an ingredient for this call only", () => {
  const entry: CalcEntry = {
    recipe_id: "a",
    target_servings: 8,
    substitutions: [
      {
        name: "lait",
        replacement: { name: "Lait d'avoine", quantity: 400, unit: "ml" }, // reference servings
      },
    ],
  };
  const r = calculateIngredients([entry], resolve);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const lines = r.result.entries[0].lines;
  assert.ok(!lines.some((l) => l.name === "lait"), "lait remplacé");
  const avoine = lines.find((l) => l.name === "lait d'avoine");
  assert.ok(avoine, "substitution présente");
  assert.equal(avoine.quantity, 800); // 400 (référence) × facteur 2
  assert.equal(avoine.unit, "ml");
  // The stored recipe is untouched: a plain call still has lait.
  const plain = calculateIngredients([{ recipe_id: "a", target_servings: 4 }], resolve);
  if (!plain.ok) return;
  assert.ok(plain.result.entries[0].lines.some((l) => l.name === "lait"));
});

test("calculate: a substitution without an explicit replacement is refused", () => {
  const entry: CalcEntry = {
    recipe_id: "a",
    target_servings: 4,
    // Removing an ingredient is not a light adaptation: the spec only allows
    // replacing with a close equivalent.
    substitutions: [{ name: "œufs" } as never],
  };
  const r = calculateIngredients([entry], resolve);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /remplacement explicite/);
});

test("calculate: unknown recipe id is an exploitable error", () => {
  const r = calculateIngredients(
    [
      { recipe_id: "a", target_servings: 4 },
      { recipe_id: "zzz", target_servings: 4 },
    ],
    resolve,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /zzz/);
});

test("calculate: invalid target servings are rejected", () => {
  for (const bad of [0, -1, 1.5, "4", null]) {
    const r = calculateIngredients(
      [{ recipe_id: "a", target_servings: bad as never }],
      resolve,
    );
    assert.equal(r.ok, false, `target_servings=${String(bad)} doit être refusé`);
  }
});

test("calculate: empty entries list is an explicit error", () => {
  const r = calculateIngredients([], resolve);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /au moins une recette/i);
});

test("calculate: same recipe used twice with different portions doubles the need", () => {
  const r = calculateIngredients(
    [
      { recipe_id: "a", target_servings: 4 },
      { recipe_id: "a", target_servings: 4 },
    ],
    resolve,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const flour = r.result.grouped.find((l) => l.name === "farine de blé");
  assert.equal(flour.total, 400);
  assert.equal(flour.contributions.length, 2);
});

test("formatQuantity: stable decimal rendering, no premature rounding inside sums", () => {
  assert.equal(formatQuantity(500), "500");
  assert.equal(formatQuantity(133.33333333), "133.3333");
  assert.equal(formatQuantity(0.5), "0.5");
  assert.equal(formatQuantity(800.0), "800");
});
