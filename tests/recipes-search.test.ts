/**
 * Unified recipe search (tickets 12–14, 30): one search across the embedded
 * catalogue and the personal library, with compact results, provenance and
 * pagination. Seam: the pure search function over injected collections.
 *
 * Spec rules under test:
 *   - a result line carries id, title, servings and origin (no ingredients);
 *   - matching is deterministic and superficial (case/accent-insensitive),
 *     over title, category and ingredient names;
 *   - results are paginated with a bounded page size and a hasMore flag;
 *   - unknown ids stay unambiguous across the two collections.
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe, type Recipe } from "../src/recipes/contract.ts";
import { searchRecipes, DEFAULT_SEARCH_PAGE_SIZE, MAX_SEARCH_PAGE_SIZE } from "../src/recipes/search.ts";

function mustParse(raw: unknown): Recipe {
  const v = parseRecipe(raw);
  if (!v.ok) throw new Error(v.error);
  return v.recipe;
}

const crepes = mustParse({
  id: "crepes-classiques",
  title: "Crêpes classiques",
  category: "Dessert",
  servings: 4,
  ingredients: [
    { name: "Farine de blé", quantity: 250, unit: "g" },
    { name: "Lait", quantity: 500, unit: "ml" },
  ],
  steps: ["Mélanger."],
  provenance: { origin: "catalogue", source: "mcp-leclerc-drive", licence: "MIT" },
});

const gratin = mustParse({
  id: "gratin-dauphinois",
  title: "Gratin dauphinois",
  category: "Plat",
  servings: 6,
  ingredients: [{ name: "Pommes de terre", quantity: 1200, unit: "g" }],
  steps: ["Trancher.", "Cuire."],
  provenance: { origin: "catalogue", source: "mcp-leclerc-drive", licence: "MIT" },
});

const curry = mustParse({
  id: "pers-0000abcd",
  title: "Curry de poulet",
  category: "Plat",
  servings: 4,
  ingredients: [{ name: "Poulet", quantity: 400, unit: "g" }],
  steps: ["Mariner.", "Cuire."],
  provenance: {
    origin: "personnelle",
    url: "https://jow.fr/fr/recette/curry-de-poulet",
    savedAt: "2026-10-18T09:00:00.000Z",
  },
});

const catalogue = [crepes, gratin];
const personal = [curry];

test("search: matches titles across both collections with origin", () => {
  const page = searchRecipes("gratin", { catalogue, personal });
  assert.equal(page.total, 1);
  assert.deepEqual(page.results[0], {
    id: "gratin-dauphinois",
    title: "Gratin dauphinois",
    servings: 6,
    origin: "catalogue",
  });
  const curryPage = searchRecipes("curry", { catalogue, personal });
  assert.equal(curryPage.results[0].origin, "personnelle");
});

test("search: accent- and case-insensitive, multi-term is AND", () => {
  const page = searchRecipes("GRATIN DAUPHINOIS", { catalogue, personal });
  assert.equal(page.total, 1);
  const both = searchRecipes("crepe", { catalogue, personal });
  assert.equal(both.total, 1);
  // Multi-word: every term must match somewhere (title/category/ingredient).
  const none = searchRecipes("gratin poulet", { catalogue, personal });
  assert.equal(none.total, 0);
});

test("search: finds by ingredient name", () => {
  const page = searchRecipes("pomme de terre", { catalogue, personal });
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, "gratin-dauphinois");
});

test("search: finds by category", () => {
  const page = searchRecipes("dessert", { catalogue, personal });
  assert.equal(page.total, 1);
  assert.equal(page.results[0].id, "crepes-classiques");
});

test("search: empty query lists everything, deterministically ordered", () => {
  const page = searchRecipes("", { catalogue, personal });
  assert.equal(page.total, 3);
  // Deterministic order: by title (Crêpes < Curry < Gratin), then by id.
  assert.deepEqual(
    page.results.map((r) => r.id),
    ["crepes-classiques", "pers-0000abcd", "gratin-dauphinois"],
  );
});

test("search: pagination — bounded page size, hasMore, page navigation", () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    mustParse({
      id: `recette-${String(i).padStart(2, "0")}`,
      title: `Recette ${String(i).padStart(2, "0")}`,
      servings: 2,
      ingredients: [{ name: "ingrédient", quantity: 1, unit: "pièce" }],
      steps: ["Étape."],
      provenance: { origin: "catalogue", source: "mcp-leclerc-drive", licence: "MIT" },
    }),
  );
  const p1 = searchRecipes("", { catalogue: many, personal: [] });
  assert.equal(p1.results.length, DEFAULT_SEARCH_PAGE_SIZE);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.page, 1);
  const p2 = searchRecipes("", { catalogue: many, personal: [] }, { page: 2 });
  assert.equal(p2.results[0].id, "recette-10");
  const last = searchRecipes("", { catalogue: many, personal: [] }, { page: 3 });
  assert.equal(last.results.length, 5);
  assert.equal(last.hasMore, false);
});

test("search: rejects invalid pagination input with exploitable errors", () => {
  assert.throws(() => searchRecipes("", { catalogue, personal }, { page: 0 }), /page/);
  assert.throws(
    () => searchRecipes("", { catalogue, personal }, { pageSize: 0 }),
    /pageSize/,
  );
  assert.throws(
    () => searchRecipes("", { catalogue, personal }, { pageSize: MAX_SEARCH_PAGE_SIZE + 1 }),
    /pageSize/,
  );
});

test("search: page beyond the end returns an empty page, not an error", () => {
  const page = searchRecipes("", { catalogue, personal }, { page: 9 });
  assert.equal(page.results.length, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.total, 3);
});

test("search: personal and catalogue ids never collide in results", () => {
  const page = searchRecipes("", { catalogue, personal });
  const ids = page.results.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});
