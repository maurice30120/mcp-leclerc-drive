/**
 * Model inference tests — runs the *real* local Qwen3 model (the same
 * `@huggingface/transformers` text-generation pipeline the extension's
 * offscreen runtime uses) and checks that, for each explicit shopping-list
 * request in `tests/shopping-lists.ts`, the parsed `Plan` contains the
 * products the user actually wrote.
 *
 * This is an inference smoke test, not a parser unit test: `parsePlan` is
 * already exhaustively tested in `orchestrator-plan.test.ts`. Here we only
 * care about the model contract: normalize explicit grocery items, and refuse
 * recipe/dish-only prompts with a clarification question.
 *
 * The goal is NOT to make every assertion pass on the first run: it is to
 * surface where the local model drifts back into recipe generation or fails to
 * preserve explicit list entries. A failing `mandatory` assertion means the
 * model dropped an item the user wrote; a failing `forbidden` assertion means
 * it hallucinated an item not present in the input.
 *
 * Skip behaviour: the whole suite is skipped automatically when the bundled
 * model is not present locally (so `npm test` stays green on machines that
 * have not run `npm run fetch:model`). Force-run with
 * `MCP_LECLERC_RUN_INFERENCE=1 node --test tests/model-inference.test.ts`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMessages, buildPrompt } from "../src/orchestrator/prompt.ts";
import { parsePlan, type Plan, type PlanItem } from "../src/orchestrator/plan.ts";
import { MAX_NEW_TOKENS, MODELS, type ModelEntry } from "../src/orchestrator/models.ts";
import { SHOPPING_LISTS } from "./shopping-lists.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Models are fetched under dist/extension/models/<org>/<repo>/... for both
// the onnx-community family, so the root is the org-agnostic
// models directory.
const MODELS_ROOT = join(ROOT, "dist", "extension", "models");

/**
 * Enumerate every locally-present Qwen3 model (lightest → heaviest),
 * each with its own describe block so we can compare inference quality across
 * the family. Override with `MCP_LECLERC_MODEL_ID` (comma-separated) to restrict.
 *
 * Walks all org directories under the models root (onnx-community, …)
 * so the family is covered.
 */
function resolveModelVariants(): ModelEntry[] {
  const override = process.env.MCP_LECLERC_MODEL_ID;
  const allow = override
    ? override.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const found: ModelEntry[] = [];
  if (existsSync(MODELS_ROOT)) {
    for (const entry of MODELS) {
      // The Node smoke test runs through the CPU/WASM backend. WebGPU-only
      // variants are covered manually from the extension popup.
      if (!entry.supportsWasm) continue;
      const modelDir = join(MODELS_ROOT, entry.repoId);
      const weight = join(modelDir, "onnx", `model_${entry.dtype}.onnx`);
      if (existsSync(weight) && statSync(weight).size > 0) {
        if (!allow || allow.includes(entry.id) || allow.includes(entry.repoId)) {
          found.push(entry);
        }
      }
    }
  }
  // Deterministic order: by parameter count inferred from the folder name,
  // then alphabetically to break ties (e.g. the two 0.6B models).
  found.sort((a, b) => a.paramsB - b.paramsB || a.id.localeCompare(b.id));
  return found;
}

const MODEL_VARIANTS = resolveModelVariants();
const FORCE = process.env.MCP_LECLERC_RUN_INFERENCE === "1";
// The inference suite is opt-in: it loads a multi-hundred-MB model and runs
// generation per list, which is far too heavy for the default `npm test`.
// Enable with `MCP_LECLERC_RUN_INFERENCE=1` (or `npm run test:inference`).
const SHOULD_RUN = FORCE;

// ---- accent/case-insensitive query matching -------------------------------

