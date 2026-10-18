// One-off generator: emits training/finetune/prompts_f01.jsonl from the
// versioned TS constants so the fine-tuning campaign replays byte-identical
// inputs with the harness fixture F01 (packages/harness scenarios).
// Run from the repo root: node training/finetune/gen_prompts_f01.mjs
// NOT part of the pipeline — scaffolding utility, kept for provenance.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const promptsSrc = readFileSync(
  join(root, "packages/agent/src/prompts.ts"),
  "utf8",
);
const scenariosSrc = readFileSync(
  join(root, "packages/harness/src/scenarios/definitions.ts"),
  "utf8",
);

const systemMatch = promptsSrc.match(
  /export const RECIPE_SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\("\\n"\);/,
);
if (!systemMatch) throw new Error("RECIPE_SYSTEM_PROMPT introuvable");
const system = eval(`[${systemMatch[1]}]`).join("\n");

const promptVersionMatch = promptsSrc.match(/export const PROMPT_VERSION = (\d+)/);
if (!promptVersionMatch) throw new Error("PROMPT_VERSION introuvable");

const a01Match = scenariosSrc.match(
  /export const A01_PROMPT: FrozenPrompt = \{\s*version: (\d+),\s*text: "((?:[^"\\]|\\.)*)",/,
);
if (!a01Match) throw new Error("A01_PROMPT introuvable");
const user = JSON.parse(`"${a01Match[2]}"`);
const frozenPromptVersion = Number(a01Match[1]);

const record = {
  id: "F01",
  prompt_version: Number(promptVersionMatch[1]),
  frozen_prompt_version: frozenPromptVersion,
  source: {
    system: "packages/agent/src/prompts.ts — RECIPE_SYSTEM_PROMPT (figé)",
    user: "packages/harness/src/scenarios/definitions.ts — A01_PROMPT (F01)",
    generation_params: "packages/harness/src/scenarios/types.ts — SCENARIO_GENERATION_PARAMS",
  },
  system,
  user,
  generation: { temperature: 0, seed: 0, maxTokens: 1024 },
};

const outDir = join(root, "training", "finetune");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "prompts_f01.jsonl"),
  JSON.stringify(record) + "\n",
  "utf8",
);
console.log("prompts_f01.jsonl écrit (1 prompt figé F01, identité octet par octet avec le harnais)");
