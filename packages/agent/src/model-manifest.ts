/**
 * Versioned, verifiable local-model manifest (spec issue #40, ticket #52).
 *
 * A manifest is a small JSON document describing EVERYTHING needed to fetch
 * and verify one local model revision before it is ever loaded: model id,
 * revision, tokenizer, the exact file list with byte sizes and sha256
 * checksums, total size, dtype, format, training provenance, license and the
 * public source URL (Hugging Face `resolve` endpoint). `formatVersion` pins
 * the schema: a manifest with an unknown version is rejected, never guessed.
 *
 * The manifest is the trust anchor of the download pipeline (model-download):
 * files are fetched only from `sourceUrl + path`, and every file is verified
 * against the declared size — and checksum when the source exposes one.
 *
 * Packaging policy: no model weights ship inside the published extension
 * package. Weights are data, fetched at first use with explicit consent;
 * the .gitignore/dist policy already keeps them out of the packaged artifact,
 * so nothing here needs to know about packaging.
 */

/** Current manifest schema version — manifests with another version are rejected. */
export const MANIFEST_FORMAT_VERSION = 1;

/** The only execution format the extension pipeline accepts today. */
export type ModelManifestFormat = "onnx";

/** One file of a model revision, as declared by the manifest. */
export interface ManifestFile {
  /** Path relative to the manifest `sourceUrl`. */
  path: string;
  /** Exact expected byte size — verified after download. */
  sizeBytes: number;
  /** Lowercase hex sha256 of the file content, when the source exposes it. */
  sha256?: string;
}

/** Where the model comes from and how it was trained. */
export interface TrainingProvenance {
  /** Base model the artifact derives from, e.g. "Qwen/Qwen3-0.6B". */
  baseModel: string;
  /** Training/instruction dataset, when applicable. */
  dataset?: string;
  /** Training method (full fine-tune, LoRA…), when applicable. */
  method?: string;
}

/** A verifiable description of one local model revision. */
export interface ModelManifest {
  formatVersion: number;
  /** Hugging Face repo id, e.g. "onnx-community/Qwen3-0.6B-ONNX". */
  modelId: string;
  /** Branch, tag or commit the files are resolved from. */
  revision: string;
  /** Path (relative to sourceUrl) of the tokenizer file. */
  tokenizer: string;
  /** Every file that must be present for offline execution. */
  files: ManifestFile[];
  /** Sum of `files[].sizeBytes` — kept consistent by validation. */
  totalSizeBytes: number;
  /** Quantization/precision of the ONNX weights, e.g. "q4". */
  dtype: string;
  format: ModelManifestFormat;
  trainingProvenance: TrainingProvenance;
  license: string;
  /** Public directory the relative `files[].path` resolve against. */
  sourceUrl: string;
}

/** Strict validation outcome — issues are English strings for logs/diagnostics. */
export type ModelManifestValidation =
  | { ok: true; manifest: ModelManifest }
  | { ok: false; issues: string[] };

/** Verification outcome for one downloaded file. */
export type ManifestFileVerification =
  | { ok: true }
  | { ok: false; issues: string[] };

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const TOP_LEVEL_KEYS = [
  "formatVersion",
  "modelId",
  "revision",
  "tokenizer",
  "files",
  "totalSizeBytes",
  "dtype",
  "format",
  "trainingProvenance",
  "license",
  "sourceUrl",
] as const;

