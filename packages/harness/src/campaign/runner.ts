/**
 * Campaign runner (ticket #46, comparative structure of ticket #56).
 *
 * Runs a set of versioned scenarios through runScenario (with its BLOCKING
 * safety assertions) and writes a dated/identified run directory:
 *
 *   results.json — full sanitized report: per-scenario frozen prompt, status,
 *                  checks, duration, sanitized trace and result summary;
 *   summary.md   — comparative per-scenario table (id, status, duration,
 *                  notable errors). NO arbitrary global score: only a simple
 *                  pass/fail count, so a per-scenario regression is always
 *                  visible, never averaged away;
 *   results.csv / results.jsonl — optional per-scenario exports for statistical
 *                  follow-up, written when requested.
 *
 * The provider identity (id, modelVersion, nonDeterministic — true for cloud
 * providers) is recorded in every artifact; a campaign against an injected
 * provider runs every scenario WITHOUT its own providerOverride (A10 keeps
 * its WebGPU-failure override) through that provider.
 *
 * Every written byte passes through the sanitizer: no Mistral key, no
 * Bearer/Authorization/cookie value, no passed-in secret may appear in a
 * produced file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider, ShoppingFlowResult, TraceEvent } from "@leclerc/agent";
import type { ProviderIdentity } from "./providers.js";
import { sanitize } from "../sanitizer.js";
import {
  runScenario,
  SCENARIOS_VERSION,
  type ScenarioCheck,
  type ScenarioDefinition,
  type ScenarioProviderOverride,
} from "../scenarios/index.js";

/** Pinned generation parameters recorded in every report. */
export interface CampaignGenerationParams {
  temperature: number;
  seed: number;
  maxTokens: number;
}

export interface CampaignOptions {
  scenarios: readonly ScenarioDefinition[];
  /**
   * Provider injected into every scenario without its own providerOverride
   * (mistral / webgpu campaigns). Absent for the simulated default: the
   * scripted scenarios run as defined, fully offline.
   */
  provider?: ModelProvider;
  /** Identity recorded in the report — includes the nonDeterministic flag. */
  providerInfo: ProviderIdentity;
  /** Base directory; the run directory is `<outDir>/<runId>`. */
  outDir: string;
  runId: string;
  generationParams: CampaignGenerationParams;
  csv?: boolean;
  jsonl?: boolean;
  /** Injectable clock — timestamps and durations are testable. */
  now?: () => number;
  /** Extra secret values redacted from every artifact (e.g. MISTRAPI_KEY). */
  secrets?: readonly string[];
}

/** Sanitized per-scenario record, the unit of the CSV/JSONL exports. */
export interface CampaignScenarioRecord {
  id: string;
  title: string;
  status: "passed" | "failed";
  /** ShoppingFlowResult.status of the run. */
  resultStatus: string;
  durationMs: number;
  /** Frozen prompt constant, recorded for fine-tuning comparisons (F01). */
  prompt: { version: number; text: string };
  generationParams: CampaignGenerationParams;
  checks: ScenarioCheck[];
  checkCounts: { total: number; passed: number; failed: number };
  /** Failed check details — a regression is visible per scenario, never averaged. */
  notableErrors: string[];
  resultSummary: {
    status: string;
    recipeTitle?: string;
    previewItems?: number;
    cartItems?: number;
    issues: number;
    hasGapReport: boolean;
    diagnostic?: string;
    errorCode?: string;
  };
  trace: unknown;
}

export interface CampaignReport {
  kind: "campaign-report";
  tickets: readonly number[];
  runId: string;
  timestamp: string;
  scenariosVersion: number;
  provider: ProviderIdentity;
  generationParams: CampaignGenerationParams;
  totals: { scenarios: number; passed: number; failed: number };
  scenarios: CampaignScenarioRecord[];
}

export interface CampaignRunOutcome {
  report: CampaignReport;
  runDir: string;
  files: { resultsJson: string; summaryMd: string; csv?: string; jsonl?: string };
}

