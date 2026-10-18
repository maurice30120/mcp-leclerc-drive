/**
 * Recipe service (tickets 07–11 storage core): the runtime the MCP tools talk
 * to, composed over the capture store and the personal library. The
 * extension background and the integration harness build the same service —
 * only the storage adapter differs.
 *
 * Spec rules under test:
 *   - saving a recipe from a capture finishes that capture; a replayed save
 *     creates no duplicate recipe, no duplicate digest, and no error;
 *   - abandoning removes the capture without creating any recipe — and is
 *     distinct from a storage failure, which throws;
 *   - concurrent digest claims never announce the same recipe twice;
 *   - everything survives a restart (new service over the same storage).
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe } from "../src/recipes/contract.ts";
import { buildCaptureRecord, type Capture } from "../src/recipes/capture.ts";
import { createCaptureStore, type CaptureStorageAdapter } from "../src/recipes/capture-store.ts";
import { createLibraryStore } from "../src/recipes/library.ts";
import { createRecipeService } from "../src/recipes/service.ts";

function memoryAdapter(): CaptureStorageAdapter & { raw(): Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
    raw: () => data,
  };
}

function service(adapter: CaptureStorageAdapter) {
  return createRecipeService({
    captureStore: createCaptureStore(adapter),
    libraryStore: createLibraryStore(adapter, parseRecipe),
  });
}

function makeCapture(url: string): Capture {
  const r = buildCaptureRecord({
    url,
    capturedAt: 1760000000000,
    title: "Page de recette",
    excerpt: "Curry de poulet — 4 personnes. Ingrédients : 400 g de poulet…",
  });
  if (!r.ok) throw new Error(r.error);
  return r.capture;
}

async function seedCapture(adapter: CaptureStorageAdapter, url: string): Promise<Capture> {
  const capture = makeCapture(url);
  await createCaptureStore(adapter).save(capture);
  return capture;
}

function rawRecipe(url: string, title = "Curry de poulet"): Record<string, unknown> {
  return {
    id: "ignored",
    title,
    servings: 4,
    ingredients: [
      { name: "Poulet", quantity: 400, unit: "g" },
      { name: "Lait de coco", quantity: 200, unit: "ml" },
    ],
    steps: ["Mariner.", "Cuire."],
    provenance: {
      origin: "personnelle",
      url,
      savedAt: "2026-10-18T09:00:00.000Z",
    },
  };
}

test("saveRecipe: persists a valid recipe and finishes the linked capture", async () => {
  const adapter = memoryAdapter();
  const capture = await seedCapture(adapter, "https://jow.fr/fr/recette/curry-de-poulet");
  const svc = service(adapter);

  const r = await svc.saveRecipe(rawRecipe("https://jow.fr/fr/recette/curry-de-poulet"), capture.id);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.alreadySaved, false);
  assert.equal(r.captureFinished, true);
  assert.equal((await svc.listCaptures()).length, 0, "capture terminée");
  const got = await svc.getPersonalRecipe(r.recipe.id);
  assert.ok(got);
});

test("saveRecipe: replay with the same capture is idempotent, no duplicate digest", async () => {
  const adapter = memoryAdapter();
  const capture = await seedCapture(adapter, "https://jow.fr/fr/recette/curry-de-poulet");
  const svc = service(adapter);
  const first = await svc.saveRecipe(rawRecipe("https://jow.fr/fr/recette/curry-de-poulet"), capture.id);
  if (!first.ok) throw new Error(first.error);
  const replay = await svc.saveRecipe(rawRecipe("https://jow.fr/fr/recette/curry-de-poulet"), capture.id);
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.captureFinished, false, "capture déjà terminée");
  const personal = await svc.personalRecipes();
  assert.equal(personal.length, 1);
  const digest = await svc.claimNewRecipes();
  assert.equal(digest.length, 1, "une seule annonce pour une recette rejouée");
});

test("saveRecipe: invalid payload → error, capture stays pending", async () => {
  const adapter = memoryAdapter();
  const capture = await seedCapture(adapter, "https://a.fr/recette");
  const svc = service(adapter);
  const r = await svc.saveRecipe(
    { ...rawRecipe("https://a.fr/recette"), servings: 0 },
    capture.id,
  );
  assert.equal(r.ok, false);
  assert.equal((await svc.listCaptures()).length, 1, "capture toujours en attente");
  assert.equal((await svc.personalRecipes()).length, 0);
});

test("abandonCapture: removes the capture, creates no recipe, no digest", async () => {
  const adapter = memoryAdapter();
  const capture = await seedCapture(adapter, "https://inexploitable.fr/recette");
  const svc = service(adapter);
  assert.equal(await svc.abandonCapture(capture.id), true);
  assert.equal(await svc.abandonCapture(capture.id), false, "déjà abandonnée");
  assert.equal((await svc.listCaptures()).length, 0);
  assert.equal((await svc.personalRecipes()).length, 0);
  assert.equal((await svc.claimNewRecipes()).length, 0);
});

test("claimNewRecipes: concurrent claims never announce the same recipe twice", async () => {
  const adapter = memoryAdapter();
  const svc = service(adapter);
  await svc.saveRecipe(rawRecipe("https://a.fr/curry"));
  await svc.saveRecipe(rawRecipe("https://b.fr/lasagnes", "Lasagnes"));

  // Two concurrent tool responses claim the digest at the same moment.
  const [c1, c2] = await Promise.all([
    svc.claimNewRecipes(),
    svc.claimNewRecipes(),
  ]);
  const ids = [...c1, ...c2].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "aucune recette annoncée deux fois");
  assert.equal(c1.length + c2.length, 2);
  // The next claim gets nothing.
  assert.equal((await svc.claimNewRecipes()).length, 0);
});

test("restart: a fresh service over the same storage sees recipes, captures and digest state", async () => {
  const adapter = memoryAdapter();
  const capture = await seedCapture(adapter, "https://jow.fr/fr/recette/curry-de-poulet");
  const svc = service(adapter);
  const saved = await svc.saveRecipe(rawRecipe("https://jow.fr/fr/recette/curry-de-poulet"), capture.id);
  if (!saved.ok) throw new Error(saved.error);
  await svc.claimNewRecipes();

  const revived = service(adapter);
  assert.equal((await revived.listCaptures()).length, 0);
  const got = await revived.getPersonalRecipe(saved.recipe.id);
  assert.ok(got, "recette conservée après relance");
  assert.equal((await revived.claimNewRecipes()).length, 0, "pas de ré-annonce après relance");
});

test("storage failure: saveRecipe surfaces the error, never a success", async () => {
  const failing: CaptureStorageAdapter = {
    async get() {
      return {};
    },
    async set() {
      throw new Error("quota dépassé");
    },
  };
  const svc = createRecipeService({
    captureStore: createCaptureStore(failing),
    libraryStore: createLibraryStore(failing, parseRecipe),
  });
  await assert.rejects(
    () => svc.saveRecipe(rawRecipe("https://a.fr/curry")),
    /quota/,
  );
});
