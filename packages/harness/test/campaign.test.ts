import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerateResponse, ModelProvider } from "@leclerc/agent";
import { getScenario, SCENARIOS, type ScenarioDefinition } from "../src/index.js";
import { runCampaign, type CampaignReport } from "../src/campaign/runner.js";
import { PROVIDER_CONFIGS, type ProviderIdentity } from "../src/campaign/providers.js";

const FAKE_MISTRAL_KEY = "sk-FAKEfakefakefakefakeKEY1234567890";

const SIMULATED_INFO: ProviderIdentity = {
  id: "simulated",
  label: PROVIDER_CONFIGS.simulated.label,
  modelVersion: "simulated-1.0",
  nonDeterministic: false,
};

const PINNED_PARAMS = { temperature: 0, seed: 0, maxTokens: 1024 };

let tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leclerc-campaign-"));
  tempDirs.push(dir);
  return dir;
}

async function readJson(path: string): Promise<CampaignReport> {
  return JSON.parse(await readFile(path, "utf8")) as CampaignReport;
}

function scenarioIds(ids: readonly string[]): ScenarioDefinition[] {
  return ids.map((id) => {
    const scenario = getScenario(id);
    if (!scenario) throw new Error(`scénario inconnu : ${id}`);
    return scenario;
  });
}

/** Horloge injectable : avance de 5 ms à chaque appel. */
function stepClock(): () => number {
  let t = 1000;
  return () => (t += 5);
}

