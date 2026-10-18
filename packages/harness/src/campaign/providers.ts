/**
 * Campaign provider configurations (tickets #46/#56, spec issue #40).
 *
 * Four configurations sit behind the ModelProvider seam — the simulated
 * offline model, Mistral BYOK (cloud), the WebGPU base model and the WebGPU
 * fine-tuned model. None of them is ever selected implicitly:
 *
 *   - `simulated` is the ONLY default (fully offline, no gate);
 *   - `mistral-byok` requires the explicit `--provider mistral` choice AND
 *     MISTRAPI_KEY in the environment — a missing key refuses the run, it
 *     NEVER falls back to another provider;
 *   - the WebGPU configurations require the same explicit opt-in as the POC
 *     runner (MCP_LECLERC_RUN_LOCAL=1), a VALIDATED model manifest
 *     (manifest-driven model ids — docs/poc/model-selection.md documents the
 *     pending execution status) and a successful WebGPU probe before the
 *     provider is constructed; there is no CPU/WASM fallback path.
 *
 * Cloud providers are flagged nonDeterministic: the campaign report states
 * it so a base/fine-tuned/Mistral comparison never claims determinism it
 * does not have.
 */

import {
  createMistralByokProvider,
  createWebGpuProvider,
  SimulatedProvider,
  validateModelManifest,
  type MistralFetch,
  type ModelProvider,
  type WebGpuPipeline,
  type WebGpuPipelineFactory,
  type WebGpuProbe,
} from "@leclerc/agent";

/** The four comparison configurations of spec issue #40 / ticket #56. */
export type ProviderConfigId = "simulated" | "mistral-byok" | "webgpu-base" | "webgpu-finetuned";

/** What a CLI user may request; each maps to exactly one configuration. */
export type RequestedProvider = "simulated" | "mistral" | "webgpu";

/** Identity of the provider a campaign ran with, recorded in every report. */
export interface ProviderIdentity {
  /** Configuration id, e.g. "mistral-byok" or "webgpu-finetuned". */
  id: string;
  /** French label for reports, e.g. "Mistral BYOK (cloud)". */
  label: string;
  /** Model/version identity (provider modelVersion). */
  modelVersion: string;
  /** True for cloud providers — stated in summary.md (ticket #56). */
  nonDeterministic: boolean;
}

/** One versioned provider configuration and its explicit construction rules. */
export interface ProviderConfig {
  readonly id: ProviderConfigId;
  /** French label for reports. */
  readonly label: string;
  /** True when cloud-backed: results are not byte-reproducible. */
  readonly nonDeterministic: boolean;
  /** True when the configuration can NEVER be the implicit default. */
  readonly explicitSelectionOnly: boolean;
  /** Opt-in environment gate required before anything executes. */
  readonly optInEnv?: string;
  /** True when construction refuses to run without a validated manifest. */
  readonly requiresManifest: boolean;
  /** French construction rule, recorded in reports for auditability. */
  readonly constructionRule: string;
}

export const PROVIDER_CONFIGS: Readonly<Record<ProviderConfigId, ProviderConfig>> = {
  simulated: {
    id: "simulated",
    label: "Modèle simulé scripté (hors ligne)",
    nonDeterministic: false,
    explicitSelectionOnly: false,
    requiresManifest: false,
    constructionRule:
      "Défaut implicite : construction locale hors ligne d'un SimulatedProvider scripté, aucune clé, aucun réseau.",
  },
  "mistral-byok": {
    id: "mistral-byok",
    label: "Mistral BYOK (cloud)",
    nonDeterministic: true,
    explicitSelectionOnly: true,
    requiresManifest: false,
    constructionRule:
      "Sélection explicite --provider mistral ET MISTRAPI_KEY dans l'environnement ; sans clé, le run est refusé, jamais de repli.",
  },
  "webgpu-base": {
    id: "webgpu-base",
    label: "Modèle local WebGPU de base (manifeste)",
    nonDeterministic: false,
    explicitSelectionOnly: true,
    optInEnv: "MCP_LECLERC_RUN_LOCAL",
    requiresManifest: true,
    constructionRule:
      "Opt-in MCP_LECLERC_RUN_LOCAL=1 + manifeste validé + sonde WebGPU réussie ; identifiant de modèle issu du manifeste, aucun repli CPU/WASM.",
  },
  "webgpu-finetuned": {
    id: "webgpu-finetuned",
    label: "Modèle local WebGPU fine-tuné (manifeste)",
    nonDeterministic: false,
    explicitSelectionOnly: true,
    optInEnv: "MCP_LECLERC_RUN_LOCAL",
    requiresManifest: true,
    constructionRule:
      "Opt-in MCP_LECLERC_RUN_LOCAL=1 + manifeste validé + sonde WebGPU réussie ; identifiant de modèle issu du manifeste, aucun repli CPU/WASM.",
  },
};

/** Environment variable selecting base vs fine-tuned for --provider webgpu. */
export const WEBGPU_CONFIG_ENV = "MCP_LECLERC_CAMPAIGN_WEBGPU_CONFIG";

/** Environment variable carrying the Mistral BYOK key. */
export const MISTRAL_KEY_ENV = "MISTRAPI_KEY";

/** Default Mistral model when the environment does not pin one. */
const DEFAULT_MISTRAL_MODEL = "mistral-small-latest";

export type ProviderResolution =
  | { ok: true; configId: ProviderConfigId }
  | { ok: false; diagnostic: string };

/**
 * Maps a CLI request to one configuration, applying the explicit-selection
 * rules: the default is ALWAYS simulated (offline), mistral needs its flag
 * AND the key, webgpu needs its flag AND the opt-in gate. A refusal carries
 * a French diagnostic and no fallback.
 */
