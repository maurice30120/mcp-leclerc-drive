#!/usr/bin/env node
/**
 * Campaign CLI (ticket #46): `node dist/campaign/cli.js`
 *
 *   --scenarios A01,A05   subset of the versioned registry (default: all)
 *   --out runs            base directory (default "runs")
 *   --provider simulated|mistral|webgpu   EXPLICIT-ONLY provider choice
 *   --csv / --jsonl       optional per-scenario exports
 *   --run-id <id>          explicit run id (default campaign-<horodatage>)
 *
 * Provider selection is EXPLICIT-ONLY:
 *   - simulated is the default and runs fully offline (scripted scenarios);
 *   - mistral requires --provider mistral AND MISTRAPI_KEY — a missing key
 *     aborts with a French diagnostic, there is NO fallback;
 *   - webgpu is opt-in gated exactly like the POC runner
 *     (MCP_LECLERC_RUN_LOCAL=1), needs a validated model manifest
 *     (MCP_LECLERC_MANIFEST) and probes WebGPU with clear diagnostics before
 *     anything is launched; no CPU/WASM fallback exists.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { MistralFetch } from "@leclerc/agent";
import {
  createCampaignProvider,
  MISTRAL_KEY_ENV,
  PROVIDER_CONFIGS,
  resolveProviderConfig,
  type CreateProviderDeps,
  type RequestedProvider,
} from "./providers.js";
import { runCampaign, type CampaignRunOutcome } from "./runner.js";
import { getScenario, SCENARIOS, SCENARIO_GENERATION_PARAMS, type ScenarioDefinition } from "../scenarios/index.js";
import { createTransformersPipelineFactory } from "../poc/transformers-pipeline.js";

export interface CliArgs {
  scenarios?: readonly string[];
  out: string;
  provider?: RequestedProvider;
  csv?: boolean;
  jsonl?: boolean;
  runId?: string;
}

export type CliParse = { ok: true; args: CliArgs } | { ok: false; diagnostic: string };

const KNOWN_PROVIDERS: readonly RequestedProvider[] = ["simulated", "mistral", "webgpu"];

export function parseCampaignArgs(argv: readonly string[]): CliParse {
  const args: CliArgs = { out: "runs" };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--scenarios":
        if (!value) return { ok: false, diagnostic: "Drapeau --scenarios : liste d'identifiants attendue (ex. A01,A05)." };
        args.scenarios = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
        index++;
        break;
      case "--out":
        if (!value) return { ok: false, diagnostic: "Drapeau --out : répertoire attendu." };
        args.out = value;
        index++;
        break;
      case "--provider": {
        if (!value || !KNOWN_PROVIDERS.includes(value as RequestedProvider)) {
          return {
            ok: false,
            diagnostic: `Fournisseur inconnu « ${value ?? ""} » : choisir parmi simulated|mistral|webgpu.`,
          };
        }
        args.provider = value as RequestedProvider;
        index++;
        break;
      }
      case "--csv":
        args.csv = true;
        break;
      case "--jsonl":
        args.jsonl = true;
        break;
      case "--run-id":
        if (!value) return { ok: false, diagnostic: "Drapeau --run-id : identifiant attendu." };
        args.runId = value;
        index++;
        break;
      default:
        return { ok: false, diagnostic: `Drapeau inconnu : ${flag}.` };
    }
  }
  return { ok: true, args };
}

export interface CliDeps {
  env: Record<string, string | undefined>;
  now?: () => number;
  /** Injectable seams (tests stay offline). */
  createProvider?: (deps: CreateProviderDeps) => ReturnType<typeof createCampaignProvider>;
  fetchImpl?: MistralFetch;
}

export interface CliOutcome {
  exitCode: number;
  /** French lines to print — the CLI itself stays silent apart from main(). */
  lines: string[];
  runDir?: string;
}

const MANIFEST_ENV = "MCP_LECLERC_MANIFEST";