/** Wraps an injected provider with call-counting instrumentation. */
function providerOverrideFor(provider: ModelProvider, providerInfo: ProviderIdentity): ScenarioProviderOverride {
  return {
    create: () => {
      let generateCalls = 0;
      const wrapped: ModelProvider = {
        id: provider.id,
        modelVersion: provider.modelVersion,
        capabilities: provider.capabilities,
        generate: async (request) => {
          generateCalls++;
          return provider.generate(request);
        },
      };
      const cloud = providerInfo.id === "mistral-byok";
      return {
        provider: wrapped,
        instrumentation: {
          localCalls: () => (cloud ? 0 : generateCalls),
          probeCalls: () => 0,
          pipelineCalls: () => 0,
          mistralCalls: () => (cloud ? generateCalls : 0),
        },
      };
    },
  };
}

function summarizeResult(result: ShoppingFlowResult): CampaignScenarioRecord["resultSummary"] {
  return {
    status: result.status,
    ...(result.recipe?.title !== undefined ? { recipeTitle: result.recipe.title } : {}),
    ...(result.preview?.lines !== undefined
      ? { previewItems: result.preview.lines.length }
      : {}),
    ...(result.cart?.items !== undefined ? { cartItems: result.cart.items.length } : {}),
    issues: result.issues.length,
    hasGapReport: result.gap !== undefined,
    ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
    ...(result.error?.code !== undefined ? { errorCode: result.error.code } : {}),
  };
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

function recordForScenario(
  scenario: ScenarioDefinition,
  checks: ScenarioCheck[],
  trace: readonly TraceEvent[],
  result: ShoppingFlowResult,
  durationMs: number,
  generationParams: CampaignGenerationParams,
): CampaignScenarioRecord {
  const failed = checks.filter((check) => !check.pass);
  return {
    id: scenario.id,
    title: scenario.title,
    status: failed.length === 0 ? "passed" : "failed",
    resultStatus: result.status,
    durationMs,
    prompt: { version: scenario.frozenPrompt.version, text: scenario.frozenPrompt.text },
    generationParams,
    checks: [...checks],
    checkCounts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    notableErrors: failed.map((check) => `${check.name} : ${check.detail}`),
    resultSummary: summarizeResult(result),
    trace: [...trace],
  };
}

function recordForCrash(
  scenario: ScenarioDefinition,
  error: unknown,
  generationParams: CampaignGenerationParams,
): CampaignScenarioRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: scenario.id,
    title: scenario.title,
    status: "failed",
    resultStatus: "crashed",
    durationMs: 0,
    prompt: { version: scenario.frozenPrompt.version, text: scenario.frozenPrompt.text },
    generationParams,
    checks: [{ name: `${scenario.id} — exécution`, pass: false, detail: message }],
    checkCounts: { total: 1, passed: 0, failed: 1 },
    notableErrors: [`exécution interrompue : ${message}`],
    resultSummary: { status: "crashed", issues: 0, hasGapReport: false },
    trace: [],
  };
}

