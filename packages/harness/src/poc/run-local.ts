/**
 * Opt-in local WebGPU POC runner (spec issue #40, ticket #47).
 *
 * This runner CANNOT run in CI: it requires a real GPU and downloads the model
 * weights. It is gated behind MCP_LECLERC_RUN_LOCAL=1 as an explicit opt-in,
 * probes WebGPU first and NEVER falls back to CPU/WASM — a failed probe stops
 * the run with a non-zero exit and a French diagnostic. When the probe passes,
 * ONE frozen prompt (A01 recipe prompt) is run through the real
 * createWebGpuProvider with the pinned GENERATION_PARAMS, and a JSON report
 * (model, revision, dtype, load/generation timings, raw output, parsed recipe
 * validity) is written to runs/ (gitignored).
 *
 * Nothing executes at import time except the direct-invocation check for the
 * `node dist/poc/run-local.js` npm script.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  GENERATION_PARAMS,
  ProviderUnavailableError,
  PROMPT_VERSION,
  RECIPE_SYSTEM_PROMPT,
  createNavigatorGpuProbe,
  createWebGpuProvider,
  type WebGpuPipeline,
  type WebGpuPipelineFactory,
  type WebGpuProbe,
} from "@leclerc/agent";
import { parseRecipeText, type RecipeIssue } from "@leclerc/contracts";
import { DEFAULT_POC_CANDIDATE } from "./candidates.js";
import { createTransformersPipelineFactory } from "./transformers-pipeline.js";

/** Frozen A01 scenario prompt (poulet au curry sans crème pour 4). */
export const POC_PROMPT_A01 =
  "Propose-moi une recette de poulet au curry sans crème pour 4 personnes." as const;

/** Injectable seams of the runner — every dependency fakeable offline. */
export interface RunLocalDeps {
  env: Record<string, string | undefined>;
  probe: WebGpuProbe;
  pipelineFactory: WebGpuPipelineFactory;
  now?: () => number;
  writeReport?: (path: string, content: string) => Promise<void>;
  reportDir?: string;
}

export interface PocRunReport {
  kind: "poc-webgpu-model-selection";
  ticket: 47;
  promptVersion: typeof PROMPT_VERSION;
  timestamp: string;
  model: {
    id: string;
    revision: string;
    dtype: string;
    device: "webgpu";
  };
  generation: {
    temperature: number;
    seed: number;
    maxTokens: number;
  };
  loadMs: number;
  generationMs: number;
  rawOutput: string;
  recipe: {
    valid: boolean;
    issues?: RecipeIssue[];
    repairs?: number;
  };
}

export interface RunLocalOutcome {
  exitCode: number;
  /** French lines the caller prints (the runner itself stays silent). */
  summary: string[];
  report?: PocRunReport;
  reportPath?: string;
}

const OPT_IN_ENV = "MCP_LECLERC_RUN_LOCAL";

export function selectModel(env: Record<string, string | undefined>): PocRunReport["model"] {
  return {
    id: env.MCP_LECLERC_POC_MODEL_ID ?? DEFAULT_POC_CANDIDATE.id,
    revision: env.MCP_LECLERC_POC_REVISION ?? DEFAULT_POC_CANDIDATE.revision,
    dtype: env.MCP_LECLERC_POC_DTYPE ?? DEFAULT_POC_CANDIDATE.dtype,
    device: "webgpu",
  };
}

