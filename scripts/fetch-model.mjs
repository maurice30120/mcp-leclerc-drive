#!/usr/bin/env node
/**
 * Fetch ALL local orchestrator models (onnx-community Qwen3 ONNX family) for
 * the Chrome extension, into dist/extension/models/<baseDir>/.
 *
 * The catalogue mirrors `src/orchestrator/models.ts` (lightest → heaviest),
 * onnx-community/Qwen3-*-ONNX only (the huggingworld Qwen3.5 repos are
 * multimodal VL models with no compatible text-generation ONNX file and are
 * excluded):
 *   - onnx-community/Qwen3-0.6B-ONNX
 *   - onnx-community/Qwen3-0.6B-Instruct-ONNX
 *
 * `onnx-community/Qwen3-1.7B-ONNX` is deliberately excluded for now: q4f16
 * fails ONNX Runtime WASM session creation, and q4 can crash Chrome natively
 * on macOS during extension execution.
 *
 * For each model it downloads the standard Qwen file set at dtype `q4`:
 *   config.json, generation_config.json, tokenizer_config.json, tokenizer.json,
 *   vocab.json, merges.txt, special_tokens_map.json, added_tokens.json,
 *   onnx/model_q4.onnx
 *
 * The ONNX weight is mandatory; the auxiliary tokenizer files are best-effort
 * (a repo may ship only tokenizer.json without vocab.json/merges.txt,
 * which is fine — Transformers.js falls back to the single-file tokenizer).
 *
 * Verification:
 *   - exact byte size, via a HEAD request to the HF `resolve` endpoint
 *     (Content-Length). For LFS weights this is the real content size.
 *   - sha256 written into scripts/model-lock.json so future runs are
 *     reproducible + tamper-evident. For LFS weights the HF API exposes the
 *     content sha256 as `lfs.oid`; we fetch it and pin it when available.
 *
 * Downloads run in PARALLEL (concurrency-limited) with a clean, aligned
 * multi-bar progress display (cli-progress). Cache hits + auxiliary 404s are
 * resolved first (static log lines), then the live multi-bar renders every
 * active download so you can read them all at once — no more chaotic \r lines.
 *
 * Usage:
 *   node scripts/fetch-model.mjs            # fetch all models, dtype q4
 *   MCP_LECLERC_MODEL_DTYPE=q4 node scripts/fetch-model.mjs
 *   MCP_LECLERC_MODEL_FILTER=onnx-community/Qwen3-0.6B-Instruct-ONNX node scripts/fetch-model.mjs
 *   MCP_LECLERC_MODEL_CONCURRENCY=4 node scripts/fetch-model.mjs
 *
 * Large ONNX weights are NOT committed — only this script + the lock are.
 * The built artefact dist/extension/ packages every fetched model.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cliProgress from "cli-progress";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "scripts", "model-lock.json");
const OUT_ROOT = join(ROOT, "dist", "extension", "models");

const dtype = process.env.MCP_LECLERC_MODEL_DTYPE ?? "q4";
// Optional: only fetch models whose id matches this substring (debug/CI).
const FILTER = process.env.MCP_LECLERC_MODEL_FILTER ?? "";
// How many files may download at once (large ONNX weights are multi-GB, so we
// keep this modest to avoid saturating bandwidth / tripping HF rate limits).
const CONCURRENCY = Math.max(1, Number(process.env.MCP_LECLERC_MODEL_CONCURRENCY ?? 4));
// Files at least this large get their own bar in the multi-bar display.
const BIG = 1024 * 1024;

// Catalogue — keep in sync with src/orchestrator/models.ts.
// onnx-community/Qwen3-4B-ONNX was considered but is excluded — its repo
// historically shipped only a stub weight (no real weights, restructured for
// ORT GenAI), so it is not part of the catalogue.
const MODELS = [
  { id: "onnx-community/Qwen3-0.6B-ONNX", baseDir: "onnx-community/Qwen3-0.6B-ONNX" },
  { id: "onnx-community/Qwen3-0.6B-Instruct-ONNX", baseDir: "onnx-community/Qwen3-0.6B-Instruct-ONNX" },
];

const REVISION = "main";

// Standard Qwen3 ONNX file set. The weight file is dtype-specific.
const TEXT_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "vocab.json",
  "merges.txt",
  "special_tokens_map.json",
  "added_tokens.json",
];

const selected = FILTER
  ? MODELS.filter((m) => m.id.includes(FILTER))
  : MODELS;

if (selected.length === 0) {
  console.error(`No models match filter "${FILTER}".`);
  process.exit(1);
}

const lockExists = existsSync(LOCK);
const lock = lockExists ? JSON.parse(readFileSync(LOCK, "utf8")) : { dtype, models: {} };
if (!lock.models) lock.models = {};

// Per-(repo,dir) tree cache so we don't re-fetch the tree API for every file
// in the same directory.
const treeCache = new Map();

function resolveUrl(repo, path) {
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(REVISION)}/${path}`;
}

/** Fetch the LFS content sha256 (lfs.oid) for a weight file, if available. */
async function treeNodes(repo, dir) {
  const key = `${repo}:${dir}`;
  if (treeCache.has(key)) return treeCache.get(key);
  let nodes = new Map();
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${repo}/tree/${encodeURIComponent(REVISION)}?path=${encodeURIComponent(
        dir,
      )}&recursive=true`,
    );
    if (res.ok) {
      const tree = await res.json();
      nodes = new Map(tree.map((n) => [n.path, n]));
    }
  } catch {
    /* leave empty */
  }
  treeCache.set(key, nodes);
  return nodes;
}

async function lfsSha256(repo, path) {
  const nodes = await treeNodes(repo, dirname(path));
  const node = nodes.get(path);
  return node?.lfs?.oid ?? null;
}

/** Best-effort expected size: prefer the tree API `size`, then HEAD content-length. */
async function expectedSize(repo, path) {
  const nodes = await treeNodes(repo, dirname(path));
  const node = nodes.get(path);
  if (node) {
    const s = node.lfs?.size ?? node.size;
    if (Number.isFinite(s) && s > 0) return s;
  }
  try {
    const res = await fetch(resolveUrl(repo, path), { method: "HEAD", redirect: "follow" });
    if (res.ok) {
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > 0) return len;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function sha256File(p) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("error", rej);
    s.on("data", (d) => h.update(d));
    s.on("end", () => res(h.digest("hex")));
  });
}

/** Pretty-prints a human byte size (MiB / GiB). */
function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

/** Fixed-width label so the multi-bar stays aligned ("carré"). */
function makeLabel(id, path) {
  const short = id.split("/").pop();
  const label = `${short} ${path}`;
  return label.length > 40 ? label.slice(0, 37) + "…" : label.padEnd(40);
}

/**
 * Stream `res.body` to `dest`, updating `bar` (a cli-progress bar) as bytes
 * arrive. `basePayload` carries the fixed tokens (label, totalH) that must be
 * re-supplied on every update — cli-progress *replaces* (not merges) the bar
 * payload, so tokens set only at create() would otherwise render literally.
 * Returns the number of bytes written.
 */
async function downloadWithBar(res, dest, bar, basePayload = {}) {
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  const start = Date.now();
  let lastTick = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((r, rej) =>
        file.write(value, (e) => (e ? rej(e) : r())),
      );
      received += value.length;
      const now = Date.now();
      if (now - lastTick >= 200 || done) {
        lastTick = now;
        const elapsed = (now - start) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        bar.update(received, {
          ...basePayload,
          valueH: fmtBytes(received),
          speedH: `${fmtBytes(speed)}/s`,
        });
      }
    }
  } finally {
    await new Promise((r) => file.end(r));
  }
  return received;
}

/** Simple bounded concurrency pool. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Phase 1 — resolve metadata + cache hits (sequential, plain log lines).
// ---------------------------------------------------------------------------
const toDownload = []; // tasks that still need fetching
let totalFiles = 0;

for (const model of selected) {
  const { id, baseDir } = model;
  const weightFile = `onnx/model_${dtype}.onnx`;
  const files = [...TEXT_FILES, weightFile];
  console.log(`\n=== ${id} (dtype=${dtype}, ${files.length} files) ===`);
  const modelLock = lock.models[id] ?? { baseDir, files: {} };
  modelLock.baseDir = baseDir;
  lock.models[id] = modelLock;

  for (const path of files) {
    const destRel = `${baseDir}/${path}`;
    const dest = join(OUT_ROOT, destRel);
    const url = resolveUrl(id, path);
    mkdirSync(dirname(dest), { recursive: true });

    let expSize = null;
    try {
      expSize = await expectedSize(id, path);
    } catch (err) {
      console.warn(`  ! ${path}: ${(err instanceof Error ? err.message : err)} (will verify by sha)`);
    }

    const expectedSha =
      path === weightFile ? await lfsSha256(id, path) : (modelLock.files[path]?.sha256 ?? null);
    const prevSha = modelLock.files[path]?.sha256 ?? expectedSha ?? null;

    // Cache hit? (size match when known, else sha match).
    if (existsSync(dest) && (expSize == null || statSync(dest).size === expSize)) {
      if (prevSha) {
        const got = await sha256File(dest);
        if (got === prevSha) {
          console.log(`  ok (cached)  ${path}  ${expSize ?? "?"}B  sha=${got.slice(0, 12)}…`);
          modelLock.files[path] = { size: statSync(dest).size, sha256: got };
          totalFiles++;
          continue;
        }
        console.warn(`  hash mismatch on cache for ${path}, re-downloading…`);
      } else if (expSize != null && statSync(dest).size === expSize) {
        const got = await sha256File(dest);
        modelLock.files[path] = { size: expSize, sha256: got };
        console.log(`  ok (cached)  ${path}  ${expSize}B  sha=${got.slice(0, 12)}…`);
        totalFiles++;
        continue;
      }
    }

    toDownload.push({ model, id, baseDir, path, weightFile: path === weightFile, dest, url, expSize, expectedSha, modelLock });
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — parallel downloads with a clean multi-bar display.
// ---------------------------------------------------------------------------
let failures = 0;
const deferred = []; // result lines printed after the multi-bar is torn down

if (toDownload.length > 0) {
  const isTTY = process.stdout.isTTY;
  const bigTasks = toDownload.filter((t) => t.expSize != null && t.expSize >= BIG);
  const useMultibar = isTTY && bigTasks.length > 0;

  const multibar = useMultibar
    ? new cliProgress.MultiBar({
        format: " {label} |{bar}| {percentage}% | {valueH}/{totalH} | {speedH}",
        barCompleteChar: "\u2588",
        barIncompleteChar: "\u2591",
        barWidth: 24,
        hideCursor: true,
        clearOnComplete: false,
        forceRedraw: true,
        emptyOnZero: true,
      })
    : null;

  await pool(toDownload, CONCURRENCY, async (task) => {
    const { id, path, weightFile, dest, url, expSize, expectedSha, modelLock } = task;
    const big = useMultibar && expSize != null && expSize >= BIG;
    const label = makeLabel(id, path);

    const basePayload = { label, totalH: expSize != null ? fmtBytes(expSize) : "?" };

    let bar = null;
    if (big) {
      bar = multibar.create(expSize, 0, {
        ...basePayload,
        valueH: "0 B",
        speedH: "0 B/s",
      });
    } else if (!isTTY) {
      // Plain start line for CI / non-interactive logs.
      console.log(`  fetch  ${path}  ${expSize ? fmtBytes(expSize) : "?"}  ← ${url}`);
    }

    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        // Auxiliary tokenizer files are best-effort: a 404 on vocab.json /
        // merges.txt / added_tokens.json / special_tokens_map.json is fine
        // (some repos ship a self-contained tokenizer.json). Only the ONNX
        // weight + config.json + tokenizer.json are truly required.
        if (!weightFile && res.status === 404) {
          if (bar) bar.stop();
          deferred.push(`  - skip (404, auxiliary)  ${path}`);
          return;
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (bar) {
        await downloadWithBar(res, dest, bar, basePayload);
      } else {
        // No bar (tiny file, or non-TTY) — drive the same downloader with a
        // no-op bar so we still stream to disk correctly.
        await downloadWithBar(res, dest, { update() {} }, basePayload);
      }
    } catch (err) {
      if (bar) bar.stop();
      deferred.push(`  ✗ download failed: ${path}: ${(err instanceof Error ? err.message : err)}`);
      failures++;
      return;
    }

    if (bar) bar.update(expSize, { ...basePayload, valueH: fmtBytes(expSize), speedH: "done" });

    const size = statSync(dest).size;
    if (expSize != null && size !== expSize) {
      if (bar) bar.stop();
      deferred.push(`  ✗ size mismatch: ${path}: got ${size}, expected ${expSize}`);
      failures++;
      return;
    }

    const got = await sha256File(dest);
    if (expectedSha && got !== expectedSha) {
      if (bar) bar.stop();
      deferred.push(`  ✗ sha256 mismatch: ${path}: got ${got}, expected ${expectedSha}`);
      failures++;
      return;
    }
    deferred.push(`  ✓ ${path}  ${size}B  sha=${got.slice(0, 12)}…`);
    modelLock.files[path] = { size, sha256: got };
    totalFiles++;
  });

  if (multibar) multibar.stop();

  // Print all deferred result lines now that the live bars are gone, so the
  // output stays clean and aligned.
  for (const line of deferred) console.log(line);
}

// ---------------------------------------------------------------------------
// Phase 3 — write lock + summary.
// ---------------------------------------------------------------------------
if (failures > 0) {
  // Still write a partial lock so cached files aren't re-fetched.
  lock.dtype = dtype;
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.error(`\n${failures} file(s) failed. Partial lock written → ${LOCK}`);
  process.exit(1);
}

lock.dtype = dtype;
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
console.log(`\nlock written → ${LOCK} (${totalFiles} files across ${selected.length} model(s), dtype=${dtype})`);
console.log(`models ready → ${OUT_ROOT}`);
