/**
 * MCP-contract level tests for the full recipe tool set: catalogue +
 * personal library consultation, unified search, ingredient calculation,
 * capture listing/reading/saving/abandoning, and the bounded notices block.
 * The storage runtime is a double; the descriptors are exercised exactly the
 * way a client would.
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe, type Recipe } from "../src/recipes/contract.ts";
import { loadCatalogue } from "../src/recipes/catalogue.ts";
import {
  createRecipeTools,
  buildNotices,
  formatRecipe,
  withNotices,
  type RecipeToolDescriptor,
  type ToolTextResult,
} from "../src/recipes/tools.ts";
import { calculateIngredients } from "../src/recipes/calc.ts";
import { searchRecipes } from "../src/recipes/search.ts";
import type { CaptureSummary, RecipeRuntime } from "../src/recipes/service.ts";
import type { Capture } from "../src/recipes/capture.ts";
import type { SaveRecipeResult } from "../src/recipes/library.ts";
import type { CalcEntry } from "../src/recipes/calc.ts";

const catalogue = loadCatalogue(parseRecipe);

// ---- in-memory runtime double ----------------------------------------------

class MemoryRuntime implements RecipeRuntime {
  captures: Capture[] = [];
  recipes: Recipe[] = [];
  announced: string[] = [];
  saveCalls: Array<{ raw: unknown; captureId?: string }> = [];

  async listCaptures(): Promise<CaptureSummary[]> {
    return this.captures.map((c) => ({
      id: c.id,
      url: c.url,
      capturedAt: c.capturedAt,
      ...(c.title ? { title: c.title } : {}),
    }));
  }
  async getCapture(id: string): Promise<Capture | undefined> {
    return this.captures.find((c) => c.id === id);
  }
  async saveRecipe(raw: unknown, captureId?: string): Promise<SaveRecipeResult & { captureFinished: boolean }> {
    this.saveCalls.push({ raw, captureId });
    const payload =
      typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
        ? raw
        : { ...(raw as object | null | undefined), id: "pers-a-deriver" };
    const v = parseRecipe(payload);
    if (!v.ok) return { ...v, captureFinished: false };
    if (v.recipe.provenance.origin !== "personnelle") {
      return { ok: false, error: "provenance personnelle requise", captureFinished: false };
    }
    const id = `pers-${v.recipe.provenance.url.length.toString(16)}`;
    const existing = this.recipes.find((r) => r.id === id);
    if (existing) return { ok: true, recipe: existing, alreadySaved: true, captureFinished: false };
    const recipe: Recipe = { ...v.recipe, id };
    this.recipes.push(recipe);
    const finished = captureId ? this.captures.some((c) => c.id === captureId) : false;
    if (captureId) this.captures = this.captures.filter((c) => c.id !== captureId);
    return { ok: true, recipe, alreadySaved: false, captureFinished: finished };
  }
  async abandonCapture(id: string): Promise<boolean> {
    const before = this.captures.length;
    this.captures = this.captures.filter((c) => c.id !== id);
    return this.captures.length < before;
  }
  async getPersonalRecipe(id: string): Promise<Recipe | undefined> {
    return this.recipes.find((r) => r.id === id);
  }
  async personalRecipes(): Promise<Recipe[]> {
    return this.recipes;
  }
  async claimNewRecipes(): Promise<Recipe[]> {
    const fresh = this.recipes.filter((r) => !this.announced.includes(r.id));
    this.announced.push(...fresh.map((r) => r.id));
    return fresh;
  }
}

function makeTools(runtime: MemoryRuntime = new MemoryRuntime()) {
  const tools = createRecipeTools({
    getCatalogueRecipe: (id) => catalogue.byId.get(id),
    catalogueRecipes: () => catalogue.recipes,
    runtime,
    search: searchRecipes,
    calculate: calculateIngredients,
  });
  const byName = (name: string): RecipeToolDescriptor => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`outil absent : ${name}`);
    return t;
  };
  return { tools, runtime, byName };
}

// ---- tool surface -----------------------------------------------------------

test("tool surface: the seven recipe tools are exposed", () => {
  const { tools } = makeTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "get_recipe",
      "search_recipes",
      "calculate_ingredients",
      "list_pending_captures",
      "get_pending_capture",
      "save_recipe",
      "abandon_capture",
    ],
  );
});

test("get_recipe: catalogue recipe, complete text + provenance", async () => {
  const { byName } = makeTools();
  const res = await byName("get_recipe").execute({ recipe_id: "crepes-classiques" });
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.match(text, /Crêpes classiques/);
  assert.match(text, /farine de blé : 250 g/);
  assert.match(text, /licence : MIT/);
});

test("get_recipe: personal recipe after save; unknown id lists search hint", async () => {
  const runtime = new MemoryRuntime();
  const { byName } = makeTools(runtime);
  const saved = await runtime.saveRecipe({
    title: "Curry de poulet",
    servings: 4,
    ingredients: [{ name: "Poulet", quantity: 400, unit: "g" }],
    steps: ["Cuire."],
    provenance: { origin: "personnelle", url: "https://jow.fr/curry", savedAt: "2026-10-18T09:00:00Z" },
  });
  if (!saved.ok) throw new Error(saved.error);
  const res = await byName("get_recipe").execute({ recipe_id: saved.recipe.id });
  assert.match(res.content[0].text, /Curry de poulet/);
  assert.match(res.content[0].text, /Recette personnelle — source : https:\/\/jow.fr\/curry/);

  const unknown = await byName("get_recipe").execute({ recipe_id: "nimporte-quoi" });
  assert.equal(unknown.isError, true);
  // Exploitable whatever the catalogue size: either the (small) id list or
  // the recipe count, plus the search_recipes hint.
  assert.match(unknown.content[0].text, /search_recipes/);
  assert.match(unknown.content[0].text, /(Recettes du catalogue disponibles|Le catalogue intégré contient \d+ recettes)/);
});

test("search_recipes: unified, compact lines with origin + pagination footer", async () => {
  const runtime = new MemoryRuntime();
  const { byName } = makeTools(runtime);
  await runtime.saveRecipe({
    title: "Curry de poulet",
    servings: 4,
    ingredients: [{ name: "Poulet", quantity: 400, unit: "g" }],
    steps: ["Cuire."],
    provenance: { origin: "personnelle", url: "https://jow.fr/curry", savedAt: "2026-10-18T09:00:00Z" },
  });
  const res = await byName("search_recipes").execute({ query: "curry" });
  assert.match(res.content[0].text, /\[personnelle\] pers-/);
  const all = await byName("search_recipes").execute({ query: "", page_size: 50 });
  assert.match(all.content[0].text, /affichés sur \d+/);
  assert.match(all.content[0].text, /\[catalogue\] crepes-classiques/);
});

test("calculate_ingredients: scales, groups and reports contributions", async () => {
  const { byName } = makeTools();
  const res = await byName("calculate_ingredients").execute({
    entries: [
      { recipe_id: "crepes-classiques", target_servings: 8 },
      { recipe_id: "gratin-dauphinois", target_servings: 6 },
    ],
  });
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.match(text, /Crêpes classiques — 8 portions/);
  assert.match(text, /## Liste consolidée/);
  assert.match(text, /lait : 1200 ml/); // crêpes x2 → 1000 ml + gratin x1 → 200 ml
  assert.match(text, /pommes de terre : 1.2 kg/);
  // Contribution details present.
  assert.match(text, /· Crêpes classiques : 1000 ml ; Gratin dauphinois : 200 ml/);
});

test("calculate_ingredients: temporary substitution applies only to this call", async () => {
  const { byName } = makeTools();
  const entries: Array<{ recipe_id: string; target_servings: number; substitutions?: unknown[] }> = [
    {
      recipe_id: "crepes-classiques",
      target_servings: 4,
      substitutions: [{ name: "lait", replacement: { name: "Lait d'avoine", quantity: 500, unit: "ml" } }],
    },
  ];
  const res = await byName("calculate_ingredients").execute({ entries });
  assert.match(res.content[0].text, /lait d'avoine : 500 ml/);
  assert.doesNotMatch(res.content[0].text, /- lait : 500 ml/);
  // The stored recipe is untouched.
  const after = await byName("get_recipe").execute({ recipe_id: "crepes-classiques" });
  assert.match(after.content[0].text, /lait : 500 ml/);
});

test("calculate_ingredients: unknown recipe → exploitable error", async () => {
  const { byName } = makeTools();
  const res = await byName("calculate_ingredients").execute({
    entries: [{ recipe_id: "inconnue", target_servings: 4 }],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /inconnue/);
});

test("list/get pending captures, save and abandon flows", async () => {
  const runtime = new MemoryRuntime();
  const { byName } = makeTools(runtime);
  // No captures yet.
  assert.match(await byName("list_pending_captures").execute({}).then((r) => r.content[0].text), /Aucune capture/);

  // Seed a capture straight into the runtime double.
  const capture: Capture = {
    id: "cap-deadbeef",
    url: "https://jow.fr/fr/recette/curry-de-poulet",
    capturedAt: "2026-10-18T09:00:00.000Z",
    title: "Curry de poulet",
    excerpt: "Curry de poulet — 4 personnes. 400 g de poulet…",
    state: "pending",
  };
  runtime.captures.push(capture);

  const listed = await byName("list_pending_captures").execute({});
  assert.match(listed.content[0].text, /cap-deadbeef — Curry de poulet/);

  const read = await byName("get_pending_capture").execute({ capture_id: "cap-deadbeef" });
  assert.match(read.content[0].text, /données non fiables/);
  assert.match(read.content[0].text, /400 g de poulet/);

  const unknown = await byName("get_pending_capture").execute({ capture_id: "cap-0000" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Capture inconnue/);

  const saved = await byName("save_recipe").execute({
    capture_id: "cap-deadbeef",
    recipe: {
      title: "Curry de poulet",
      servings: 4,
      ingredients: [{ name: "Poulet", quantity: 400, unit: "g" }],
      steps: ["Cuire."],
      provenance: {
        origin: "personnelle",
        url: "https://jow.fr/fr/recette/curry-de-poulet",
        savedAt: "2026-10-18T09:00:00Z",
      },
    },
  });
  assert.equal(saved.isError, undefined);
  assert.match(saved.content[0].text, /Recette enregistrée : pers-/);
  assert.match(saved.content[0].text, /Capture cap-deadbeef terminée/);
  assert.equal(runtime.captures.length, 0);

  const invalid = await byName("save_recipe").execute({ recipe: { title: "Incomplete" } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Erreur :/);

  // Abandon flow.
  runtime.captures.push({ ...capture, id: "cap-abcd" });
  const abandoned = await byName("abandon_capture").execute({ capture_id: "cap-abcd" });
  assert.match(abandoned.content[0].text, /abandonnée/);
  assert.equal((await byName("list_pending_captures").execute({})).content[0].text.includes("cap-abcd"), false);
  const unknownAbandon = await byName("abandon_capture").execute({ capture_id: "cap-abcd" });
  assert.equal(unknownAbandon.isError, true);
});

// ---- notices ----------------------------------------------------------------

test("buildNotices: bounded block for captures + digest; empty when nothing pending", () => {
  const captures: CaptureSummary[] = Array.from({ length: 15 }, (_, i) => ({
    id: `cap-${i}`,
    url: `https://a.fr/${i}`,
    capturedAt: "2026-10-18T09:00:00Z",
  }));
  const newRecipes = catalogue.recipes.slice(0, 2);
  const block = buildNotices(captures, newRecipes);
  assert.match(block, /Captures de pages en attente \(15\)/);
  assert.match(block, /… et 5 autres/);
  assert.match(block, /Nouvelles recettes personnelles enregistrées \(2\)/);
  assert.equal(buildNotices([], []), "");
});

test("withNotices: claims the digest on success only; errors stay untouched", async () => {
  const runtime = new MemoryRuntime();
  const saved = await runtime.saveRecipe({
    title: "Curry de poulet",
    servings: 4,
    ingredients: [{ name: "Poulet", quantity: 400, unit: "g" }],
    steps: ["Cuire."],
    provenance: { origin: "personnelle", url: "https://jow.fr/curry", savedAt: "2026-10-18T09:00:00Z" },
  });
  if (!saved.ok) throw new Error(saved.error);

  const okResult: ToolTextResult = { content: [{ type: "text", text: "OK" }] };
  const errResult: ToolTextResult = { content: [{ type: "text", text: "Erreur : x" }], isError: true };

  const wrapped = await withNotices(okResult, runtime);
  assert.match(wrapped.content[0].text, /OK\n\n---\n\nNouvelles recettes personnelles enregistrées \(1\)/);

  // Error results never claim nor announce.
  const errWrapped = await withNotices(errResult, runtime);
  assert.equal(errWrapped.isError, true);
  assert.doesNotMatch(errWrapped.content[0].text, /Nouvelles recettes/);

  // Digest consumed: a second success has no announcement left.
  const second = await withNotices(okResult, runtime);
  assert.doesNotMatch(second.content[0].text, /Nouvelles recettes/);
});

test("formatRecipe: optional fields render only when present", () => {
  const omelette = catalogue.byId.get("omelette-au-fromage");
  if (!omelette) throw new Error("fixture manquante");
  const text = formatRecipe(omelette);
  assert.match(text, /catégorie : plat/);
  const minimal = formatRecipe({
    ...omelette,
    category: undefined,
    prepMinutes: undefined,
    cookMinutes: undefined,
  });
  assert.doesNotMatch(minimal, /catégorie/);
});
