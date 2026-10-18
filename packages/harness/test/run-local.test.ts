import { describe, expect, it, vi } from "vitest";
import type { WebGpuPipeline, WebGpuPipelineFactory } from "@leclerc/agent";
import { runLocalPoc, POC_PROMPT_A01, type PocRunReport } from "../src/poc/run-local.js";

const VALID_RECIPE_JSON = JSON.stringify({
  title: "Poulet au curry sans crème",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 600, unit: "g" },
    { name: "lait de coco", quantity: 400, unit: "ml" },
  ],
  steps: ["Cuire le poulet.", "Ajouter le lait de coco et le curry."],
});

const FIXED_NOW = new Date("2026-10-18T12:00:00.000Z").getTime();

function okProbe() {
  return vi.fn(async () => ({ ok: true }));
}

function failingProbe(reason: string) {
  return vi.fn(async () => ({ ok: false, reason }));
}

/** Fake pipeline factory: records options, returns scripted text. */
function fakePipelineFactory(options: {
  text: string;
  error?: Error;
  devices: Array<string>;
}) {
  const generate = vi.fn(async () =>
    options.error ? Promise.reject(options.error) : { text: options.text },
  );
  const factory = vi.fn(async (opts: { device: string }): Promise<WebGpuPipeline> => {
    options.devices.push(opts.device);
    return { generate };
  });
  return { factory: factory as unknown as WebGpuPipelineFactory, generate };
}

function makeDeps(overrides: {
  env?: Record<string, string | undefined>;
  probe?: ReturnType<typeof okProbe>;
  factory?: WebGpuPipelineFactory;
}) {
  const written: Array<{ path: string; content: string }> = [];
  const deps = {
    env: { MCP_LECLERC_RUN_LOCAL: "1", ...overrides.env },
    probe: overrides.probe ?? okProbe(),
    pipelineFactory:
      overrides.factory ?? fakePipelineFactory({ text: VALID_RECIPE_JSON, devices: [] }).factory,
    now: () => FIXED_NOW,
    writeReport: vi.fn(async (path: string, content: string) => {
      written.push({ path, content });
    }),
    reportDir: "runs",
  };
  return { deps, written };
}

describe("opt-in gate (issue #47)", () => {
  it("exits non-zero with a French explanation when MCP_LECLERC_RUN_LOCAL is not set", async () => {
    const { deps, written } = makeDeps({ env: { MCP_LECLERC_RUN_LOCAL: undefined } });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).not.toBe(0);
    const summary = outcome.summary.join("\n");
    expect(summary).toContain("MCP_LECLERC_RUN_LOCAL=1");
    expect(summary.toLowerCase()).toContain("opt-in");
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.writeReport).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it("exits non-zero when the env var is set to something other than 1", async () => {
    const { deps } = makeDeps({ env: { MCP_LECLERC_RUN_LOCAL: "0" } });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).not.toBe(0);
  });
});

describe("WebGPU probe (issue #47)", () => {
  it("exits non-zero with the diagnostic and never builds a pipeline when the probe fails", async () => {
    const devices: string[] = [];
    const { factory } = fakePipelineFactory({ text: VALID_RECIPE_JSON, devices });
    const { deps } = makeDeps({
      probe: failingProbe("WebGPU n'est pas exposé par cet environnement (navigator.gpu absent)."),
      factory,
    });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).not.toBe(0);
    const summary = outcome.summary.join("\n");
    expect(summary).toContain("navigator.gpu absent");
    expect(summary).toContain("aucun repli CPU/WASM");
    expect(summary).toContain("Mistral");
    expect(factory).not.toHaveBeenCalled();
    expect(devices).toHaveLength(0);
    expect(deps.writeReport).not.toHaveBeenCalled();
  });

  it("exits non-zero without writing a report when the pipeline generate itself fails", async () => {
    const { factory } = fakePipelineFactory({
      text: "",
      error: new Error("session WebGPU perdue"),
      devices: [],
    });
    const { deps } = makeDeps({ factory });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).not.toBe(0);
    expect(deps.writeReport).not.toHaveBeenCalled();
  });
});

describe("successful opt-in local run (issue #47)", () => {
  it("always constructs the pipeline with device webgpu and runs the frozen A01 prompt", async () => {
    const devices: string[] = [];
    const { factory, generate } = fakePipelineFactory({ text: VALID_RECIPE_JSON, devices });
    const { deps } = makeDeps({ factory });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).toBe(0);
    expect(devices).toEqual(["webgpu"]);
    expect(devices.every((d) => d === "webgpu")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const user = input.messages.find((m) => m.role === "user");
    expect(user?.content).toBe(POC_PROMPT_A01);
    expect(input.temperature).toBe(0);
    expect(input.seed).toBe(0);
    expect(input.maxTokens).toBe(1024);
  });

  it("writes a verifiable JSON report to runs/ with model, timings, raw output and recipe validity", async () => {
    const { deps, written } = makeDeps({});
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    const { path, content } = written[0];
    expect(path).toMatch(/^runs\/poc-\d{4}-\d{2}-\d{2}T.*\.json$/);
    const report: PocRunReport = JSON.parse(content);
    expect(report.kind).toBe("poc-webgpu-model-selection");
    expect(report.ticket).toBe(47);
    expect(report.model.device).toBe("webgpu");
    expect(typeof report.model.id).toBe("string");
    expect(report.model.id.length).toBeGreaterThan(0);
    expect(typeof report.model.revision).toBe("string");
    expect(typeof report.model.dtype).toBe("string");
    expect(report.generation).toEqual({ temperature: 0, seed: 0, maxTokens: 1024 });
    expect(typeof report.loadMs).toBe("number");
    expect(typeof report.generationMs).toBe("number");
    expect(report.rawOutput).toBe(VALID_RECIPE_JSON);
    expect(report.recipe.valid).toBe(true);
    expect(outcome.reportPath).toBe(path);
  });

  it("records recipe invalidity (with issues) without failing the run itself", async () => {
    const { factory } = fakePipelineFactory({ text: "voici une recette { pas json", devices: [] });
    const { deps, written } = makeDeps({ factory });
    const outcome = await runLocalPoc(deps);
    expect(outcome.exitCode).toBe(0);
    const report: PocRunReport = JSON.parse(written[0].content);
    expect(report.recipe.valid).toBe(false);
    expect(report.recipe.issues?.length).toBeGreaterThan(0);
  });

  it("lets the environment override the candidate model id, revision and dtype", async () => {
    const devices: string[] = [];
    const { factory } = fakePipelineFactory({ text: VALID_RECIPE_JSON, devices });
    const { deps, written } = makeDeps({
      factory,
      env: {
        MCP_LECLERC_RUN_LOCAL: "1",
        MCP_LECLERC_POC_MODEL_ID: "onnx-community/Qwen2.5-1.5B-Instruct",
        MCP_LECLERC_POC_REVISION: "abc123",
        MCP_LECLERC_POC_DTYPE: "fp32",
      },
    });
    await runLocalPoc(deps);
    const report: PocRunReport = JSON.parse(written[0].content);
    expect(report.model.id).toBe("onnx-community/Qwen2.5-1.5B-Instruct");
    expect(report.model.revision).toBe("abc123");
    expect(report.model.dtype).toBe("fp32");
  });
});
