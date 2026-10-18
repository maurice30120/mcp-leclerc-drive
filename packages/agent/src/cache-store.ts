/**
 * Model cache seam (spec issue #40, ticket #52).
 *
 * The manifest-verified download pipeline (model-download.ts) commits into
 * this seam and the local provider adapter reads from it: as long as every
 * manifest file is cached, the model runs fully OFFLINE — no network access
 * at inference time.
 *
 * Chrome wiring is deliberately NOT here: the Cache Storage implementation
 * (Cache Storage API keyed by modelId+revision, exposed in the side panel
 * settings — current model, status, size, cache deletion, model switch)
 * belongs to ticket #51. This module must stay environment-free so the agent
 * package keeps running unchanged in Chrome and Node.
 */

import type { ModelManifest } from "./model-manifest.js";

/** One cached file body, alongside its manifest-declared path. */
export interface CachedModelFile {
  /** Manifest file path this body belongs to. */
  path: string;
  /** File content. */
  bytes: ArrayBuffer;
}

/** A fully cached model revision — manifest plus every file body. */
export interface CachedModel {
  manifest: ModelManifest;
  files: CachedModelFile[];
}

/** Summary of the current model, for the settings UI. */
export interface CurrentModelInfo {
  modelId: string;
  revision: string;
  sizeBytes: number;
}

/**
 * Cache management seam. `put` is only ever called with a COMPLETE, verified
 * file set — the download pipeline stages in memory and commits once, so a
 * failed download never leaves a partial cache entry behind.
 */
export interface ModelCacheStore {
  /** Returns the full cached revision, or undefined when incomplete/absent. */
  get(manifest: ModelManifest): Promise<CachedModel | undefined>;
  /** Commits a complete, verified file set for the manifest's revision. */
  put(manifest: ModelManifest, files: CachedModelFile[]): Promise<void>;
  /** Deletes the cached revision; no-op when absent. */
  remove(manifest: ModelManifest): Promise<void>;
  /** The current model (last put, still cached), or undefined when none. */
  current(): Promise<CurrentModelInfo | undefined>;
}

function cacheKey(manifest: ModelManifest): string {
  return `${manifest.modelId}@${manifest.revision}`;
}

/** In-memory ModelCacheStore — tests, the Node harness, and the #51 default. */
export class InMemoryModelCacheStore implements ModelCacheStore {
  private readonly entries = new Map<string, CachedModel>();
  private currentKey: string | undefined;

  async get(manifest: ModelManifest): Promise<CachedModel | undefined> {
    return this.entries.get(cacheKey(manifest));
  }

  async put(manifest: ModelManifest, files: CachedModelFile[]): Promise<void> {
    const key = cacheKey(manifest);
    this.entries.set(key, { manifest, files });
    this.currentKey = key;
  }

  async remove(manifest: ModelManifest): Promise<void> {
    const key = cacheKey(manifest);
    this.entries.delete(key);
    if (this.currentKey === key) {
      this.currentKey = undefined;
    }
  }

  async current(): Promise<CurrentModelInfo | undefined> {
    const entry = this.currentKey ? this.entries.get(this.currentKey) : undefined;
    if (!entry) {
      return undefined;
    }
    return {
      modelId: entry.manifest.modelId,
      revision: entry.manifest.revision,
      sizeBytes: entry.manifest.totalSizeBytes,
    };
  }
}
