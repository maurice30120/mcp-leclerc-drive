import { describe, expect, it, vi } from "vitest";
import {
  createCampaignProvider,
  PROVIDER_CONFIGS,
  resolveProviderConfig,
  type ProviderConfigId,
} from "../src/campaign/providers.js";

const FAKE_KEY = "sk-TESTtesttesttesttestKEY1234567890";

const VALID_MANIFEST = {
  formatVersion: 1,
  modelId: "onnx-community/test-0.6B-ONNX",
  revision: "main",
  tokenizer: "tokenizer.json",
  files: [{ path: "model.onnx", sizeBytes: 1000 }],
  totalSizeBytes: 1000,
  dtype: "q4",
  format: "onnx",
  trainingProvenance: { baseModel: "Qwen/Qwen3-0.6B", method: "full" },
  license: "Apache-2.0",
  sourceUrl: "https://huggingface.co/onnx-community/test-0.6B-ONNX/resolve/main/",
};

describe("configurations de fournisseurs (ticket #56)", () => {
  it(" définit les quatre configurations avec leurs règles explicites", () => {
    expect(Object.keys(PROVIDER_CONFIGS).sort()).toEqual([
      "mistral-byok",
      "simulated",
      "webgpu-base",
      "webgpu-finetuned",
    ]);
    const simulated = PROVIDER_CONFIGS["simulated"];
    expect(simulated.explicitSelectionOnly).toBe(false);
    expect(simulated.nonDeterministic).toBe(false);

    const mistral = PROVIDER_CONFIGS["mistral-byok"];
    expect(mistral.explicitSelectionOnly).toBe(true);
    expect(mistral.nonDeterministic).toBe(true);
    expect(mistral.requiresManifest).toBe(false);

    for (const id of ["webgpu-base", "webgpu-finetuned"] as const) {
      const config = PROVIDER_CONFIGS[id];
      expect(config.explicitSelectionOnly).toBe(true);
      expect(config.requiresManifest).toBe(true);
      expect(config.optInEnv).toBe("MCP_LECLERC_RUN_LOCAL");
      expect(config.nonDeterministic).toBe(false);
    }
  });

  it(" résout simulated par défaut, hors ligne, sans prérequis", () => {
    const resolved = resolveProviderConfig(undefined, {});
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.configId).toBe("simulated");
  });

  it(" ne sélectionne jamais mistral par défaut, même avec la clé présente dans l'env", () => {
    const resolved = resolveProviderConfig(undefined, { MISTRAPI_KEY: FAKE_KEY });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.configId).toBe("simulated");
  });

  it(" refuse mistral explicite sans MISTRAPI_KEY (jamais de repli)", () => {
    const resolved = resolveProviderConfig("mistral", {});
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.diagnostic).toContain("MISTRAPI_KEY");
    }
  });

  it(" résout mistral explicite avec la clé", () => {
    const resolved = resolveProviderConfig("mistral", { MISTRAPI_KEY: FAKE_KEY });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.configId).toBe("mistral-byok");
  });

  it(" refuse webgpu sans l'opt-in MCP_LECLERC_RUN_LOCAL=1", () => {
    const resolved = resolveProviderConfig("webgpu", {});
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.diagnostic).toContain("MCP_LECLERC_RUN_LOCAL");
  });

  it(" résout webgpu avec l'opt-in (base par défaut, finetuned explicite)", () => {
    const base = resolveProviderConfig("webgpu", { MCP_LECLERC_RUN_LOCAL: "1" });
    expect(base.ok).toBe(true);
    if (base.ok) expect(base.configId).toBe("webgpu-base");

    const finetuned = resolveProviderConfig("webgpu", {
      MCP_LECLERC_RUN_LOCAL: "1",
      MCP_LECLERC_CAMPAIGN_WEBGPU_CONFIG: "finetuned",
    });
    expect(finetuned.ok).toBe(true);
    if (finetuned.ok) expect(finetuned.configId).toBe("webgpu-finetuned");
  });
});