const PROVENANCE_KEYS = ["baseModel", "dataset", "method"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requireNonEmptyString(
  issues: string[],
  container: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (!nonEmptyString(container[key])) {
    issues.push(`${label} must be a non-empty string`);
  }
}

/**
 * Strictly validates an untrusted manifest value (typically `JSON.parse` of a
 * fetched or versioned manifest). Unknown format versions, empty ids, empty
 * file lists, non-positive sizes, malformed checksums, `totalSizeBytes`
 * disagreeing with the file list, duplicate paths and unknown keys are all
 * rejected.
 */
export function validateModelManifest(value: unknown): ModelManifestValidation {
  if (!isObject(value)) {
    return { ok: false, issues: ["manifest must be a JSON object"] };
  }

  const issues: string[] = [];

  if (value.formatVersion !== MANIFEST_FORMAT_VERSION) {
    issues.push(`formatVersion must be ${MANIFEST_FORMAT_VERSION}`);
  }

  requireNonEmptyString(issues, value, "modelId", "modelId");
  requireNonEmptyString(issues, value, "revision", "revision");
  requireNonEmptyString(issues, value, "tokenizer", "tokenizer");
  requireNonEmptyString(issues, value, "license", "license");
  requireNonEmptyString(issues, value, "sourceUrl", "sourceUrl");
  requireNonEmptyString(issues, value, "dtype", "dtype");

  if (value.format !== "onnx") {
    issues.push('format must be "onnx"');
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    issues.push("files must be a non-empty array");
  } else {
    const seenPaths = new Set<string>();
    let sum = 0;
    value.files.forEach((file: unknown, index: number) => {
      if (!isObject(file)) {
        issues.push(`files[${index}] must be an object`);
        return;
      }
      if (!nonEmptyString(file.path)) {
        issues.push(`files[${index}].path must be a non-empty string`);
      } else if (seenPaths.has(file.path)) {
        issues.push(`files[${index}].path duplicates an earlier file ("${file.path}")`);
      } else {
        seenPaths.add(file.path);
      }
      if (!positiveInteger(file.sizeBytes)) {
        issues.push(`files[${index}].sizeBytes must be a positive integer`);
      } else {
        sum += file.sizeBytes;
      }
      const digest = file.sha256;
      if (digest !== undefined && (typeof digest !== "string" || !SHA256_PATTERN.test(digest))) {
        issues.push(`files[${index}].sha256 must be 64 lowercase hex characters`);
      }
    });
    if (positiveInteger(value.totalSizeBytes) && sum > 0 && value.totalSizeBytes !== sum) {
      issues.push(`totalSizeBytes (${value.totalSizeBytes}) must equal the sum of file sizes (${sum})`);
    }
  }

  if (!positiveInteger(value.totalSizeBytes)) {
    issues.push("totalSizeBytes must be a positive integer");
  }

  if (!isObject(value.trainingProvenance)) {
    issues.push("trainingProvenance must be an object");
  } else {
    requireNonEmptyString(
      issues,
      value.trainingProvenance,
      "baseModel",
      "trainingProvenance.baseModel",
    );
    for (const key of ["dataset", "method"] as const) {
      const optional = value.trainingProvenance[key];
      if (optional !== undefined && !nonEmptyString(optional)) {
        issues.push(`trainingProvenance.${key} must be a non-empty string when present`);
      }
    }
    for (const key of Object.keys(value.trainingProvenance)) {
      if (!(PROVENANCE_KEYS as readonly string[]).includes(key)) {
        issues.push(`trainingProvenance has unknown key "${key}"`);
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      issues.push(`unknown manifest key "${key}"`);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // All checks passed — the value has the validated ModelManifest shape.
  const manifest: ModelManifest = value as unknown as ModelManifest;
  return { ok: true, manifest };
}

/**
 * Post-download verification of one file against the manifest: the path must
 * be declared, the byte size must match exactly, and the sha256 digest must
 * match when the manifest declares one (a declared checksum without a digest
 * to compare against is a verification failure, not a pass).
 */
export function verifyManifestFile(
  manifest: ModelManifest,
  path: string,
  sizeBytes: number,
  sha256?: string,
): ManifestFileVerification {
  const issues: string[] = [];
  const declared = manifest.files.find((file) => file.path === path);
  if (!declared) {
    issues.push(`"${path}" is not declared in the manifest`);
  } else {
    if (sizeBytes !== declared.sizeBytes) {
      issues.push(`"${path}": size ${sizeBytes} bytes, expected ${declared.sizeBytes}`);
    }
    if (declared.sha256 !== undefined) {
      if (sha256 === undefined) {
        issues.push(`"${path}": manifest declares a sha256 but no digest was computed`);
      } else if (sha256 !== declared.sha256) {
        issues.push(`"${path}": sha256 mismatch`);
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}
