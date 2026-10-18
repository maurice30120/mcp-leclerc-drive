import { describe, expect, it } from "vitest";
import {
  InMemoryModelCacheStore,
  downloadModel,
  validateModelManifest,
  type FetchLike,
  type ModelDownloadProgress,
  type ModelManifest,
} from "../src/index.js";
import sampleManifestJson from "./fixtures/sample-manifest.json";

function validManifest(): ModelManifest {
  const result = validateModelManifest(JSON.parse(JSON.stringify(sampleManifestJson)));
  if (!result.ok) throw new Error(result.issues.join("; "));
  return result.manifest;
}

interface RecordedFetch {
  url: string;
  signal?: AbortSignal;
}

/**
 * Fake transport serving the manifest's declared sizes; a per-file override
 * map lets a test corrupt one file (size or digest) without touching the rest.
 */
function makeFetch(options?: { badStatusFor?: string }): {
  calls: RecordedFetch[];
  fetch: FetchLike;
} {
  const manifest = validManifest();
  const calls: RecordedFetch[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, signal: init.signal });
    if (options?.badStatusFor && url.endsWith(options.badStatusFor)) {
      return Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }
    const file = manifest.files.find((f) => url.endsWith(f.path));
    if (!file) {
      return Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new Uint8Array(file.sizeBytes).buffer),
    });
  };
  return { calls, fetch };
}

/** Digest function: returns the manifest digest for correct-size bytes, junk otherwise. */
function makeHashBytes(corruptFor?: string) {
  const manifest = validManifest();
  return async (bytes: ArrayBuffer): Promise<string> => {
    for (const file of manifest.files) {
      if (bytes.byteLength === file.sizeBytes && file.sha256) {
        if (!corruptFor || file.path === corruptFor) {
          return corruptFor === file.path ? "f".repeat(64) : file.sha256;
        }
        return file.sha256;
      }
    }
    return "f".repeat(64);
  };
}

function okOptions(overrides?: Partial<Parameters<typeof downloadModel>[0]>) {
  const manifest = validManifest();
  const { calls, fetch } = makeFetch();
  const cache = new InMemoryModelCacheStore();
  const events: ModelDownloadProgress[] = [];
  const opts = {
    manifest,
    fetchImpl: fetch,
    consent: async () => true,
    cache,
    onProgress: (p: ModelDownloadProgress) => events.push(p),
    hashBytes: makeHashBytes(),
    ...overrides,
  };
  return { calls, events, cache, manifest, opts };
}

describe("downloadModel — consent gate", () => {
  it("never fetches a byte when consent is refused", async () => {
    const { calls, cache, opts } = okOptions({ consent: async () => false });
    const result = await downloadModel(opts);
    expect(result).toMatchObject({ ok: false, code: "CONSENT_REFUSED" });
    expect(calls).toHaveLength(0);
    expect(await cache.current()).toBeUndefined();
    if (typeof result.message !== "string" || result.message.length === 0) {
      throw new Error("refusal must carry a message");
    }
  });

  it("never fetches a byte when consent is not granted", async () => {
    const { calls, cache, opts } = okOptions({ consent: () => false });
    await downloadModel(opts);
    expect(calls).toHaveLength(0);
    expect(await cache.get(validManifest())).toBeUndefined();
  });

  it("refuses before fetching when the manifest declares checksums but no digest function is injected", async () => {
    const { calls, cache, opts } = okOptions({ hashBytes: undefined });
    const result = await downloadModel(opts);
    expect(result).toMatchObject({ ok: false, code: "VERIFY_FAILED" });
    expect(calls).toHaveLength(0);
    expect(await cache.current()).toBeUndefined();
  });
});