describe("construction explicite des fournisseurs de campagne (tickets #46/#56)", () => {
  it(" construit le fournisseur simulé hors ligne", async () => {
    const built = await createCampaignProvider({ configId: "simulated", env: {} });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.provider.id).toBe("simulated");
      expect(built.info.id).toBe("simulated");
      expect(built.info.nonDeterministic).toBe(false);
      expect(built.info.modelVersion).toBe("simulated-1.0");
    }
  });

  it(" ne construit jamais mistral sans clé", async () => {
    const built = await createCampaignProvider({ configId: "mistral-byok", env: {} });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.diagnostic).toContain("MISTRAPI_KEY");
  });

  it(" construit mistral BYOK avec la clé, marqué non déterministe", async () => {
    const fetchImpl = vi.fn();
    const built = await createCampaignProvider({
      configId: "mistral-byok",
      env: { MISTRAPI_KEY: FAKE_KEY },
      fetchImpl: fetchImpl as never,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.provider.id).toBe("mistral-byok");
      expect(built.info.nonDeterministic).toBe(true);
      expect(built.info.modelVersion).toBe("mistral-small-latest");
      // La construction seule n'émet aucun appel réseau.
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it(" refuse webgpu sans manifeste validé, même avec l'opt-in", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    const built = await createCampaignProvider({
      configId: "webgpu-base",
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      probe: probe,
      pipelineFactory: vi.fn(async () => ({ generate: async () => ({ text: "" }) })),
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.diagnostic).toContain("manifeste");
    // Refus avant toute sonde : aucun GPU touché.
    expect(probe).not.toHaveBeenCalled();
  });

  it(" refuse webgpu avec un manifeste invalide", async () => {
    const probe = vi.fn(async () => ({ ok: true }));
    const built = await createCampaignProvider({
      configId: "webgpu-base",
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      manifest: { formatVersion: 99 },
      probe: probe,
      pipelineFactory: vi.fn(async () => ({ generate: async () => ({ text: "" }) })),
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.diagnostic).toContain("manifeste");
    expect(probe).not.toHaveBeenCalled();
  });

  it(" refuse webgpu quand la sonde échoue, avec un diagnostic clair, sans pipeline", async () => {
    const pipelineFactory = vi.fn(async () => ({ generate: async () => ({ text: "" }) }));
    const built = await createCampaignProvider({
      configId: "webgpu-base",
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      manifest: VALID_MANIFEST,
      probe: vi.fn(async () => ({ ok: false, reason: "GPU indisponible" })),
      pipelineFactory: pipelineFactory,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.diagnostic).toContain("GPU indisponible");
      expect(built.diagnostic).toContain("WebGPU");
    }
    expect(pipelineFactory).not.toHaveBeenCalled();
  });

  it(" construit webgpu avec opt-in + manifeste validé + sonde réussie", async () => {
    const pipelineFactory = vi.fn(async () => ({ generate: async () => ({ text: "ok" }) }));
    const built = await createCampaignProvider({
      configId: "webgpu-base",
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      manifest: VALID_MANIFEST,
      probe: vi.fn(async () => ({ ok: true })),
      pipelineFactory: pipelineFactory,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.info.modelVersion).toContain("onnx-community/test-0.6B-ONNX");
      expect(built.info.nonDeterministic).toBe(false);
    }
  });

  it(" distingue webgpu-base et webgpu-finetuned dans l'identité", async () => {
    const deps = {
      env: { MCP_LECLERC_RUN_LOCAL: "1" },
      manifest: VALID_MANIFEST,
      probe: vi.fn(async () => ({ ok: true }) as const),
      pipelineFactory: vi.fn(async () => ({ generate: async () => ({ text: "" }) })),
    };
    const base = await createCampaignProvider({ ...deps, configId: "webgpu-base" as ProviderConfigId });
    const finetuned = await createCampaignProvider({
      ...deps,
      configId: "webgpu-finetuned" as ProviderConfigId,
    });
    expect(base.ok && finetuned.ok).toBe(true);
    if (base.ok && finetuned.ok) {
      expect(base.info.id).toBe("webgpu-base");
      expect(finetuned.info.id).toBe("webgpu-finetuned");
      expect(base.info.label).not.toBe(finetuned.info.label);
    }
  });
});
