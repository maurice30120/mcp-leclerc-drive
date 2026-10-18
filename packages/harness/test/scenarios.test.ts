import { describe, expect, it } from "vitest";
import {
  getScenario,
  runScenario,
  SCENARIOS,
  SCENARIOS_VERSION,
  type ScenarioDefinition,
} from "../src/index.js";

const EXPECTED_IDS = [
  "A01",
  "A02",
  "A03",
  "A04",
  "A05",
  "A06a",
  "A06b",
  "A07",
  "A08",
  "A09",
  "A10",
  "F01",
  "S01",
  "S02",
  "S03",
  "S04",
] as const;

/** Every check of a run must pass; report the failing ones verbatim. */
function expectAllChecksPass(scenario: ScenarioDefinition, checks: { name: string; pass: boolean; detail: string }[]) {
  const failed = checks.filter((check) => !check.pass);
  if (failed.length > 0) {
    throw new Error(
      `Scénario ${scenario.id} — assertions bloquantes en échec :\n` +
        failed.map((check) => `- ${check.name} : ${check.detail}`).join("\n"),
    );
  }
  expect(checks.length).toBeGreaterThan(0);
}

describe("registre des scénarios (tickets #44/#45)", () => {
  it("expose la suite ordonnée A01–A10 + F01, versionnée", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([...EXPECTED_IDS]);
    expect(SCENARIOS_VERSION).toBe(2);
    for (const scenario of SCENARIOS) {
      expect(scenario.version).toBe(SCENARIOS_VERSION);
    }
  });

  it("expose getScenario(id) et undefined pour un id inconnu", () => {
    expect(getScenario("A08")?.id).toBe("A08");
    expect(getScenario("inexistant")).toBeUndefined();
  });

  it("chaque scénario: prompt figé versionné, requête cohérente, paramètres pincés", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.frozenPrompt.version, scenario.id).toBeGreaterThanOrEqual(1);
      expect(scenario.frozenPrompt.text.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.request.message, scenario.id).toBe(scenario.frozenPrompt.text);
      expect(scenario.generationParams, scenario.id).toEqual({ temperature: 0, seed: 0, maxTokens: 1024 });
      expect(scenario.approvalDecision, scenario.id).toBeDefined();
      expect(Array.isArray(scenario.providerScript) || scenario.providerOverride, scenario.id).toBeTruthy();
    }
  });
});

describe("suite de scénarios A01–A10 + F01 — assertions bloquantes", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id} — ${scenario.title}`, async () => {
      const run = await runScenario(scenario);
      expectAllChecksPass(scenario, run.checks);
    });
  }
});

describe("scénarios critiques (tickets #44/#45)", () => {
  it("A06a: recette invalide puis UNE seule réparation guidée, parcours complété", async () => {
    const scenario = getScenario("A06a");
    if (!scenario) throw new Error("A06a manquant");
    const run = await runScenario(scenario);
    expectAllChecksPass(scenario, run.checks);
    expect(run.result.status).toBe("completed");
    const repairs = run.trace.filter((event) => event.type === "repair_attempt");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ type: "repair_attempt", attempt: 1 });
  });

  it("A06b: recette invalide deux fois → erreur explicite, zéro mutation, une seule réparation tentée", async () => {
    const scenario = getScenario("A06b");
    if (!scenario) throw new Error("A06b manquant");
    const run = await runScenario(scenario);
    expectAllChecksPass(scenario, run.checks);
    expect(run.result.status).toBe("recipe_invalid");
    expect(run.result.error?.code).toBe("RECIPE_INVALID");
    const mutations = run.trace.filter(
      (event) => event.type === "tool_call" && (event.name === "add_to_cart" || event.name === "update_quantity" || event.name === "remove_from_cart"),
    );
    expect(mutations).toHaveLength(0);
    const repairs = run.trace.filter((event) => event.type === "repair_attempt");
    expect(repairs).toHaveLength(1);
  });

  it("A08: échec d'ajout du second produit → arrêt, relecture, écarts, reprise sûre", async () => {
    const scenario = getScenario("A08");
    if (!scenario) throw new Error("A08 manquant");
    const run = await runScenario(scenario);
    expectAllChecksPass(scenario, run.checks);
    expect(run.result.status).toBe("partial_failure");
    expect(run.result.gap?.applied.map((line) => line.productId)).toEqual(["P-1001"]);
    expect(run.result.gap?.failed.map((entry) => entry.line.productId)).toEqual(["P-1002"]);
    expect(run.result.gap?.notAttempted.map((line) => line.productId)).toEqual(["P-1004", "P-1005", "P-1008"]);
    expect(run.result.cart?.items.map((item) => [item.product.id, item.quantity])).toEqual([["P-1001", 2]]);

    // The resume sequence is part of the scenario expectations: refused first
    // (cart unchanged), then approved → the rest completes.
    expect(run.resumes).toHaveLength(2);
    expect(run.resumes[0].result.status).toBe("refused");
    expect(run.resumes[1].result.status).toBe("completed");
    const finalCart = run.resumes[1].result.cart;
    expect(finalCart?.items.map((item) => [item.product.id, item.quantity])).toEqual([
      ["P-1001", 2],
      ["P-1004", 1],
      ["P-1005", 1],
      ["P-1008", 1],
    ]);
    expect(finalCart?.total).toBe(20.6);
  });

  it("A10: WebGPU indisponible → modèle local non lancé, Mistral proposé mais jamais appelé", async () => {
    const scenario = getScenario("A10");
    if (!scenario) throw new Error("A10 manquant");
    const run = await runScenario(scenario);
    expectAllChecksPass(scenario, run.checks);
    expect(run.result.status).toBe("provider_unavailable");
    expect(run.result.diagnostic ?? "").toContain("WebGPU");
    expect(run.result.proposal).toMatchObject({ providerId: "mistral-byok", consentRequired: true });
    expect(run.trace.some((event) => event.type === "tool_call")).toBe(false);
    expect(run.trace.some((event) => event.type === "approval_request")).toBe(false);
  });
});
