/**
 * Personal recipe library store + digest (tickets 07–11): validated recipes
 * are persisted with a stable id derived from the source URL, saves are
 * idempotent, and each new recipe is announced exactly once (digest state is
 * local and persistent). Seam: the store, over a storage adapter double —
 * same seam as the capture store.
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe, type Recipe } from "../src/recipes/contract.ts";
import {
  createLibraryStore,
  type CaptureStorageAdapter,
} from "../src/recipes/library.ts";

function memoryAdapter(initial?: Record<string, unknown>): CaptureStorageAdapter & {
  raw(): Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
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

/** Raw recipe payload as a MCP client's model would produce it. */
function rawPersonalRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ignored-and-derived",
    title: "Curry de poulet",
    servings: 4,
    ingredients: [
      { name: "Poulet", quantity: 400, unit: "g" },
      { name: "Lait de coco", quantity: 200, unit: "ml" },
    ],
    steps: ["Mariner le poulet.", "Cuire 20 minutes."],
    provenance: {
      origin: "personnelle",
      url: "https://jow.fr/fr/recette/curry-de-poulet",
      savedAt: "2026-10-18T09:00:00.000Z",
    },
    ...overrides,
  };
}

function freshStore(adapter: CaptureStorageAdapter) {
  return createLibraryStore(adapter, parseRecipe);
}

test("save: validates with the common contract and derives a stable id from the URL", async () => {
  const store = freshStore(memoryAdapter());
  const r = await store.save(rawPersonalRecipe());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.alreadySaved, false);
  assert.match(r.recipe.id, /^pers-[0-9a-f]{8}$/);
  assert.equal(r.recipe.provenance.origin, "personnelle");
  // The model-supplied id never leaks: the derived id is authoritative.
  assert.notEqual(r.recipe.id, "ignored-and-derived");
});

test("save: rejects an invalid recipe whole — nothing is stored", async () => {
  const adapter = memoryAdapter();
  const store = freshStore(adapter);
  const r = await store.save(rawPersonalRecipe({ servings: 0 }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /servings/);
  const listed = await store.list();
  assert.equal(listed.length, 0);
});

test("save: idempotent — replaying the same source URL returns the existing recipe", async () => {
  const store = freshStore(memoryAdapter());
  const first = await store.save(rawPersonalRecipe());
  if (!first.ok) throw new Error(first.error);
  const replay = await store.save(
    rawPersonalRecipe({ title: "Curry de poulet (modifié par le modèle)" }),
  );
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.recipe.id, first.recipe.id);
  // The reference recipe stays intact — a replay never overwrites it.
  assert.equal(replay.recipe.title, "Curry de poulet");
  assert.equal((await store.list()).length, 1);
});

test("save: two different pages produce two distinct recipes", async () => {
  const store = freshStore(memoryAdapter());
  await store.save(rawPersonalRecipe());
  const other = await store.save(
    rawPersonalRecipe({
      provenance: {
        origin: "personnelle",
        url: "https://www.marmiton.org/recettes/curry-poulet",
        savedAt: "2026-10-18T10:00:00.000Z",
      },
    }),
  );
  assert.equal(other.ok, true);
  assert.equal((await store.list()).length, 2);
});

test("claimNew: announces each new recipe exactly once", async () => {
  const store = freshStore(memoryAdapter());
  await store.save(rawPersonalRecipe());
  const first = await store.claimNew();
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "Curry de poulet");
  const second = await store.claimNew();
  assert.equal(second.length, 0);
  // A replay save is not a new recipe: no new announcement.
  await store.save(rawPersonalRecipe());
  assert.equal((await store.claimNew()).length, 0);
});

test("persistence: a new store instance over the same storage keeps recipes and digest state", async () => {
  const adapter = memoryAdapter();
  const store = freshStore(adapter);
  const saved = await store.save(rawPersonalRecipe());
  if (!saved.ok) throw new Error(saved.error);
  await store.claimNew();

  // "Restart": the service worker died; everything is rebuilt from storage.
  const revived = freshStore(adapter);
  const got = await revived.get(saved.recipe.id);
  assert.ok(got, "recette conservée après relance");
  assert.equal(got.title, "Curry de poulet");
  // The digest was already consumed before the restart: nothing re-announced.
  assert.equal((await revived.claimNew()).length, 0);
});

test("corrupt storage: fails loudly instead of returning garbage", async () => {
  const adapter = memoryAdapter({ "mcp-leclerc-drive:recipes": "not-a-map" });
  const store = freshStore(adapter);
  await assert.rejects(() => store.list(), /corrompu/i);
  const adapter2 = memoryAdapter({
    "mcp-leclerc-drive:recipes": { "pers-x": { title: "incomplet" } },
  });
  await assert.rejects(() => freshStore(adapter2).list(), /corrompu/i);
});

test("storage failure: save throws — never a silent success", async () => {
  const failing: CaptureStorageAdapter = {
    async get() {
      return {};
    },
    async set() {
      throw new Error("quota");
    },
  };
  const store = freshStore(failing);
  await assert.rejects(() => store.save(rawPersonalRecipe()), /quota/);
});

test("list: returns recipes sorted by save date, oldest first", async () => {
  const store = freshStore(memoryAdapter());
  await store.save(rawPersonalRecipe());
  await store.save(
    rawPersonalRecipe({
      title: "Curry lentilles",
      provenance: {
        origin: "personnelle",
        url: "https://a.fr/curry-lentilles",
        savedAt: "2026-10-18T08:00:00.000Z", // earlier than the other one
      },
    }),
  );
  const listed: Recipe[] = await store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].title, "Curry lentilles");
});
