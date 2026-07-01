#!/usr/bin/env node
/**
 * Build the Chrome extension into dist/extension/.
 *
 * Outputs:
 *   dist/extension/manifest.json   (with {{EXTENSION_VERSION}} replaced)
 *   dist/extension/background.js    (MV3 service worker, IIFE)
 *   dist/extension/inject.js        (main-world script registering the tools)
 *   dist/extension/embed.js        (vendored webmcp-local-relay browser embed)
 *
 * Why not Vite: esbuild alone keeps the build a single small script with no
 * dev server config noise. The extension has no React/HMR needs.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "extension");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

mkdirSync(OUT, { recursive: true });

// manifest.json — substitute the version placeholder.
{
  const tpl = readFileSync(join(ROOT, "extension", "manifest.json"), "utf8");
  writeFileSync(
    join(OUT, "manifest.json"),
    tpl.replace("{{EXTENSION_VERSION}}", pkg.version),
  );
}

// bundle: inject.ts and background.ts as IIFE (no ESM in MV3 classic scripts).
await build({
  entryPoints: [join(ROOT, "extension", "inject.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  outfile: join(OUT, "inject.js"),
  // Inject.ts imports @mcp-b/global (which expects the webmcp-polyfill / sdk
  // to be available). esbuild bundles everything transitively.
  // chrome.* is a global — do not import it as a module.
  banner: { js: "/* mcp-leclerc-drive — Leclerc Drive WebMCP bridge (build) */" },
  logLevel: "info",
});

await build({
  entryPoints: [join(ROOT, "extension", "background.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  outfile: join(OUT, "background.js"),
  // chrome.* is a global; do not import it as a module.
  banner: { js: "/* mcp-leclerc-drive — extension service worker */" },
  logLevel: "info",
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
  writeFileSync(join(OUT, "embed.js"), embedSrc);
  console.log("vendored embed.js → " + join(OUT, "embed.js"));
}

console.log(`extension built → ${OUT}`);