async function readManifest(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function realFetch(): MistralFetch {
  return (url, init) => fetch(url, init);
}

function runIdFor(timestamp: string): string {
  return `campaign-${timestamp.replace(/[:.]/g, "-")}`;
}

export async function runCampaignCli(argv: readonly string[], deps: CliDeps): Promise<CliOutcome> {
  const now = deps.now ?? Date.now;

  const parsed = parseCampaignArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 1, lines: [parsed.diagnostic] };
  }
  const args = parsed.args;

  let scenarios: ScenarioDefinition[];
  if (args.scenarios) {
    const unknown = args.scenarios.filter((id) => getScenario(id) === undefined);
    if (unknown.length > 0) {
      return {
        exitCode: 1,
        lines: [
          `Scénarios inconnus : ${unknown.join(", ")}.`,
          `Identifiants valides : ${SCENARIOS.map((scenario) => scenario.id).join(", ")}.`,
        ],
      };
    }
    scenarios = args.scenarios.map((id) => getScenario(id)!);
  } else {
    scenarios = [...SCENARIOS];
  }

  const resolved = resolveProviderConfig(args.provider, deps.env);
  if (!resolved.ok) {
    return { exitCode: 1, lines: ["Run de campagne refusé :", resolved.diagnostic] };
  }
  const configId = resolved.configId;
  const config = PROVIDER_CONFIGS[configId];

  const built = await (deps.createProvider ?? createCampaignProvider)({
    configId,
    env: deps.env,
    ...(configId === "mistral-byok" ? { fetchImpl: deps.fetchImpl ?? realFetch() } : {}),
    ...(config.requiresManifest && deps.env[MANIFEST_ENV]
      ? { manifest: await readManifest(deps.env[MANIFEST_ENV]!) }
      : {}),
    ...(configId.startsWith("webgpu")
      ? {
          probe: (await import("@leclerc/agent")).createNavigatorGpuProbe(),
          pipelineFactory: createTransformersPipelineFactory({ dtype: "q4" }),
        }
      : {}),
  });
  if (!built.ok) {
    return { exitCode: 1, lines: [`Run de campagne refusé (configuration ${configId}) :`, built.diagnostic] };
  }
  const providerInfo = built.info;
  // Simulated runs execute the scripted scenarios as defined; a real provider
  // is injected into every scenario without its own override.
  const provider = configId === "simulated" ? undefined : built.provider;

  const timestamp = new Date(now()).toISOString();
  const runId = args.runId ?? runIdFor(timestamp);
  try {
    const outcome: CampaignRunOutcome = await runCampaign({
      scenarios,
      ...(provider !== undefined ? { provider } : {}),
      providerInfo,
      outDir: args.out,
      runId,
      generationParams: SCENARIO_GENERATION_PARAMS,
      ...(args.csv ? { csv: true } : {}),
      ...(args.jsonl ? { jsonl: true } : {}),
      now,
      ...(deps.env[MISTRAL_KEY_ENV] ? { secrets: [deps.env[MISTRAL_KEY_ENV]!] } : {}),
    });

    const lines = [
      "Campagne terminée.",
      `Run : ${outcome.runDir}`,
      `Fournisseur : ${providerInfo.label} (${providerInfo.id}, modèle ${providerInfo.modelVersion})`,
      `Scénarios : ${outcome.report.totals.passed} réussi(s), ${outcome.report.totals.failed} en échec, sur ${outcome.report.totals.scenarios}.`,
      `Rapport : ${outcome.files.resultsJson}`,
      `Synthèse : ${outcome.files.summaryMd}`,
    ];
    return { exitCode: 0, lines, runDir: outcome.runDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, lines: ["Run de campagne interrompu :", message] };
  }
}

/** Real wiring used by `npm run campaign` (node dist/campaign/cli.js). */
export async function main(): Promise<void> {
  const outcome = await runCampaignCli(process.argv.slice(2), { env: process.env });
  for (const line of outcome.lines) {
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