function reportFileName(timestamp: string): string {
  return `poc-${timestamp.replace(/[:.]/g, "-")}.json`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the POC with injectable dependencies. Returns the outcome — never
 * throws for expected failure paths (gate, probe, generation error): the
 * caller decides how to surface exitCode + summary.
 */
export async function runLocalPoc(deps: RunLocalDeps): Promise<RunLocalOutcome> {
  const now = deps.now ?? Date.now;

  if (deps.env[OPT_IN_ENV] !== "1") {
    return {
      exitCode: 1,
      summary: [
        "POC WebGPU local non lancé : ce POC est strictement opt-in.",
        `Il exige un GPU WebGPU fonctionnel et télécharge les poids du modèle sur votre machine.`,
        `Pour l'accepter explicitement : ${OPT_IN_ENV}=1 npm run test:harness:local`,
        "Aucune sonde, aucun téléchargement et aucune inférence n'ont été exécutés.",
      ],
    };
  }

  const model = selectModel(deps.env);
  const reportDir = deps.reportDir ?? "runs";
  const writeReport = deps.writeReport ?? defaultWriteReport;

  let loadMs = 0;
  let generationMs = 0;
  const measuredFactory: WebGpuPipelineFactory = async (options) => {
    const startedAt = now();
    const pipeline = await deps.pipelineFactory(options);
    loadMs = now() - startedAt;
    return {
      generate: async (input) => {
        const generateStartedAt = now();
        const output = await pipeline.generate(input);
        generationMs = now() - generateStartedAt;
        return output;
      },
    } satisfies WebGpuPipeline;
  };

  const provider = createWebGpuProvider({
    modelId: model.id,
    revision: model.revision,
    probe: deps.probe,
    pipelineFactory: measuredFactory,
    generationParams: GENERATION_PARAMS,
  });

  let response;
  try {
    response = await provider.generate({
      messages: [
        { role: "system", content: RECIPE_SYSTEM_PROMPT },
        { role: "user", content: POC_PROMPT_A01 },
      ],
      ...GENERATION_PARAMS,
    });
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      return {
        exitCode: 1,
        summary: [
          "POC WebGPU local : modèle local NON lancé.",
          error.diagnostic,
          "Aucun rapport n'a été écrit et aucun repli CPU/WASM n'a été tenté.",
        ],
      };
    }
    return {
      exitCode: 1,
      summary: ["POC WebGPU local : échec inattendu.", describeError(error)],
    };
  }

  if (response.finishReason === "error") {
    return {
      exitCode: 1,
      summary: [
        "POC WebGPU local : la génération a échoué.",
        response.text ?? "Aucune sortie du modèle.",
        "Aucun rapport n'a été écrit.",
      ],
    };
  }

  const rawOutput = response.text ?? "";
  const parsed = parseRecipeText(rawOutput);
  const timestamp = new Date(now()).toISOString();
  const report: PocRunReport = {
    kind: "poc-webgpu-model-selection",
    ticket: 47,
    promptVersion: PROMPT_VERSION,
    timestamp,
    model,
    generation: {
      temperature: GENERATION_PARAMS.temperature,
      seed: GENERATION_PARAMS.seed,
      maxTokens: GENERATION_PARAMS.maxTokens,
    },
    loadMs,
    generationMs,
    rawOutput,
    recipe: parsed.ok
      ? { valid: true, repairs: parsed.repairs }
      : { valid: false, issues: parsed.issues, repairs: parsed.repairs },
  };

  const reportPath = `${reportDir}/${reportFileName(timestamp)}`;
  await writeReport(reportPath, JSON.stringify(report, null, 2));

  return {
    exitCode: 0,
    summary: [
      "POC WebGPU local : exécution terminée.",
      `Modèle : ${model.id} (révision ${model.revision}, dtype ${model.dtype}, device webgpu)`,
      `Chargement : ${report.loadMs} ms — Génération : ${report.generationMs} ms`,
      parsed.ok
        ? "Recette : JSON valide au sens du schéma généré."
        : `Recette : JSON invalide (${parsed.issues.map((i) => i.code).join(", ")}).`,
      `Rapport : ${reportPath}`,
    ],
    report,
    reportPath,
  };
}

async function defaultWriteReport(path: string, content: string): Promise<void> {
  await mkdir("runs", { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Real wiring used by `npm run campaign:webgpu` (node dist/poc/run-local.js). */
export async function main(): Promise<void> {
  const model = selectModel(process.env);
  const outcome = await runLocalPoc({
    env: process.env,
    probe: createNavigatorGpuProbe(),
    pipelineFactory: createTransformersPipelineFactory({ dtype: model.dtype }),
  });
  for (const line of outcome.summary) {
    console.log(line);
  }
  process.exitCode = outcome.exitCode;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
