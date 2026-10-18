import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseCampaignArgs, runCampaignCli } from "../src/campaign/cli.js";
import { createCampaignProvider, type CreateProviderDeps } from "../src/campaign/providers.js";

const FAKE_KEY = "sk-CLIclitestfakefakeKEY1234567890";

let tempDirs: string[] = [];
afterAll(async () => {
  const fs = await import("node:fs/promises");
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "leclerc-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** Spy seam: observes which provider configurations get constructed. */
function providerSpy() {
  const calls: CreateProviderDeps[] = [];
  const create = async (deps: CreateProviderDeps) => {
    calls.push(deps);
    return createCampaignProvider(deps);
  };
  return { create, calls };
}

describe("analyse des arguments CLI (ticket #46)", () => {
  it(" accepte les valeurs par défaut : simulated hors ligne, runs/", () => {
    const parsed = parseCampaignArgs([]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.provider).toBeUndefined();
      expect(parsed.args.out).toBe("runs");
      expect(parsed.args.csv).toBeUndefined();
      expect(parsed.args.jsonl).toBeUndefined();
    }
  });

  it(" analyse --scenarios, --out, --provider, --csv, --jsonl, --run-id", () => {
    const parsed = parseCampaignArgs([
      "--scenarios",
      "A01,A05",
      "--out",
      "/tmp/x",
      "--provider",
      "mistral",
      "--csv",
      "--jsonl",
      "--run-id",
      "campagne-x",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.scenarios).toEqual(["A01", "A05"]);
      expect(parsed.args.out).toBe("/tmp/x");
      expect(parsed.args.provider).toBe("mistral");
      expect(parsed.args.csv).toBe(true);
      expect(parsed.args.jsonl).toBe(true);
      expect(parsed.args.runId).toBe("campagne-x");
    }
  });

  it(" refuse un drapeau inconnu ou une valeur de fournisseur invalide", () => {
    expect(parseCampaignArgs(["--inconnu"]).ok).toBe(false);
    const bad = parseCampaignArgs(["--provider", "openai"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.diagnostic).toContain("simulated|mistral|webgpu");
  });
});

describe("CLI de campagne : sélection explicite uniquement (tickets #46/#56)", () => {
  it(" exécute un run simulé complet hors ligne et écrit runs/<runId>/", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const outcome = await runCampaignCli(["--scenarios", "A01,F01", "--out", outDir], {
      env: {},
      now: () => new Date("2026-10-18T12:00:00.000Z").getTime(),
      createProvider: spy.create,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.runDir).toBe(join(outDir, "campaign-2026-10-18T12-00-00-000Z"));
    const files = await readdir(outcome.runDir);
    expect(files).toContain("results.json");
    expect(files).toContain("summary.md");

    // Simulated est le défaut ; aucune configuration cloud n'est construite.
    expect(spy.calls.map((deps) => deps.configId)).toEqual(["simulated"]);
  });

  it(" ignore mistral tant que --provider mistral est absent, même avec MISTRAPI_KEY", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const outcome = await runCampaignCli(["--scenarios", "A01", "--out", outDir], {
      env: { MISTRAPI_KEY: FAKE_KEY },
      createProvider: spy.create,
    });
    expect(outcome.exitCode).toBe(0);
    expect(spy.calls.map((deps) => deps.configId)).toEqual(["simulated"]);
    expect(spy.calls.every((deps) => deps.configId !== "mistral-byok")).toBe(true);
  });

  it(" refuse --provider mistral sans MISTRAPI_KEY : aucun run, aucun repli", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const outcome = await runCampaignCli(["--provider", "mistral", "--out", outDir], {
      env: {},
      createProvider: spy.create,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.runDir).toBeUndefined();
    expect(outcome.lines.join("\n")).toContain("MISTRAPI_KEY");
    expect(spy.calls).toEqual([]);
  });

  it(" construit mistral uniquement avec le drapeau explicite ET la clé", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const recipeJson = JSON.stringify({
      title: "Poulet au curry au riz basmati",
      servings: 4,
      ingredients: [{ name: "filets de poulet", quantity: 600, unit: "g" }],
      steps: ["Cuire le poulet."],
    });
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: recipeJson }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    }));
    const outcome = await runCampaignCli(
      ["--provider", "mistral", "--scenarios", "F01", "--out", outDir],
      {
        env: { MISTRAPI_KEY: FAKE_KEY },
        fetchImpl: fetchImpl as never,
        createProvider: spy.create,
      },
    );
    expect(outcome.exitCode).toBe(0);
    expect(spy.calls.map((deps) => deps.configId)).toEqual(["mistral-byok"]);
    expect(fetchImpl).toHaveBeenCalled();

    // Aucune clé ne fuite dans les fichiers produits (BLOCKING).
    const results = await readFile(join(outcome.runDir!, "results.json"), "utf8");
    expect(results).not.toContain(FAKE_KEY);
  });

  it(" refuse webgpu sans l'opt-in MCP_LECLERC_RUN_LOCAL=1 : rien n'est construit", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const outcome = await runCampaignCli(["--provider", "webgpu", "--out", outDir], {
      env: {},
      createProvider: spy.create,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join("\n")).toContain("MCP_LECLERC_RUN_LOCAL");
    expect(spy.calls).toEqual([]);
  });

  it(" refuse webgpu sans manifeste validé même avec l'opt-in", async () => {
    const outDir = await makeTempDir();
    const spy = providerSpy();
    const outcome = await runCampaignCli(["--provider", "webgpu", "--out", outDir], {
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      createProvider: spy.create,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join("\n")).toContain("manifeste");
    // Le refus vient de la construction elle-même : la configuration
    // webgpu-base est bien demandée, puis refusée sans manifeste validé.
    expect(spy.calls.map((deps) => deps.configId)).toEqual(["webgpu-base"]);
  });

  it(" refuse un identifiant de scénario inconnu", async () => {
    const outDir = await makeTempDir();
    const outcome = await runCampaignCli(["--scenarios", "A01,Z99", "--out", outDir], {
      env: {},
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join("\n")).toContain("Z99");
  });
});
