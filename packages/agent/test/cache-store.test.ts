import { describe, expect, it } from "vitest";
import {
  InMemoryModelCacheStore,
  validateModelManifest,
  type ModelManifest,
} from "../src/index.js";
import sampleManifestJson from "./fixtures/sample-manifest.json";

function validManifest(): ModelManifest {
  const result = validateModelManifest(JSON.parse(JSON.stringify(sampleManifestJson)));
  if (!result.ok) throw new Error(result.issues.join("; "));
  return result.manifest;
}

function revisionVariant(revision: string): ModelManifest {
  return { ...validManifest(), revision };
}

const FILES_A = [
  { path: "tokenizer.json", bytes: new Uint8Array([1, 2, 3]).buffer },
  { path: "onnx/model_q4.onnx", bytes: new Uint8Array([9, 9]).buffer },
];

describe("InMemoryModelCacheStore", () => {
  it("returns undefined before anything is cached", async () => {
    const cache = new InMemoryModelCacheStore();
    expect(await cache.get(validManifest())).toBeUndefined();
    expect(await cache.current()).toBeUndefined();
  });

  it("put then get returns the cached files for the same model+revision", async () => {
    const cache = new InMemoryModelCacheStore();
    const manifest = validManifest();
    await cache.put(manifest, FILES_A);
    const cached = await cache.get(manifest);
    expect(cached).toBeDefined();
    expect(cached?.manifest.modelId).toBe(manifest.modelId);
    expect(cached?.manifest.revision).toBe(manifest.revision);
    expect(cached?.files.map((f) => f.path)).toEqual([
      "tokenizer.json",
      "onnx/model_q4.onnx",
    ]);
  });

  it("keys entries by modelId+revision — a different revision is a miss", async () => {
    const cache = new InMemoryModelCacheStore();
    await cache.put(validManifest(), FILES_A);
    expect(await cache.get(revisionVariant("another-revision"))).toBeUndefined();
    expect((await cache.get(validManifest()))?.files).toHaveLength(2);
  });

  it("current() reports the modelId, revision and total size of the current model", async () => {
    const cache = new InMemoryModelCacheStore();
    const manifest = validManifest();
    await cache.put(manifest, FILES_A);
    expect(await cache.current()).toEqual({
      modelId: manifest.modelId,
      revision: manifest.revision,
      sizeBytes: manifest.totalSizeBytes,
    });
  });

  it("remove() drops the entry and its currency", async () => {
    const cache = new InMemoryModelCacheStore();
    const manifest = validManifest();
    await cache.put(manifest, FILES_A);
    await cache.remove(manifest);
    expect(await cache.get(manifest)).toBeUndefined();
    expect(await cache.current()).toBeUndefined();
  });

  it("remove() of a non-cached manifest is a no-op", async () => {
    const cache = new InMemoryModelCacheStore();
    await expect(cache.remove(validManifest())).resolves.toBeUndefined();
  });

  it("re-put updates the files in place and keeps the model current", async () => {
    const cache = new InMemoryModelCacheStore();
    const manifest = validManifest();
    await cache.put(manifest, FILES_A);
    const second = [{ path: "tokenizer.json", bytes: new Uint8Array([7]).buffer }];
    await cache.put(manifest, second);
    expect((await cache.get(manifest))?.files).toHaveLength(1);
    expect(await cache.current()).toEqual({
      modelId: manifest.modelId,
      revision: manifest.revision,
      sizeBytes: manifest.totalSizeBytes,
    });
  });

  it("a put of another revision makes that revision the current model", async () => {
    const cache = new InMemoryModelCacheStore();
    await cache.put(validManifest(), FILES_A);
    const variant = revisionVariant("v2");
    await cache.put(variant, FILES_A);
    expect(await cache.current()).toEqual({
      modelId: variant.modelId,
      revision: "v2",
      sizeBytes: variant.totalSizeBytes,
    });
    // The first revision stays cached for offline execution.
    expect(await cache.get(validManifest())).toBeDefined();
  });
});
