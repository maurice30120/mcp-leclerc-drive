/**
 * Versioned local-model manifest for the side panel download path (ticket #51,
 * wired on the #52 pipeline). This is the TRUST ANCHOR of the runtime download:
 * every file is fetched only from sourceUrl + path and verified against the
 * declared byte size and sha256 (the Hugging Face LFS content digests).
 *
 * The file list mirrors scripts/model-files.json (the reference layout of
 * onnx-community/Qwen3-0.6B-ONNX, dtype q4, revision main) — the same
 * revision the extension build fetches into dist/extension/models/. The
 * manifest is validated by @leclerc/agent validateModelManifest (unit-tested
 * in tests/sidepanel-protocol.test.ts); a manifest with an unknown format
 * version is rejected, never guessed.
 *
 * Downloading is EXPLICIT: the side panel only fetches after the user's
 * model_download_consent, and a complete cache hit short-circuits (fully
 * offline). The bundled artifacts (dist/extension/models) remain the
 * preferred offline path for the offscreen runtime.
 */

import type { ModelManifest } from "@leclerc/agent";

export const LOCAL_MODEL_MANIFEST: ModelManifest = {
  // Pinned schema version of @leclerc/agent MANIFEST_FORMAT_VERSION.
  formatVersion: 1,
  modelId: "onnx-community/Qwen3-0.6B-ONNX",
  revision: "main",
  tokenizer: "tokenizer.json",
  files: [
    {
      path: "config.json",
      sizeBytes: 912,
      sha256: "8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e",
    },
    {
      path: "generation_config.json",
      sizeBytes: 219,
      sha256: "9e9e031ae8bca36eefcdcdd0b35d83c61baa01e31d68d5f5a961c9ca1a4b95bf",
    },
    {
      path: "tokenizer_config.json",
      sizeBytes: 9705,
      sha256: "b0a8115cf05a7002cbe2575058c0139c1dee3f06f221c05717c3444947d78b9f",
    },
    {
      path: "tokenizer.json",
      sizeBytes: 9117040,
      sha256: "e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5",
    },
    {
      path: "vocab.json",
      sizeBytes: 2776833,
      sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    },
    {
      path: "merges.txt",
      sizeBytes: 1671853,
      sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
    },
    {
      path: "special_tokens_map.json",
      sizeBytes: 613,
      sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
    },
    {
      path: "added_tokens.json",
      sizeBytes: 707,
      sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680",
    },
    {
      path: "onnx/model_q4.onnx",
      sizeBytes: 919096585,
      sha256: "d43d836fc5e240df9013733ccd214972c5d21bd9ec47e574e4f1e359cf90aed0",
    },
  ],
  totalSizeBytes: 932674467,
  dtype: "q4",
  format: "onnx",
  trainingProvenance: {
    baseModel: "Qwen/Qwen3-0.6B",
  },
  license: "apache-2.0",
  sourceUrl: "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main",
};