describe("harnais de campagne (ticket #46)", () => {
  it("mesure les appels et questions évitables contre les fixtures du parcours progressif", async () => {
    const outDir = await makeTempDir();
    const { report, files } = await runCampaign({ scenarios: scenarioIds(["S01", "S02", "S03", "S04"]),
      providerInfo: SIMULATED_INFO, outDir, runId: "progressive-metrics", generationParams: PINNED_PARAMS });
    expect(report.totals).toEqual({ scenarios: 4, passed: 4, failed: 0 });
    const solid = report.scenarios.find((record) => record.id === "S01")!;
    expect(solid.selectionMode).toBe("model");
    expect(solid.selectionMetrics).toMatchObject({ modelCalls: 2, toolCalls: 11, selectionRounds: 1, automaticSelections: 2, clarificationCount: 0, selectionErrors: 0, avoidableQuestions: 0 });
    const invalid = report.scenarios.find((record) => record.id === "S02")!;
    expect(invalid.selectionMetrics).toMatchObject({ selectionErrors: 0, avoidableQuestions: 1 });
    const summary = await readFile(files.summaryMd, "utf8");
    expect(summary).toContain("Questions évitables");
    expect(summary).toContain("| S01 | model | 1 | 2 / 11 | 0 | 0 | 0 |");
  });

  it(" produit results.json et summary.md exploitables pour un run simulé hors ligne", async () => {
    const outDir = await makeTempDir();
    const outcome = await runCampaign({
      scenarios: scenarioIds(["A01", "A05", "F01"]),
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-test-1",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });

    expect(outcome.runDir).toBe(join(outDir, "run-test-1"));
    const files = await readdir(outcome.runDir);
    expect(files).toContain("results.json");
    expect(files).toContain("summary.md");
    // Sans les drapeaux, ni csv ni jsonl ne sont écrits.
    expect(files).not.toContain("results.csv");
    expect(files).not.toContain("results.jsonl");

    const report = await readJson(join(outcome.runDir, "results.json"));
    expect(report.kind).toBe("campaign-report");
    expect(report.runId).toBe("run-test-1");
    expect(report.timestamp).toBe(new Date(1005).toISOString());
    expect(report.scenariosVersion).toBe(2);
    expect(report.provider).toEqual(SIMULATED_INFO);
    expect(report.generationParams).toEqual(PINNED_PARAMS);
    expect(report.totals).toEqual({ scenarios: 3, passed: 3, failed: 0 });
    expect(report.scenarios.map((record) => record.id)).toEqual(["A01", "A05", "F01"]);
  });

  it(" enregistre le prompt figé, la version et les paramètres pincés de chaque scénario", async () => {
    const outDir = await makeTempDir();
    const outcome = await runCampaign({
      scenarios: scenarioIds(["A01", "F01"]),
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-prompts",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });
    const report = await readJson(join(outcome.runDir, "results.json"));
    for (const record of report.scenarios) {
      const scenario = getScenario(record.id);
      if (!scenario) throw new Error(`scénario inconnu : ${record.id}`);
      expect(record.prompt.version).toBe(scenario.frozenPrompt.version);
      expect(record.prompt.text).toBe(scenario.frozenPrompt.text);
      expect(record.generationParams).toEqual(PINNED_PARAMS);
      expect(record.durationMs).toBe(5);
    }
  });

  it(" écrit csv et jsonl sur demande, un enregistrement par scénario", async () => {
    const outDir = await makeTempDir();
    const outcome = await runCampaign({
      scenarios: scenarioIds(["A01", "A05"]),
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-exports",
      generationParams: PINNED_PARAMS,
      csv: true,
      jsonl: true,
      now: stepClock(),
    });

    const csv = await readFile(join(outcome.runDir, "results.csv"), "utf8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("id,status,resultStatus,durationMs,checksPassed,checksFailed,notableErrors");
    expect(lines.length).toBe(3);
    expect(lines[1].startsWith('"A01","passed",')).toBe(true);

    const jsonl = await readFile(join(outcome.runDir, "results.jsonl"), "utf8");
    const records = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.id)).toEqual(["A01", "A05"]);
    expect(records.every((record) => record.status === "passed")).toBe(true);
  });

  it(" rend visible chaque scénario en échec individuellement, sans score global", async () => {
    const outDir = await makeTempDir();
    // A06b échoue volontairement (JSON invalide deux fois) — mais son statut
    // attendu est "failed" côté scénario ; pour une régression visible on
    // sabote un scénario : script vidé => les attentes échouent.
    const sabotaged: ScenarioDefinition = {
      ...getScenario("A01")!,
      id: "X01",
      title: "scénario sabote pour la régression",
      providerScript: [{ text: '{"title":"raté"}' }],
    };
    const outcome = await runCampaign({
      scenarios: [getScenario("A01")!, sabotaged],
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-regression",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });

    const report = await readJson(join(outcome.runDir, "results.json"));
    expect(report.totals).toEqual({ scenarios: 2, passed: 1, failed: 1 });
    const failed = report.scenarios.find((record) => record.id === "X01");
    const passed = report.scenarios.find((record) => record.id === "A01");
    expect(failed?.status).toBe("failed");
    expect(failed?.notableErrors.length).toBeGreaterThan(0);
    expect(failed?.checkCounts.failed).toBeGreaterThan(0);
    expect(passed?.status).toBe("passed");
    // Aucun score global arbitraire dans le rapport.
    expect(Object.keys(report)).not.toContain("score");
    for (const record of report.scenarios) {
      expect(Object.keys(record)).not.toContain("score");
    }

    const summary = await readFile(join(outcome.runDir, "summary.md"), "utf8");
    expect(summary).toContain("| X01 | échoué |");
    expect(summary).toContain("| A01 | réussi |");
    expect(summary.toLowerCase()).not.toContain("score");
    expect(summary).toContain("1 réussi");
    expect(summary).toContain("1 en échec");
  });

  it(" bloque (BLOCKING) toute clé de test dans chaque fichier produit", async () => {
    const outDir = await makeTempDir();
    const leaking: ScenarioDefinition = {
      ...getScenario("F01")!,
      providerScript: [
        {
          text: `{"title":"Poulet au curry au riz basmati","servings":4,"ingredients":[{"name":"filets de poulet","quantity":600,"unit":"g"}],"steps":["Cuire."]} -- Authorization: Bearer ${FAKE_MISTRAL_KEY} cookie=${FAKE_MISTRAL_KEY}`,
        },
      ],
    };
    const outcome = await runCampaign({
      scenarios: [leaking],
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-secrets",
      generationParams: PINNED_PARAMS,
      secrets: [FAKE_MISTRAL_KEY],
      csv: true,
      jsonl: true,
      now: stepClock(),
    });

    for (const file of ["results.json", "summary.md", "results.csv", "results.jsonl"]) {
      const content = await readFile(join(outcome.runDir, file), "utf8");
      expect(content, file).not.toContain(FAKE_MISTRAL_KEY);
      expect(content, file).not.toContain("Bearer sk-");
    }
  });

  it(" consigne l'identité du fournisseur et son non-déterminisme éventuel (ticket #56)", async () => {
    const outDir = await makeTempDir();
    const cloudInfo: ProviderIdentity = {
      id: "mistral-byok",
      label: PROVIDER_CONFIGS["mistral-byok"].label,
      modelVersion: "mistral-small-latest",
      nonDeterministic: true,
    };
    const outcome = await runCampaign({
      scenarios: scenarioIds(["A01"]),
      providerInfo: cloudInfo,
      outDir,
      runId: "run-cloud",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });

    const report = await readJson(join(outcome.runDir, "results.json"));
    expect(report.provider.nonDeterministic).toBe(true);
    expect(report.provider.modelVersion).toBe("mistral-small-latest");

    const summary = await readFile(join(outcome.runDir, "summary.md"), "utf8");
    expect(summary).toContain("Non déterminisme : **oui**");
    expect(summary).toContain("mistral-byok");
  });

  it(" exécute les scénarios sans override avec le fournisseur injecté (F01 hors ligne)", async () => {
    const recipeJson = JSON.stringify({
      title: "Poulet au curry au riz basmati",
      servings: 4,
      ingredients: [
        { name: "filets de poulet", quantity: 600, unit: "g" },
        { name: "poudre de curry", quantity: 30, unit: "g" },
        { name: "lait de coco", quantity: 400, unit: "ml" },
      ],
      steps: ["Cuire le poulet.", "Ajouter le lait de coco et le curry."],
    });
    let calls = 0;
    const provider: ModelProvider = {
      id: "webgpu-base",
      modelVersion: "test-model@main",
      capabilities: { toolCalling: false, streaming: false },
      generate: async (): Promise<GenerateResponse> => {
        calls++;
        return { text: recipeJson, finishReason: "stop" };
      },
    };

    const outDir = await makeTempDir();
    const outcome = await runCampaign({
      scenarios: scenarioIds(["F01"]),
      provider,
      providerInfo: {
        id: "webgpu-base",
        label: PROVIDER_CONFIGS["webgpu-base"].label,
        modelVersion: "test-model@main",
        nonDeterministic: false,
      },
      outDir,
      runId: "run-injected",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });

    expect(calls).toBe(1);
    const report = await readJson(join(outcome.runDir, "results.json"));
    const record = report.scenarios[0];
    expect(record.id).toBe("F01");
    // La trace enregistre la sortie du fournisseur injecté (sanitisée).
    const traceText = JSON.stringify(record.trace);
    expect(traceText).toContain("Poulet au curry au riz basmati");
  });

  it(" n'écrit pas de score global dans le summary.md d'un run simulé complet", async () => {
    const outDir = await makeTempDir();
    const outcome = await runCampaign({
      scenarios: SCENARIOS.slice(0, 2),
      providerInfo: SIMULATED_INFO,
      outDir,
      runId: "run-noaggregate",
      generationParams: PINNED_PARAMS,
      now: stepClock(),
    });
    const summary = await readFile(join(outcome.runDir, "summary.md"), "utf8");
    expect(summary).toContain("# Campagne — run-noaggregate");
    expect(summary).toContain("| Scénario | Statut |");
    expect(summary.toLowerCase()).not.toContain("score");
  });
});