function normalize(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[''`]/g, "'")
    .replace(/\s+/g, " ");
}

/** True if any plan query contains any of the given fragments (loosely). */
function planHasAny(plan: { items: PlanItem[] }, fragments: string[]): boolean {
  const queries = plan.items.map((it) => normalize(it.query));
  return fragments.some((f) => queries.some((q) => q.includes(normalize(f))));
}

function findItem(plan: { items: PlanItem[] }, fragments: string[]): PlanItem | undefined {
  return plan.items.find((it) =>
    fragments.some((f) => normalize(it.query).includes(normalize(f))),
  );
}

function describeItem(item: PlanItem): string {
  const parts = [item.query, `x${item.quantity}`];
  if (item.constraints) parts.push(`(${item.constraints})`);
  if (item.notes) parts.push(`— ${item.notes}`);
  return parts.join(" ");
}

// ---- pipeline loader (lazy, shared across the describe block) --------------

type Generator = (messages: unknown, opts?: unknown) => Promise<unknown>;

// One cached pipeline per model id (each is a separate ONNX session).
const generators = new Map<string, Promise<Generator>>();

async function getGenerator(model: ModelEntry): Promise<Generator> {
  let p = generators.get(model.id);
  if (!p) {
    p = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      // Point Transformers.js at the local model root: it resolves
      // `<root>/<org>/<repo>/config.json` etc. The full model id (including
      // the org prefix) is passed straight through — both onnx-community and
      // other repos live under this root as <org>/<repo>.
      env.localModelPath = MODELS_ROOT + "/";
      const gen = await pipeline("text-generation", model.repoId, {
        dtype: model.dtype,
        device: "cpu",
      });
      return gen as unknown as Generator;
    })();
    generators.set(model.id, p);
  }
  return p;
}

function extractGeneratedText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const gen = (first as { generated_text?: unknown }).generated_text;
      if (typeof gen === "string") return gen;
      if (Array.isArray(gen)) {
        const last = gen[gen.length - 1] as { content?: unknown } | undefined;
        if (last && typeof last.content === "string") return last.content;
      }
    }
  }
  return String(output);
}

async function inferPlan(
  model: ModelEntry,
  request: string,
): Promise<{ plan: Plan; raw: string }> {
  const generator = await getGenerator(model);
  const prompt = model.promptFormat === "chat" ? buildMessages(request) : buildPrompt(request);
  const output = await generator(prompt, {
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
    return_full_text: false,
    tokenizer_encode_kwargs: { enable_thinking: false },
  });
  const raw = extractGeneratedText(output);
  const parsed = parsePlan(raw);
  if (!parsed.ok) {
    throw new Error(`parsePlan failed for "${request}" (${model.id}): ${parsed.error}\nraw output:\n${raw}`);
  }
  return { plan: parsed.plan, raw };
}

// ---- the suite ------------------------------------------------------------

function runSuiteForModel(model: ModelEntry) {
  test(`loaded model = ${model.id} (${model.repoId}, dtype ${model.dtype})`, async () => {
    const generator = await getGenerator(model);
    assert.ok(typeof generator === "function");
  });

  for (const fixture of SHOPPING_LISTS) {
    test(fixture.id + ": normalizes explicit shopping list contract", async (t) => {
      const { plan, raw } = await inferPlan(model, fixture.request);
      t.diagnostic(`model: ${model.id} (${model.repoId}, dtype ${model.dtype}, prompt ${model.promptFormat})`);
      t.diagnostic(`request: ${fixture.request}`);
      t.diagnostic(`plan:\n - ${plan.items.map(describeItem).join("\n - ")}`);
      if (plan.questions?.length) t.diagnostic(`questions:\n - ${plan.questions.join("\n - ")}`);
      t.diagnostic(`raw:\n${raw}`);

      if (fixture.expectClarification) {
        assert.equal(
          plan.items.length,
          0,
          `la demande devait être refusée sans items (output brut:\n${raw})`,
        );
        assert.ok(
          plan.questions && plan.questions.length > 0,
          `la demande refusée doit poser une question (output brut:\n${raw})`,
        );
      } else {
        assert.ok(
          plan.items.length > 0,
          `le plan ne contient aucun item (output brut:\n${raw})`,
        );
      }

      const missing = (fixture.mandatory ?? []).filter((alts) => !planHasAny(plan, alts));
      if (missing.length > 0) {
        assert.fail(
          `Produits explicites manquants pour "${fixture.request}" [${model.id}]:\n` +
            missing.map((alts) => `  - aucun de: ${alts.join(" | ")}`).join("\n") +
            `\nPlan obtenu:\n - ${plan.items.map(describeItem).join("\n - ")}`,
        );
      }

      for (const expected of fixture.quantities ?? []) {
        const item = findItem(plan, expected.item);
        assert.ok(
          item,
          `item introuvable pour vérifier la quantité: ${expected.item.join(" | ")}`,
        );
        assert.equal(item.quantity, expected.quantity);
      }

      if (fixture.forbidden) {
        const present = fixture.forbidden.filter((alts) => planHasAny(plan, alts));
        if (present.length > 0) {
          assert.fail(
            `Produits halluciné(s) pour "${fixture.request}" [${model.id}]:\n` +
              present.map((alts) => `  - trouvé: ${alts.join(" | ")}`).join("\n") +
              `\nPlan obtenu:\n - ${plan.items.map(describeItem).join("\n - ")}`,
          );
        }
      }
    });
  }
}

// Skip the whole suite unless explicitly opted in via
// MCP_LECLERC_RUN_INFERENCE=1 (the default `npm test` stays fast); use
// `npm run test:inference` to run it. Runs one describe block per locally
// present model so each family is exercised against the shopping-list fixtures.
if (SHOULD_RUN) {
  if (MODEL_VARIANTS.length === 0) {
    describe("model inference — shopping lists", { concurrency: false }, () => {
      test("no model found locally — run `npm run fetch:model` first", () => {
        assert.fail(
          `No local Qwen3 model found under ${MODELS_ROOT}. ` +
            `Run \`npm run fetch:model\` then re-run with MCP_LECLERC_RUN_INFERENCE=1.`,
        );
      });
    });
  } else {
    for (const model of MODEL_VARIANTS) {
      describe(`model inference — ${model.id}`, { concurrency: false }, () =>
        runSuiteForModel(model),
      );
    }
  }
} else {
  describe.skip("model inference — shopping lists", { concurrency: false }, () => {});
}
