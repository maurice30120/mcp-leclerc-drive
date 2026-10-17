import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL_ID,
  MODELS,
  findModel,
} from "../src/orchestrator/models.ts";

test("model catalogue keeps q4 as the stable default", () => {
  const entry = findModel(DEFAULT_MODEL_ID);
  assert.equal(entry.id, "onnx-community/Qwen3-0.6B-ONNX");
  assert.equal(entry.repoId, "onnx-community/Qwen3-0.6B-ONNX");
  assert.equal(entry.dtype, "q4");
  assert.equal(entry.promptFormat, "text");
  assert.equal(entry.supportsWasm, true);
});

test("q4f16 variant is WebGPU-only and reuses the stable Qwen3 0.6B repo", () => {
  const entry = findModel("onnx-community/Qwen3-0.6B-ONNX:q4f16-webgpu");
  assert.equal(entry.repoId, "onnx-community/Qwen3-0.6B-ONNX");
  assert.equal(entry.dtype, "q4f16");
  assert.equal(entry.promptFormat, "chat");
  assert.equal(entry.device, "webgpu");
  assert.equal(entry.supportsWasm, false);
});

test("catalogue ids are unique even when variants share a repo", () => {
  const ids = new Set(MODELS.map((entry) => entry.id));
  assert.equal(ids.size, MODELS.length);
});
