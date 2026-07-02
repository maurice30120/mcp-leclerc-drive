#!/usr/bin/env node
/**
 * Build the Chrome extension into dist/extension/.
 *
 * Outputs:
 *   dist/extension/manifest.json        (with {{EXTENSION_VERSION}} replaced)
 *   dist/extension/background.js         (MV3 service worker, IIFE)
 *   dist/extension/inject.js             (main-world script registering the tools)
 *   dist/extension/embed.js              (vendored webmcp-local-relay browser embed)
 *   dist/extension/content-relay.js      (isolated-world postMessage relay)
 *   dist/extension/offscreen/offscreen.{html,js}  (local Transformers.js model runtime)
 *   dist/extension/popup/popup.{html,css,js}      (shopping-list orchestrator UI)
 *   dist/extension/ort-wasm/*            (onnxruntime-web wasm binaries, vendored)
 *   dist/extension/models/**             (ONNX model artefacts, if fetched)
 *
 * Why not Vite: esbuild alone keeps the build a single small script with no
 * dev server config noise. The extension has no React/HMR needs.
 */
import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "extension");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "popup"), { recursive: true });
mkdirSync(join(OUT, "offscreen"), { recursive: true });

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied → ${dest}`);
}

// manifest.json — substitute the version placeholder.
{
  const tpl = readFileSync(join(ROOT, "extension", "manifest.json"), "utf8");
  writeFileSync(
    join(OUT, "manifest.json"),
    tpl.replace("{{EXTENSION_VERSION}}", pkg.version),
  );
}

// Static extension pages assets.
copyFile(join(ROOT, "extension", "popup", "popup.html"), join(OUT, "popup", "popup.html"));
copyFile(join(ROOT, "extension", "popup", "popup.css"), join(OUT, "popup", "popup.css"));
copyFile(join(ROOT, "extension", "offscreen", "offscreen.html"), join(OUT, "offscreen", "offscreen.html"));

// Common esbuild options for the isolated/extension contexts (no MAIN-world
// chrome.* globals here either; chrome.* stays a global).
const baseOpts = {
  bundle: true,
  target: "es2022",
  platform: "browser",
  logLevel: "info",
};

// bundle: inject.ts and background.ts as IIFE (no ESM in MV3 classic scripts).
await build({
  ...baseOpts,
  entryPoints: [join(ROOT, "extension", "inject.ts")],
  format: "iife",
  outfile: join(OUT, "inject.js"),
  // Inject.ts imports @mcp-b/global (which expects the webmcp-polyfill / sdk
  // to be available). esbuild bundles everything transitively.
  // chrome.* is a global — do not import it as a module.
  banner: { js: "/* mcp-leclerc-drive — Leclerc Drive WebMCP bridge (build) */" },
});

await build({
  ...baseOpts,
  entryPoints: [join(ROOT, "extension", "background.ts")],
  format: "iife",
  outfile: join(OUT, "background.js"),
  banner: { js: "/* mcp-leclerc-drive — extension service worker */" },
});

// content-relay.ts — isolated world content script (IIFE, no ESM in content
// scripts injected via chrome.scripting with files).
await build({
  ...baseOpts,
  entryPoints: [join(ROOT, "extension", "content-relay.ts")],
  format: "iife",
  outfile: join(OUT, "content-relay.js"),
  banner: { js: "/* mcp-leclerc-drive — isolated-world content relay */" },
});

// offscreen.ts — bundles @huggingface/transformers + onnxruntime-web. ESM is
// fine here (the offscreen document loads it as <script type=module>).
await build({
  ...baseOpts,
  entryPoints: [join(ROOT, "extension", "offscreen", "offscreen.ts")],
  format: "esm",
  outfile: join(OUT, "offscreen", "offscreen.js"),
  // onnxruntime-web references .wasm/.mjs assets at runtime via wasmPaths set
  // in offscreen.ts; keep them external (don't try to inline binaries).
  external: [],
  banner: { js: "/* mcp-leclerc-drive — offscreen Transformers.js runtime */" },
});

// popup.ts — popup UI controller (ESM module loaded by popup.html).
await build({
  ...baseOpts,
  entryPoints: [join(ROOT, "extension", "popup", "popup.ts")],
  format: "esm",
  outfile: join(OUT, "popup", "popup.js"),
  banner: { js: "/* mcp-leclerc-drive — popup orchestrator UI */" },
});

// embed.js — vendor the webmcp-local-relay browser bundle so it works offline
// and never depends on a CDN at runtime (Leclerc pages don't either).
// The package's `exports` map does not expose the browser subpath, so we
// resolve the package root and read the file directly.
{
  let embedSrc;
  try {
    // The package `exports` map doesn't expose the browser subpath or
    // ./package.json, so resolve the main entry and walk up to the package root.
    const mainPath = require.resolve("@mcp-b/webmcp-local-relay", { paths: [ROOT] });
    const pkgRoot = resolve(dirname(mainPath), "..");
    const embedPath = join(pkgRoot, "dist", "browser", "embed.js");
    embedSrc = readFileSync(embedPath, "utf8");
  } catch (err) {
    throw new Error(
      "Cannot find @mcp-b/webmcp-local-relay/dist/browser/embed.js (" +
        (err instanceof Error ? err.message : String(err)) +
        "). Run `npm install @mcp-b/webmcp-local-relay` (dev) before building.",
    );
  }
  // The upstream bundle still reads `navigator.modelContext`, which the
  // @mcp-b/webmcp-polyfill flags as deprecated per the May 27, 2026 WebMCP
  // draft (modelContext moved from Navigator to Document). Prefer the
  // canonical `document.modelContext` first so we don't trip the warning.
  // Only rewrite the bare `navigator.modelContext` accesses, NOT
  // `navigator.modelContextTesting` (that surface is unchanged).
  embedSrc = embedSrc.replace(
    /navigator\.modelContext(?!Testing)/g,
    "document.modelContext??navigator.modelContext",
  );
  writeFileSync(join(OUT, "embed.js"), embedSrc);
  console.log("vendored embed.js → " + join(OUT, "embed.js"));
}

// onnxruntime-web wasm + proxy .mjs binaries → dist/extension/ort-wasm/.
// Transformers.js (via ORT) fetches these at runtime from wasmPaths set in
// offscreen.ts. Without them, the model cannot run in the extension.
{
  const ortDist = dirname(require.resolve("onnxruntime-web"));
  const ortOut = join(OUT, "ort-wasm");
  mkdirSync(ortOut, { recursive: true });
  let copied = 0;
  for (const f of readdirSync(ortDist)) {
    // Only the wasm + proxy module files ORT loads dynamically. Skip the full
    // bundles (ort.all.*, ort.bundle.*, ort.jspi.*, ort.wasm.*, ort.min.*)
    // which esbuild already inlined into offscreen.js.
    if (/^ort-wasm-simd-threaded(\..*)?\.(wasm|mjs)$/.test(f)) {
      copyFileSync(join(ortDist, f), join(ortOut, f));
      copied++;
    }
  }
  if (copied === 0) {
    throw new Error(
      "No onnxruntime-web wasm binaries found under " + ortDist +
        ". Run `npm install` (which pulls onnxruntime-web via @huggingface/transformers).",
    );
  }
  console.log(`vendored ${copied} ort-wasm files → ${ortOut}`);
}

// Model artefacts → dist/extension/models/. The build ensures every model in
// the catalogue (src/orchestrator/models.ts) is present; if any is missing it
// shells out to scripts/fetch-model.mjs to download them, then verifies.
{
  // Catalogue mirrors src/orchestrator/models.ts (onnx-community Qwen3 only;
  // the huggingworld Qwen3.5 repos and the stub onnx-community 4B repo are
  // excluded).
  const CATALOGUE = [
    { id: "onnx-community/Qwen3-0.6B-ONNX", baseDir: "onnx-community/Qwen3-0.6B-ONNX" },
    { id: "onnx-community/Qwen3-0.6B-Instruct-ONNX", baseDir: "onnx-community/Qwen3-0.6B-Instruct-ONNX" },
    { id: "onnx-community/Qwen3-1.7B-ONNX", baseDir: "onnx-community/Qwen3-1.7B-ONNX" },
  ];
  const dtype = "q4";
  // Only the truly required files: the weight, the model config, and the
  // self-contained tokenizer. Other tokenizer files (vocab.json, merges.txt,
  // special_tokens_map.json, added_tokens.json, generation_config.json,
  // tokenizer_config.json) are best-effort and may be absent on some repos.
  const required = [
    "config.json",
    "tokenizer.json",
    `onnx/model_${dtype}.onnx`,
  ];
  const modelsSrc = join(OUT, "models");
  const missing = [];
  for (const m of CATALOGUE) {
    for (const f of required) {
      if (!existsSync(join(modelsSrc, m.baseDir, f))) {
        missing.push(`${m.baseDir}/${f}`);
      }
    }
  }
  if (missing.length > 0) {
    console.log(
      `models: ${missing.length} file(s) missing under dist/extension/models/ — ` +
        `running fetch-model…`,
    );
    // Delegate to the fetch script (same node). Blocks the build until done.
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "fetch-model.mjs")], {
      stdio: "inherit",
    });
    if (r.status !== 0) {
      throw new Error(
        `fetch-model failed (exit ${r.status}). Fix the errors above and re-run ` +
          "`npm run build:extension`.",
      );
    }
    // Re-check in case the fetch silently skipped something.
    const stillMissing = missing.filter((p) => !existsSync(join(modelsSrc, p)));
    if (stillMissing.length > 0) {
      console.warn(
        `⚠  still missing after fetch: ${stillMissing.length} file(s). The ` +
          "popup will fail to load those models until fetched.",
      );
    } else {
      console.log(`models present → ${modelsSrc} (all catalogue models fetched)`);
    }
  } else {
    console.log(`models present → ${modelsSrc} (all catalogue models present)`);
  }
}

console.log(`extension built → ${OUT}`);
