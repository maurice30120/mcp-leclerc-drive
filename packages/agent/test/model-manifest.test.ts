import { describe, expect, it } from "vitest";
import {
  MANIFEST_FORMAT_VERSION,
  validateModelManifest,
  verifyManifestFile,
  type ModelManifest,
} from "../src/index.js";
import sampleManifestJson from "./fixtures/sample-manifest.json";

function validManifest(): ModelManifest {
  const result = validateModelManifest(JSON.parse(JSON.stringify(sampleManifestJson)));
  if (!result.ok) throw new Error(result.issues.join("; "));
  return result.manifest;
}

describe("model manifest — fixture validation", () => {
  it("the sample fixture parses and validates as a v1 manifest", () => {
    const result = validateModelManifest(JSON.parse(JSON.stringify(sampleManifestJson)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join("; "));
    expect(result.manifest.modelId).toBe("onnx-community/Qwen3-0.6B-ONNX");
    expect(result.manifest.files).toHaveLength(2);
    expect(result.manifest.totalSizeBytes).toBe(1334);
    expect(result.manifest.trainingProvenance.baseModel).toBe("Qwen/Qwen3-0.6B");
  });

  it("pins the manifest format version to 1", () => {
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
    expect(JSON.parse(JSON.stringify(sampleManifestJson)).formatVersion).toBe(
      MANIFEST_FORMAT_VERSION,
    );
  });
});

describe("model manifest — invalid variants", () => {
  const cases: Array<{ name: string; candidate: () => unknown }> = [
    { name: "not an object", candidate: () => "not-an-object" },
    { name: "null", candidate: () => null },
    { name: "unknown format version", candidate: () => ({ ...base(), formatVersion: 2 }) },
    { name: "missing format version", candidate: () => without("formatVersion") },
    { name: "empty modelId", candidate: () => ({ ...base(), modelId: "" }) },
    { name: "missing modelId", candidate: () => without("modelId") },
    { name: "non-string modelId", candidate: () => ({ ...base(), modelId: 42 }) },
    { name: "empty revision", candidate: () => ({ ...base(), revision: "" }) },
    { name: "empty tokenizer", candidate: () => ({ ...base(), tokenizer: "" }) },
    { name: "empty license", candidate: () => ({ ...base(), license: "" }) },
    { name: "empty sourceUrl", candidate: () => ({ ...base(), sourceUrl: "" }) },
    { name: "empty dtype", candidate: () => ({ ...base(), dtype: "" }) },
    { name: "unsupported format", candidate: () => ({ ...base(), format: "gguf" }) },
    { name: "missing files", candidate: () => without("files") },
    { name: "empty files array", candidate: () => ({ ...base(), files: [] }) },
    {
      name: "file without path",
      candidate: () => withFile(0, { sizeBytes: 1 }),
    },
    {
      name: "file with empty path",
      candidate: () => withFile(0, { path: "", sizeBytes: 1 }),
    },
    {
      name: "file with zero size",
      candidate: () => withFile(0, { path: "a.json", sizeBytes: 0 }),
    },
    {
      name: "file with negative size",
      candidate: () => withFile(0, { path: "a.json", sizeBytes: -5 }),
    },
    {
      name: "file with non-integer size",
      candidate: () => withFile(0, { path: "a.json", sizeBytes: 1.5 }),
    },
    {
      name: "file with malformed sha256",
      candidate: () => withFile(0, { path: "a.json", sizeBytes: 1, sha256: "deadbeef" }),
    },
    {
      name: "file with non-hex sha256",
      candidate: () => withFile(0, { path: "a.json", sizeBytes: 1, sha256: "z".repeat(64) }),
    },
    {
      name: "totalSizeBytes disagrees with the file list",
      candidate: () => ({ ...base(), totalSizeBytes: 999999 }),
    },
    {
      name: "totalSizeBytes not a positive integer",
      candidate: () => ({ ...base(), totalSizeBytes: -1 }),
    },
    {
      name: "duplicate file paths",
      candidate: () => {
        const m = base();
        m.files = [m.files[0], { ...m.files[0] }];
        return m;
      },
    },
    {
      name: "missing trainingProvenance",
      candidate: () => without("trainingProvenance"),
    },
    {
      name: "trainingProvenance without baseModel",
      candidate: () => ({ ...base(), trainingProvenance: {} }),
    },
    {
      name: "trainingProvenance with empty baseModel",
      candidate: () => ({ ...base(), trainingProvenance: { baseModel: "" } }),
    },
    {
      name: "trainingProvenance with non-string dataset",
      candidate: () => ({ ...base(), trainingProvenance: { baseModel: "x", dataset: 7 } }),
    },
    {
      name: "unknown extra top-level key",
      candidate: () => ({ ...base(), surprise: "no" }),
    },
  ];

  function base(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(sampleManifestJson));
  }

  function without(key: string): Record<string, unknown> {
    const m = base();
    delete m[key];
    return m;
  }

  function withFile(index: number, file: Record<string, unknown>): Record<string, unknown> {
    const m = base();
    const files = m.files as Array<Record<string, unknown>>;
    files[index] = file;
    return m;
  }

  for (const { name, candidate } of cases) {
    it(`rejects: ${name}`, () => {
      const result = validateModelManifest(candidate());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.every((issue) => typeof issue === "string" && issue.length > 0)).toBe(
          true,
        );
      }
    });
  }
});

describe("verifyManifestFile", () => {
  it("accepts a file whose size and digest match the manifest", () => {
    const manifest = validManifest();
    const weight = manifest.files[1];
    if (!weight.sha256) throw new Error("fixture weight must declare a sha256");
    const result = verifyManifestFile(manifest, weight.path, weight.sizeBytes, weight.sha256);
    expect(result).toEqual({ ok: true });
  });

  it("rejects an unknown file path", () => {
    const result = verifyManifestFile(validManifest(), "unknown.onnx", 100, "0".repeat(64));
    expect(result.ok).toBe(false);
  });

  it("rejects a size mismatch", () => {
    const manifest = validManifest();
    const weight = manifest.files[1];
    const result = verifyManifestFile(manifest, weight.path, weight.sizeBytes - 1, weight.sha256);
    expect(result.ok).toBe(false);
  });

  it("rejects a checksum mismatch", () => {
    const manifest = validManifest();
    const weight = manifest.files[1];
    const result = verifyManifestFile(manifest, weight.path, weight.sizeBytes, "f".repeat(64));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing digest when the manifest declares one", () => {
    const manifest = validManifest();
    const weight = manifest.files[1];
    const result = verifyManifestFile(manifest, weight.path, weight.sizeBytes);
    expect(result.ok).toBe(false);
  });

  it("accepts size-only verification when the manifest declares no checksum", () => {
    const manifest: ModelManifest = {
      ...validManifest(),
      files: [{ path: "plain.json", sizeBytes: 7 }],
      totalSizeBytes: 7,
    };
    const result = verifyManifestFile(manifest, "plain.json", 7);
    expect(result).toEqual({ ok: true });
  });
});