export function resolveProviderConfig(
  requested: RequestedProvider | undefined,
  env: Record<string, string | undefined>,
): ProviderResolution {
  if (requested === undefined || requested === "simulated") {
    return { ok: true, configId: "simulated" };
  }
  if (requested === "mistral") {
    if (!env[MISTRAL_KEY_ENV]) {
      return {
        ok: false,
        diagnostic: `Fournisseur mistral refusé : ${MISTRAL_KEY_ENV} est absent de l'environnement. La sélection mistral est explicite et sans clé le run échoue — aucun repli ne sera tenté.`,
      };
    }
    return { ok: true, configId: "mistral-byok" };
  }
  // webgpu
  if (env[PROVIDER_CONFIGS["webgpu-base"].optInEnv ?? ""] !== "1") {
    return {
      ok: false,
      diagnostic:
        "Fournisseur webgpu refusé : l'exécution locale est strictement opt-in. " +
        "Posez MCP_LECLERC_RUN_LOCAL=1 pour accepter explicitement la sonde GPU et le chargement des poids.",
    };
  }
  const variant = env[WEBGPU_CONFIG_ENV] === "finetuned" ? "finetuned" : "base";
  return { ok: true, configId: variant === "finetuned" ? "webgpu-finetuned" : "webgpu-base" };
}

export interface CreateProviderDeps {
  configId: ProviderConfigId;
  env: Record<string, string | undefined>;
  /** Raw manifest value (webgpu configs) — validated before any use. */
  manifest?: unknown;
  /** Network seam for the Mistral provider (never called at construction). */
  fetchImpl?: MistralFetch;
  /** WebGPU probe — required for the webgpu configs. */
  probe?: WebGpuProbe;
  /** Model session factory — required for the webgpu configs. */
  pipelineFactory?: WebGpuPipelineFactory;
}

export type ProviderConstruction =
  | { ok: true; provider: ModelProvider; info: ProviderIdentity }
  | { ok: false; diagnostic: string };

/**
 * Constructs the campaign provider EXPLICITLY selected by resolveProviderConfig.
 * Every refusal is a typed {ok:false} outcome with a French diagnostic —
 * nothing runs, nothing is downloaded and no fallback is attempted.
 */
export async function createCampaignProvider(deps: CreateProviderDeps): Promise<ProviderConstruction> {
  const config = PROVIDER_CONFIGS[deps.configId];

  if (deps.configId === "simulated") {
    const provider = new SimulatedProvider({ script: [] });
    return {
      ok: true,
      provider,
      info: {
        id: config.id,
        label: config.label,
        modelVersion: provider.modelVersion,
        nonDeterministic: config.nonDeterministic,
      },
    };
  }

  if (deps.configId === "mistral-byok") {
    const apiKey = deps.env[MISTRAL_KEY_ENV];
    if (!apiKey) {
      return {
        ok: false,
        diagnostic: `Construction de mistral-byok refusée : ${MISTRAL_KEY_ENV} absent de l'environnement. Aucun repli.`,
      };
    }
    if (!deps.fetchImpl) {
      return {
        ok: false,
        diagnostic: "Construction de mistral-byok refusée : seam réseau (fetch) non fourni.",
      };
    }
    const model = deps.env["MCP_LECLERC_MISTRAL_MODEL"] ?? DEFAULT_MISTRAL_MODEL;
    const provider = createMistralByokProvider({ apiKey, model, fetchImpl: deps.fetchImpl });
    return {
      ok: true,
      provider,
      info: {
        id: config.id,
        label: config.label,
        modelVersion: model,
        nonDeterministic: config.nonDeterministic,
      },
    };
  }

  // webgpu-base / webgpu-finetuned: manifest-driven model ids, probe first.
  const validation = validateModelManifest(deps.manifest);
  if (!validation.ok) {
    return {
      ok: false,
      diagnostic:
        `Configuration ${config.id} refusée : aucun manifeste de modèle validé. ` +
        `Le comparatif webgpu exige un manifeste valide (identifiants de modèles pilotés par manifeste, ` +
        `exécution du POC encore en attente — voir docs/poc/model-selection.md). ` +
        `Problèmes : ${validation.issues.join(" ; ")}`,
    };
  }
  if (!deps.probe || !deps.pipelineFactory) {
    return {
      ok: false,
      diagnostic: `Configuration ${config.id} refusée : sonde WebGPU ou fabrique de pipeline manquante.`,
    };
  }

  const target = {
    modelId: validation.manifest.modelId,
    revision: validation.manifest.revision,
    device: "webgpu" as const,
  };
  const probeResult = await deps.probe(target);
  if (!probeResult.ok) {
    return {
      ok: false,
      diagnostic:
        `Configuration ${config.id} refusée : la sonde WebGPU a échoué — ${probeResult.reason ?? "raison inconnue"}. ` +
        "Le modèle local n'a pas été lancé et aucun repli CPU/WASM n'existe.",
    };
  }

  const provider = createWebGpuProvider({
    modelId: validation.manifest.modelId,
    revision: validation.manifest.revision,
    probe: deps.probe,
    pipelineFactory: deps.pipelineFactory,
  });
  return {
    ok: true,
    provider,
    info: {
      id: config.id,
      label: config.label,
      modelVersion: `${validation.manifest.modelId}@${validation.manifest.revision}`,
      nonDeterministic: config.nonDeterministic,
    },
  };
}

/** Type helper for tests: a minimal offline pipeline factory. */
export function fakePipelineFactory(text: string): WebGpuPipelineFactory {
  return async (): Promise<WebGpuPipeline> => ({
    generate: async () => ({ text }),
  });
}
