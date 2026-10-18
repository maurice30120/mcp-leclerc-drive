/**
 * Opt-in, verifiable model download pipeline (spec issue #40, ticket #52).
 *
 * Given a validated manifest, this module fetches every declared file from
 * `sourceUrl + path`, verifies each one against the manifest (exact byte size,
 * sha256 digest when declared) and commits the file set to the ModelCacheStore
 * in ONE atomic `put` — files are staged in memory, so any failure (consent
 * refused, abort, transport error, verification error) leaves the cache
 * untouched: no partial entry, no half-downloaded model.
 *
 * Consent is EXPLICIT and non-negotiable: nothing is fetched until the caller
 * injected `consent` callback resolves true. A cache hit short-circuits
 * before consent because it downloads nothing — offline execution while the
 * cache holds every file is the whole point; the local provider adapter
 * (#49/#51) reads files from the cache and never touches the network.
 *
 * PURITY: the agent package has no global `fetch` reference and no Node or
 * Chrome APIs. The transport (`fetchImpl`) and the digester (`hashBytes`)
 * are injected by the caller — global fetch in Node, the extension's
 * network stack + crypto.subtle.digest in Chrome.
 */

import type { ModelCacheStore, CachedModelFile } from "./cache-store.js";
import { verifyManifestFile, type ModelManifest } from "./model-manifest.js";

/** Minimal response shape the injected transport must provide. */
export interface DownloadFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DownloadFetchInit {
  /** Cooperative cancellation, forwarded to the transport. */
  signal?: AbortSignal;
}

/** Injectable fetch seam — no global fetch reference at module scope. */
export type FetchLike = (url: string, init: DownloadFetchInit) => Promise<DownloadFetchResponse>;

/** Injectable sha256 seam — Chrome uses crypto.subtle, Node uses node:crypto. */
export type HashBytes = (bytes: ArrayBuffer) => Promise<string>;

/** Progress event: per-file bytes plus cumulative totals for the settings UI. */
export interface ModelDownloadProgress {
  modelId: string;
  /** Manifest path of the file just completed. */
  file: string;
  /** Bytes received for this file. */
  fileBytes: number;
  /** Manifest-declared size of this file. */
  fileSizeBytes: number;
  /** Cumulative verified bytes across completed files. */
  totalBytes: number;
  /** Manifest-declared total size. */
  totalSizeBytes: number;
}

export type DownloadFailureCode =
  | "CONSENT_REFUSED"
  | "ABORTED"
  | "FETCH_FAILED"
  | "VERIFY_FAILED";

export type ModelDownloadResult =
  | { ok: true; fromCache: boolean; files: CachedModelFile[] }
  | {
      ok: false;
      code: DownloadFailureCode;
      /** Human-readable French diagnostic. */
      message: string;
      /** Manifest path of the file that failed, when one was in flight. */
      file?: string;
    };

export interface DownloadModelOptions {
  manifest: ModelManifest;
  /** Network transport — injected, never the global fetch. */
  fetchImpl: FetchLike;
  /** Explicit consent gate — must resolve true before ANY byte is fetched. */
  consent: () => boolean | Promise<boolean>;
  /** Cache seam — committed exactly once, only on full success. */
  cache: ModelCacheStore;
  /** Visible progress, one event per verified file. */
  onProgress?: (progress: ModelDownloadProgress) => void;
  /** Cancellation: checked before each file and forwarded to the transport. */
  signal?: AbortSignal;
  /** Digest function — REQUIRED when any manifest file declares a sha256. */
  hashBytes?: HashBytes;
}

function fileUrl(manifest: ModelManifest, path: string): string {
  const base = manifest.sourceUrl.endsWith("/") ? manifest.sourceUrl : `${manifest.sourceUrl}/`;
  return `${base}${path}`;
}

function failure(
  code: DownloadFailureCode,
  message: string,
  file?: string,
): Extract<ModelDownloadResult, { ok: false }> {
  return file === undefined ? { ok: false, code, message } : { ok: false, code, message, file };
}

/**
 * Downloads a model revision into the cache, or returns the cached revision
 * when it is already complete (fully offline). Never starts without consent,
 * never commits a partial file set.
 */
export async function downloadModel(options: DownloadModelOptions): Promise<ModelDownloadResult> {
  const { manifest, fetchImpl, consent, cache, onProgress, signal, hashBytes } = options;

  // A complete cache hit means offline execution: no fetch, no consent needed.
  const cached = await cache.get(manifest);
  if (cached) {
    return { ok: true, fromCache: true, files: cached.files };
  }

  const needsDigest = manifest.files.some((file) => file.sha256 !== undefined);
  if (needsDigest && !hashBytes) {
    return failure(
      "VERIFY_FAILED",
      "Le manifeste déclare des sommes de contrôle mais aucune fonction de hachage n'est fournie.",
    );
  }

  const granted = await consent();
  if (!granted) {
    return failure(
      "CONSENT_REFUSED",
      "Téléchargement refusé : le consentement explicite est requis avant tout téléchargement du modèle local.",
    );
  }

  if (signal?.aborted) {
    return failure("ABORTED", "Téléchargement annulé avant de démarrer.");
  }

  const staged: CachedModelFile[] = [];
  let totalBytes = 0;

  for (const declared of manifest.files) {
    if (signal?.aborted) {
      return failure(
        "ABORTED",
        `Téléchargement annulé (${totalBytes}/${manifest.totalSizeBytes} octets déjà récupérés).`,
      );
    }

    const url = fileUrl(manifest, declared.path);
    let bytes: ArrayBuffer;
    try {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) {
        return failure(
          "FETCH_FAILED",
          `Échec du téléchargement de "${declared.path}" (HTTP ${response.status}).`,
          declared.path,
        );
      }
      bytes = await response.arrayBuffer();
    } catch (error) {
      if (signal?.aborted) {
        return failure(
          "ABORTED",
          `Téléchargement annulé (${totalBytes}/${manifest.totalSizeBytes} octets déjà récupérés).`,
          declared.path,
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      return failure(
        "FETCH_FAILED",
        `Échec réseau pendant le téléchargement de "${declared.path}" : ${detail}`,
        declared.path,
      );
    }

    const digest = declared.sha256 !== undefined && hashBytes ? await hashBytes(bytes) : undefined;
    const verification = verifyManifestFile(manifest, declared.path, bytes.byteLength, digest);
    if (!verification.ok) {
      return failure(
        "VERIFY_FAILED",
        `Vérification échouée pour "${declared.path}" : ${verification.issues.join(" ; ")}`,
        declared.path,
      );
    }

    staged.push({ path: declared.path, bytes });
    totalBytes += declared.sizeBytes;
    onProgress?.({
      modelId: manifest.modelId,
      file: declared.path,
      fileBytes: declared.sizeBytes,
      fileSizeBytes: declared.sizeBytes,
      totalBytes,
      totalSizeBytes: manifest.totalSizeBytes,
    });
  }

  // Atomic commit: only a complete, fully verified file set reaches the cache.
  await cache.put(manifest, staged);
  return { ok: true, fromCache: false, files: staged };
}
