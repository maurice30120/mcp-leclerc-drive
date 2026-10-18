/**
 * parseRecipe — the versioned common contract: what makes a recipe valid,
 * and the guarantee that an invalid one is rejected whole (no partial
 * recipe, no invented quantity).
 */
import { test, assert } from "./helpers.ts";
import {
  parseRecipe,
  isRecipe,
  normalizeIngredientName,
  normalizeUnit,
  type Recipe,
} from "../src/recipes/contract.ts";

const CATALOGUE_PROV = {
  origin: "catalogue",
  source: "mcp-leclerc-drive",
  licence: "MIT",
};

const PERSONAL_PROV = {
  origin: "personnelle",
  url: "https://jow.fr/recette/lasagnes",
  savedAt: "2026-10-17T10:00:00.000Z",
};

function validRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lasagnes-bolognaise",
    title: "Lasagnes à la bolognaise",
    servings: 4,
    ingredients: [
      { name: "Farine de blé", quantity: 250, unit: "G" },
      { name: "œufs", quantity: 4, unit: "Pièce" },
    ],
    steps: ["Préparer la sauce.", "Monter les lasagnes."],
    provenance: { ...CATALOGUE_PROV },
    ...overrides,
  };
}

test("parseRecipe: accepts a complete catalogue recipe and normalizes names/units", () => {
  const v = parseRecipe(validRecipe());
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const r = v.recipe;
  assert.equal(r.contractVersion, 1);
  assert.equal(r.id, "lasagnes-bolognaise");
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, [
    { name: "farine de blé", quantity: 250, unit: "g" },
    { name: "œufs", quantity: 4, unit: "pièce" },
  ]);
  assert.equal(r.provenance.origin, "catalogue");
});

test("parseRecipe: accepts a personal recipe with source URL + save date", () => {
  const v = parseRecipe(validRecipe({ provenance: { ...PERSONAL_PROV } }));
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.recipe.provenance.origin, "personnelle");
  if (v.recipe.provenance.origin === "personnelle") {
    assert.equal(v.recipe.provenance.url, PERSONAL_PROV.url);
  }
});

test("parseRecipe: optional category and times; absence stays valid", () => {
  const withExtras = parseRecipe(
    validRecipe({ category: "plat", prepMinutes: 20, cookMinutes: 45 }),
  );
  assert.equal(withExtras.ok, true);
  if (withExtras.ok) {
    assert.equal(withExtras.recipe.category, "plat");
    assert.equal(withExtras.recipe.prepMinutes, 20);
    assert.equal(withExtras.recipe.cookMinutes, 45);
  }
  const withoutExtras = parseRecipe(validRecipe());
  assert.equal(withoutExtras.ok, true);
  if (withoutExtras.ok) {
    assert.equal(withoutExtras.recipe.category, undefined);
    assert.equal(withoutExtras.recipe.prepMinutes, undefined);
  }
});

test("parseRecipe: servings are mandatory — no recipe without reference portions", () => {
  const v = parseRecipe(validRecipe({ servings: undefined }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /servings/);
});

test("parseRecipe: rejects zero / fractional / negative servings", () => {
  for (const bad of [0, 1.5, -2, "4"]) {
    const v = parseRecipe(validRecipe({ servings: bad }));
    assert.equal(v.ok, false, `servings=${String(bad)} doit être refusé`);
  }
});

test("parseRecipe: rejects missing ingredients or steps — no partial recipe", () => {
  const noIngredients = parseRecipe(validRecipe({ ingredients: [] }));
  assert.equal(noIngredients.ok, false);
  const noSteps = parseRecipe(validRecipe({ steps: [] }));
  assert.equal(noSteps.ok, false);
  const emptyStep = parseRecipe(validRecipe({ steps: ["Préparer.", "  "] }));
  assert.equal(emptyStep.ok, false);
});

test("parseRecipe: rejects invented/invalid quantities", () => {
  const zero = parseRecipe(
    validRecipe({ ingredients: [{ name: "farine", quantity: 0, unit: "g" }] }),
  );
  assert.equal(zero.ok, false);
  const negative = parseRecipe(
    validRecipe({ ingredients: [{ name: "farine", quantity: -5, unit: "g" }] }),
  );
  assert.equal(negative.ok, false);
  const missingUnit = parseRecipe(
    validRecipe({ ingredients: [{ name: "farine", quantity: 100 }] }),
  );
  assert.equal(missingUnit.ok, false);
  const missingName = parseRecipe(
    validRecipe({ ingredients: [{ quantity: 100, unit: "g" }] }),
  );
  assert.equal(missingName.ok, false);
});

test("parseRecipe: rejects empty ids/titles and non-object payloads", () => {
  assert.equal(parseRecipe(validRecipe({ id: "  " })).ok, false);
  assert.equal(parseRecipe(validRecipe({ title: "" })).ok, false);
  assert.equal(parseRecipe("recette").ok, false);
  assert.equal(parseRecipe([1, 2, 3]).ok, false);
  assert.equal(parseRecipe(null).ok, false);
});

test("parseRecipe: provenance rules — licence for catalogue, url+date for personal", () => {
  const noLicence = parseRecipe(
    validRecipe({ provenance: { origin: "catalogue", source: "x" } }),
  );
  assert.equal(noLicence.ok, false);
  const noUrl = parseRecipe(
    validRecipe({ provenance: { origin: "personnelle", savedAt: "2026-10-17T10:00:00Z" } }),
  );
  assert.equal(noUrl.ok, false);
  const badDate = parseRecipe(
    validRecipe({
      provenance: { origin: "personnelle", url: "https://a.fr/r", savedAt: "pas-une-date" },
    }),
  );
  assert.equal(badDate.ok, false);
  const badOrigin = parseRecipe(validRecipe({ provenance: { origin: "inconnue" } }));
  assert.equal(badOrigin.ok, false);
  const noProvenance = parseRecipe(validRecipe({ provenance: undefined }));
  assert.equal(noProvenance.ok, false);
});

test("parseRecipe: invalid optional fields invalidate the whole recipe", () => {
  const badPrep = parseRecipe(validRecipe({ prepMinutes: -1 }));
  assert.equal(badPrep.ok, false);
  const badCategory = parseRecipe(validRecipe({ category: "   " }));
  assert.equal(badCategory.ok, false);
});

test("isRecipe: guard accepts a validated recipe, rejects raw input", () => {
  const v = parseRecipe(validRecipe());
  if (!v.ok) throw new Error("fixture invalide");
  const recipe: Recipe = v.recipe;
  assert.equal(isRecipe(recipe), true);
  assert.equal(isRecipe(validRecipe()), true);
  assert.equal(isRecipe({ title: "pas une recette complète" }), false);
});

test("normalization: deterministic name/unit normalization, no synonym merging", () => {
  assert.equal(normalizeIngredientName("  Lait   demi-écrémé "), "lait demi-écrémé");
  assert.equal(normalizeUnit("  ML "), "ml");
  // Superficial only: close names stay distinct.
  assert.notEqual(normalizeIngredientName("lait"), normalizeIngredientName("lait entier"));
});