describe("downloadModel — happy path", () => {
  it("downloads every manifest file, verifies it, and commits the cache entry", async () => {
    const { cache, calls, events, manifest, opts } = okOptions();
    const result = await downloadModel(opts);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.fromCache).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(["tokenizer.json", "onnx/model_q4.onnx"]);
    expect(calls.map((c) => c.url)).toEqual([
      `${manifest.sourceUrl}/${manifest.files[0].path}`,
      `${manifest.sourceUrl}/${manifest.files[1].path}`,
    ]);
    const cached = await cache.get(manifest);
    expect(cached?.files).toHaveLength(2);
    expect(await cache.current()).toEqual({
      modelId: manifest.modelId,
      revision: manifest.revision,
      sizeBytes: manifest.totalSizeBytes,
    });
    expect(events.length).toBe(2);
  });

  it("emits per-file progress with byte counts and totals", async () => {
    const { events, opts } = okOptions();
    await downloadModel(opts);
    const manifest = validManifest();
    expect(events).toEqual([
      {
        modelId: manifest.modelId,
        file: "tokenizer.json",
        fileBytes: 1234,
        fileSizeBytes: 1234,
        totalBytes: 1234,
        totalSizeBytes: manifest.totalSizeBytes,
      },
      {
        modelId: manifest.modelId,
        file: "onnx/model_q4.onnx",
        fileBytes: 100,
        fileSizeBytes: 100,
        totalBytes: 1334,
        totalSizeBytes: manifest.totalSizeBytes,
      },
    ]);
  });

  it("passes the AbortSignal through to the injected fetch", async () => {
    const controller = new AbortController();
    const { calls, opts } = okOptions({ signal: controller.signal });
    await downloadModel(opts);
    expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
  });
});

describe("downloadModel — failure atomicity (no partial cache entry)", () => {
  it("commits nothing when a checksum mismatches", async () => {
    const { calls, cache, opts } = okOptions({ hashBytes: makeHashBytes("onnx/model_q4.onnx") });
    const result = await downloadModel(opts);
    expect(result).toMatchObject({ ok: false, code: "VERIFY_FAILED", file: "onnx/model_q4.onnx" });
    expect(calls).toHaveLength(2);
    expect(await cache.get(validManifest())).toBeUndefined();
    expect(await cache.current()).toBeUndefined();
  });

  it("commits nothing when the served size disagrees with the manifest", async () => {
    const manifest = validManifest();
    const { calls, cache } = makeFetch();
    const cacheStore = new InMemoryModelCacheStore();
    const result = await downloadModel({
      manifest,
      fetchImpl: async (url, init) => {
        calls.push({ url, signal: init.signal });
        return {
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(7)), // wrong size
        };
      },
      consent: () => true,
      cache: cacheStore,
      hashBytes: makeHashBytes(),
    });
    expect(result).toMatchObject({ ok: false, code: "VERIFY_FAILED" });
    expect(await cacheStore.get(manifest)).toBeUndefined();
    expect(await cacheStore.current()).toBeUndefined();
  });

  it("commits nothing when a fetch returns a non-ok status", async () => {
    const { cache, opts } = okOptions();
    const { calls: badCalls, fetch } = makeFetch({ badStatusFor: "onnx/model_q4.onnx" });
    const result = await downloadModel({ ...opts, fetchImpl: fetch });
    expect(result).toMatchObject({ ok: false, code: "FETCH_FAILED", file: "onnx/model_q4.onnx" });
    expect(badCalls).toHaveLength(2);
    expect(await cache.current()).toBeUndefined();
  });

  it("commits nothing when the transport throws (offline)", async () => {
    const { cache, opts } = okOptions();
    const result = await downloadModel({
      ...opts,
      fetchImpl: () => Promise.reject(new Error("network down")),
    });
    expect(result).toMatchObject({ ok: false, code: "FETCH_FAILED" });
    expect(await cache.get(validManifest())).toBeUndefined();
  });

  it("aborts mid-download on request and commits nothing", async () => {
    const controller = new AbortController();
    const { calls, cache, opts } = okOptions({
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    const result = await downloadModel(opts);
    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
    expect(calls).toHaveLength(1); // first file done, abort before the second
    expect(await cache.get(validManifest())).toBeUndefined();
    expect(await cache.current()).toBeUndefined();
  });

  it("aborts before the first byte when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, cache, opts } = okOptions({ signal: controller.signal });
    const result = await downloadModel(opts);
    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
    expect(calls).toHaveLength(0);
    expect(await cache.current()).toBeUndefined();
  });
});

describe("downloadModel — offline execution from cache", () => {
  it("serves a cached revision without any network call (provider adapter reads the cache)", async () => {
    const { cache, manifest, opts } = okOptions();
    const first = await downloadModel(opts);
    expect(first.ok).toBe(true);

    // Offline: the transport is gone entirely.
    const { calls } = makeFetch();
    const offlineFetch: FetchLike = () => {
      calls.push({ url: "must-not-be-called" });
      throw new Error("offline");
    };
    const result = await downloadModel({ ...opts, fetchImpl: offlineFetch, consent: () => false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.fromCache).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(calls).toHaveLength(0);
    expect((await cache.get(manifest))?.files).toHaveLength(2);
  });
});
