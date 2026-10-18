/**
 * Capture store (ticket 02): the bounded set of operations on captured pages.
 * Later tickets (MCP signalling, reading, structuring, abandoning) consume
 * these operations without touching the popup controller. A storage failure
 * is never presented as a success.
 */
import { test, assert } from "./helpers.ts";
import { buildCaptureRecord, type Capture } from "../src/recipes/capture.ts";
import {
  createCaptureStore,
  CAPTURES_STORAGE_KEY,
  type CaptureStorageAdapter,
} from "../src/recipes/capture-store.ts";

/** In-memory storage double, mirroring chrome.storage.local semantics. */
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

/** Distinct timestamps per URL so ordering assertions are deterministic. */
function capture(url: string, title?: string): Capture {
  const r = buildCaptureRecord({
    url,
    capturedAt: 1760000000000 + [...url].reduce((n, ch) => n + ch.charCodeAt(0), 0) * 1000,
    title,
    excerpt: `Extrait de ${url}`,
  });
  if (!r.ok) throw new Error(r.error);
  return r.capture;
}

test("save + list + get: round-trips a capture, oldest first", async () => {
  const adapter = memoryAdapter();
  const store = createCaptureStore(adapter);
  const a = capture("https://a.fr/recette-1");
  const b = capture("https://b.fr/recette-2");
  await store.save(b);
  await store.save(a);
  const listed = await store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].url, "https://a.fr/recette-1");
  const got = await store.get(b.id);
  assert.ok(got);
  assert.equal(got.url, "https://b.fr/recette-2");
  // Persistence surface: the map lives in one storage key.
  const raw = adapter.raw()[CAPTURES_STORAGE_KEY] as Record<string, Capture>;
  assert.ok(raw[a.id]);
});

test("save: same URL twice keeps a single record (same stable id)", async () => {
  const store = createCaptureStore(memoryAdapter());
  const first = capture("https://a.fr/recette-1");
  const again = capture("https://a.fr/recette-1", "Titre mis à jour");
  await store.save(first);
  await store.save(again);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Titre mis à jour");
});

test("save: rejects an invalid capture instead of storing a partial one", async () => {
  const store = createCaptureStore(memoryAdapter());
  await assert.rejects(
    () => store.save({ ...capture("https://a.fr/r"), excerpt: "" }),
    /capture invalide/i,
  );
  const listed = await store.list();
  assert.equal(listed.length, 0);
});

test("finish: removes the capture; unknown id is a clean false", async () => {
  const store = createCaptureStore(memoryAdapter());
  const c = capture("https://a.fr/recette-1");
  await store.save(c);
  assert.equal(await store.finish(c.id), true);
  assert.equal(await store.get(c.id), undefined);
  assert.equal(await store.list().then((l) => l.length), 0);
  assert.equal(await store.finish("cap-00000000"), false);
});

test("storage failure: save/list/finish throw — never a silent success", async () => {
  const failing: CaptureStorageAdapter = {
    async get() {
      return {};
    },
    async set() {
      throw new Error("quota dépassé");
    },
  };
  const store = createCaptureStore(failing);
  await assert.rejects(() => store.save(capture("https://a.fr/r")), /quota/);
  const failingRead: CaptureStorageAdapter = {
    async get() {
      throw new Error("stockage indisponible");
    },
    async set() {},
  };
  const store2 = createCaptureStore(failingRead);
  await assert.rejects(() => store2.list(), /stockage indisponible/);
});

test("corrupt stored data: fails loudly instead of returning garbage", async () => {
  const adapter = memoryAdapter({
    [CAPTURES_STORAGE_KEY]: { "cap-dead": { url: "https://a.fr", excerpt: "…" } },
  });
  const store = createCaptureStore(adapter);
  await assert.rejects(() => store.list(), /corrompu/);
  const adapter2 = memoryAdapter({ [CAPTURES_STORAGE_KEY]: "not-a-map" });
  await assert.rejects(() => createCaptureStore(adapter2).list(), /corrompu/);
});

test("empty storage: list and get stay usable", async () => {
  const store = createCaptureStore(memoryAdapter());
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get("cap-nope"), undefined);
});
