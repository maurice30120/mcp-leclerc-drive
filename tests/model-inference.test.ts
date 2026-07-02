/**
 * Model inference tests — runs the *real* local Qwen3 model (the same
 * `@huggingface/transformers` text-generation pipeline the extension's
 * offscreen runtime uses) and checks that, for each recipe request in
 * `tests/recipes.ts`, the parsed `Plan` contains the mandatory ingredients.
 *
 * This is an inference smoke test, not a parser unit test: `parsePlan` is
 * already exhaustively tested in `orchestrator-plan.test.ts`. Here we only
 * care about *what the model infers* — that asking for a spaghetti bolognaise
 * yields both "pâtes spaghetti" and "tomate", that a carbonara never yields
 * tomato, etc.
 *
 * The goal is NOT to make every assertion pass on the first run: it is to
 * surface where the local model's inference diverges from culinary common
 * sense, so the prompt in `src/orchestrator/prompt.ts` can be tightened. A
 * failing `mandatory` assertion means the model forgot a defining ingredient;
 * a failing `forbidden` assertion means it hallucinated a foreign one.
 *
 * Skip behaviour: the whole suite is skipped automatically when the bundled
 * model is not present locally (so `npm test` stays green on machines that
 * have not run `npm run fetch:model`). Force-run with
 * `MCP_LECLERC_RUN_INFERENCE=1 node --test tests/model-inference.test.ts`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMessages } from "../src/orchestrator/prompt.ts";
import { parsePlan, type PlanItem } from "../src/orchestrator/plan.ts";
import { RECIPES } from "./recipes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Models are fetched under dist/extension/models/<org>/<repo>/... for both
// the onnx-community family, so the root is the org-agnostic
// models directory.
const MODELS_ROOT = join(ROOT, "dist", "extension", "models");

const MODEL_DTYPE = process.env.MCP_LECLERC_MODEL_DTYPE ?? "q4";
const MAX_NEW_TOKENS = 512;

/**
 * Enumerate every locally-present Qwen3 model (lightest → heaviest),
 * each with its own describe block so we can compare inference quality across
 * the family. Override with `MCP_LECLERC_MODEL_ID` (comma-separated) to restrict.
 *
 * Walks all org directories under the models root (onnx-community, …)
 * so the family is covered.
 */
function resolveModelIds(): string[] {
  const override = process.env.MCP_LECLERC_MODEL_ID;
  const allow = override
    ? override.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const found: string[] = [];
  if (existsSync(MODELS_ROOT)) {
    for (const org of readdirSync(MODELS_ROOT)) {
      const orgDir = join(MODELS_ROOT, org);
      if (!statSync(orgDir).isDirectory()) continue;
      for (const name of readdirSync(orgDir)) {
        const modelDir = join(orgDir, name);
        if (!statSync(modelDir).isDirectory()) continue;
        const weight = join(modelDir, "onnx", `model_${MODEL_DTYPE}.onnx`);
        if (existsSync(weight) && statSync(weight).size > 0) {
          const id = `${org}/${name}`;
          if (!allow || allow.includes(id)) found.push(id);
        }
      }
    }
  }
  // Deterministic order: by parameter count inferred from the folder name,
  // then alphabetically to break ties (e.g. the two 0.6B models).
  const sizeOf = (id: string): number => {
    const m = id.match(/Qwen3\.?5?-([0-9.]+)B/);
    return m ? parseFloat(m[1]) : 99;
  };
  found.sort((a, b) => sizeOf(a) - sizeOf(b) || a.localeCompare(b));
  return found;
}

const MODEL_IDS = resolveModelIds();
const FORCE = process.env.MCP_LECLERC_RUN_INFERENCE === "1";
// The inference suite is opt-in: it loads a multi-hundred-MB model and runs
// generation per recipe, which is far too heavy for the default `npm test`.
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

async function getGenerator(modelId: string): Promise<Generator> {
  let p = generators.get(modelId);
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
      const gen = await pipeline("text-generation", modelId, {
        dtype: MODEL_DTYPE,
        device: "cpu",
      });
      return gen as unknown as Generator;
    })();
    generators.set(modelId, p);
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
  modelId: string,
  request: string,
): Promise<{ plan: { items: PlanItem[] }; raw: string }> {
  const generator = await getGenerator(modelId);
  const messages = buildMessages(request);
  const output = await generator(messages, {
    max_new_tokens: MAX_NEW_TOKENS,
    do_sample: false,
    return_full_text: false,
    tokenizer_encode_kwargs: { enable_thinking: false },
  });
  const raw = extractGeneratedText(output);
  const parsed = parsePlan(raw);
  if (!parsed.ok) {
    throw new Error(`parsePlan failed for "${request}" (${modelId}): ${parsed.error}\nraw output:\n${raw}`);
  }
  return { plan: parsed.plan, raw };
}

// ---- the suite ------------------------------------------------------------

function runSuiteForModel(modelId: string) {
  test(`loaded model = ${modelId} (dtype ${MODEL_DTYPE})`, async () => {
    const generator = await getGenerator(modelId);
    assert.ok(typeof generator === "function");
  });

  for (const recipe of RECIPES) {
    test(recipe.id + ": infers mandatory ingredients", async (t) => {
      const { plan, raw } = await inferPlan(modelId, recipe.request);
      t.diagnostic(`model: ${modelId}`);
      t.diagnostic(`request: ${recipe.request}`);
      t.diagnostic(`plan:\n - ${plan.items.map(describeItem).join("\n - ")}`);
      t.diagnostic(`raw:\n${raw}`);

      assert.ok(
        plan.items.length > 0,
        `le plan ne contient aucun item (output brut:\n${raw})`,
      );

      const missing = recipe.mandatory.filter((alts) => !planHasAny(plan, alts));
      if (missing.length > 0) {
        assert.fail(
          `Ingrédients obligatoires manquants pour "${recipe.request}" [${modelId}]:\n` +
            missing.map((alts) => `  - aucun de: ${alts.join(" | ")}`).join("\n") +
            `\nPlan obtenu:\n - ${plan.items.map(describeItem).join("\n - ")}`,
        );
      }

      if (recipe.forbidden) {
        const present = recipe.forbidden.filter((alts) => planHasAny(plan, alts));
        if (present.length > 0) {
          assert.fail(
            `Ingrédients interdits présents pour "${recipe.request}" [${modelId}]:\n` +
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
// present model so each family is exercised against the recipe fixtures.
if (SHOULD_RUN) {
  if (MODEL_IDS.length === 0) {
    describe("model inference — recipes", { concurrency: false }, () => {
      test("no model found locally — run `npm run fetch:model` first", () => {
        assert.fail(
          `No local Qwen3 model found under ${MODELS_ROOT}. ` +
            `Run \`npm run fetch:model\` then re-run with MCP_LECLERC_RUN_INFERENCE=1.`,
        );
      });
    });
  } else {
    for (const id of MODEL_IDS) {
      describe(`model inference — ${id}`, { concurrency: false }, () =>
        runSuiteForModel(id),
      );
    }
  }
} else {
  describe.skip("model inference — recipes", { concurrency: false }, () => {});
}