function summaryMarkdown(report: CampaignReport): string {
  const lines: string[] = [];
  lines.push(`# Campagne — ${report.runId}`);
  lines.push("");
  lines.push(`- Horodatage : ${report.timestamp}`);
  lines.push(
    `- Fournisseur : ${report.provider.label} (${report.provider.id}, modèle \`${report.provider.modelVersion}\`)`,
  );
  lines.push(
    report.provider.nonDeterministic
      ? "- Non déterminisme : **oui** — fournisseur cloud, les sorties ne sont pas reproductibles octet par octet ; aucune amélioration ne peut être affirmée sans mesure répétée."
      : "- Non déterminisme : non.",
  );
  lines.push(`- Version des scénarios : ${report.scenariosVersion}`);
  lines.push(
    `- Paramètres de génération pincés : temperature ${report.generationParams.temperature}, seed ${report.generationParams.seed}, maxTokens ${report.generationParams.maxTokens}`,
  );
  lines.push(
    `- Scénarios : ${report.totals.passed} réussi(s), ${report.totals.failed} en échec, sur ${report.totals.scenarios}.`,
  );
  lines.push("");
  lines.push("Chaque scénario reste visible individuellement : aucun agrégat ne masque une régression.");
  lines.push("");
  lines.push("| Scénario | Statut | Durée (ms) | Erreurs notables |");
  lines.push("| --- | --- | --- | --- |");
  for (const record of report.scenarios) {
    const errors =
      record.notableErrors.length === 0 ? "—" : record.notableErrors.join(" ; ").slice(0, 200);
    lines.push(`| ${record.id} | ${record.status === "passed" ? "réussi" : "échoué"} | ${record.durationMs} | ${errors} |`);
  }
  lines.push("");
  const failing = report.scenarios.filter((record) => record.status === "failed");
  if (failing.length > 0) {
    lines.push("## Erreurs notables, par scénario");
    lines.push("");
    for (const record of failing) {
      lines.push(`### ${record.id} — ${record.resultStatus}`);
      for (const error of record.notableErrors) {
        lines.push(`- ${error}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function scenarioCsvRow(record: CampaignScenarioRecord): string {
  return [
    record.id,
    record.status,
    record.resultStatus,
    String(record.durationMs),
    String(record.checkCounts.passed),
    String(record.checkCounts.failed),
    record.notableErrors.join(" ; "),
  ]
    .map(csvEscape)
    .join(",");
}

const CSV_HEADER = "id,status,resultStatus,durationMs,checksPassed,checksFailed,notableErrors";

/**
 * Runs every scenario via runScenario and writes the sanitized campaign
 * artifacts. Never throws for a failing scenario: failures are recorded
 * per scenario and surfaced in the report.
 */
export async function runCampaign(options: CampaignOptions): Promise<CampaignRunOutcome> {
  const now = options.now ?? Date.now;
  const timestamp = new Date(now()).toISOString();
  const secrets = [...(options.secrets ?? [])];

  const records: CampaignScenarioRecord[] = [];
  for (const scenario of options.scenarios) {
    const startedAt = now();
    const effectiveScenario: ScenarioDefinition =
      options.provider !== undefined && scenario.providerOverride === undefined
        ? { ...scenario, providerOverride: providerOverrideFor(options.provider, options.providerInfo) }
        : scenario;
    try {
      const run = await runScenario(effectiveScenario);
      const durationMs = now() - startedAt;
      records.push(
        recordForScenario(scenario, run.checks, run.trace, run.result, durationMs, options.generationParams),
      );
    } catch (error) {
      records.push(recordForCrash(scenario, error, options.generationParams));
    }
  }

  const passed = records.filter((record) => record.status === "passed").length;
  const report: CampaignReport = {
    kind: "campaign-report",
    tickets: [46, 56],
    runId: options.runId,
    timestamp,
    scenariosVersion: SCENARIOS_VERSION,
    provider: options.providerInfo,
    generationParams: options.generationParams,
    totals: { scenarios: records.length, passed, failed: records.length - passed },
    scenarios: records,
  };

  const sanitizedReport = sanitize(report, secrets) as CampaignReport;
  const runDir = join(options.outDir, options.runId);
  await mkdir(runDir, { recursive: true });

  const resultsJsonPath = join(runDir, "results.json");
  await writeFile(resultsJsonPath, JSON.stringify(sanitizedReport, null, 2), "utf8");

  const summaryMdPath = join(runDir, "summary.md");
  await writeFile(summaryMdPath, summaryMarkdown(sanitizedReport), "utf8");

  const files: CampaignRunOutcome["files"] = { resultsJson: resultsJsonPath, summaryMd: summaryMdPath };

  if (options.csv) {
    const csvPath = join(runDir, "results.csv");
    const rows = [CSV_HEADER, ...sanitizedReport.scenarios.map(scenarioCsvRow)];
    await writeFile(csvPath, rows.join("\n") + "\n", "utf8");
    files.csv = csvPath;
  }

  if (options.jsonl) {
    const jsonlPath = join(runDir, "results.jsonl");
    const lines = sanitizedReport.scenarios.map((record) => JSON.stringify(record));
    await writeFile(jsonlPath, lines.join("\n") + "\n", "utf8");
    files.jsonl = jsonlPath;
  }

  return { report: sanitizedReport, runDir, files };
}
