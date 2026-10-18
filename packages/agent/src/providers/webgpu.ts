/**
 * WebGPU-EXCLUSIVE local model provider (spec issue #49).
 *
 * The local base model runs on WebGPU or does not run: there is NO CPU/WASM
 * fallback path anywhere in this module — the `device` option handed to the
 * pipeline factory is the literal "webgpu" and cannot be overridden.
 *
 * Availability is checked at launch (first generate), never at import or
 * construction time: nothing runs at module scope and there is no network
 * access here. The probe must verify real session-creation capability beyond
 * the mere presence of `navigator.gpu` (adapter request); it is injectable so
 * tests stay fully offline. If the probe or the session creation fails, the
 * provider throws ProviderUnavailableError with a French diagnostic and —
 * without ever calling it — proposes Mistral BYOK as a consent-only
 * alternative (provider id "mistral-byok").
 *
 * The Transformers.js pipelineFactory adapter for the Node harness will live
 * in @leclerc/harness (opt-in command `npm run test:harness:local`); this
 * module only defines the seam so it stays dependency-free.
 */

import {
  ProviderUnavailableError,
  type GenerateRequest,
  type GenerateResponse,
  type ModelCapabilities,
  type ModelProvider,
  type ProviderMessage,
  type ProviderProposal,
  type ProviderToolSpec,
} from "../provider.js";

/** Target handed to a probe: the model to check and the pinned device. */
export interface WebGpuProbeTarget {
  modelId: string;
  revision?: string;
  /** Hardcoded: probes only ever run against a WebGPU device. */
  device: "webgpu";
}

export interface WebGpuProbeResult {
  ok: boolean;
  /** Failure reason when ok is false — included in the user-facing diagnostic. */
  reason?: string;
}

/**
 * Verifies that a real WebGPU session can be created for the model — beyond
 * mere `navigator.gpu` presence (at minimum an adapter request). Injectable.
 */
export type WebGpuProbe = (target: WebGpuProbeTarget) => Promise<WebGpuProbeResult>;

export interface WebGpuPipelineInput {
  messages: ProviderMessage[];
  tools?: ProviderToolSpec[];
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface WebGpuPipelineOutput {
  text: string;
}

/** One loaded model session — the harness adapter implements it with Transformers.js. */
export interface WebGpuPipeline {
  generate(input: WebGpuPipelineInput): Promise<WebGpuPipelineOutput>;
}

export interface WebGpuPipelineOptions {
  modelId: string;
  revision?: string;
  /** Hardcoded: no CPU/WASM device configuration can be constructed. */
  device: "webgpu";
}

/** Creates the model session — injectable so tests stay offline. */
export type WebGpuPipelineFactory = (options: WebGpuPipelineOptions) => Promise<WebGpuPipeline>;

/** Pinned generation defaults for deterministic scenarios (temperature 0, seed 0…). */
export interface WebGpuGenerationParams {
  temperature?: number;
  seed?: number;
  maxTokens?: number;
}

export interface WebGpuProviderOptions {
  modelId: string;
  revision?: string;
  probe: WebGpuProbe;
  pipelineFactory: WebGpuPipelineFactory;
  generationParams?: WebGpuGenerationParams;
}

interface NavigatorGpuLike {
  requestAdapter(options?: { powerPreference?: "default" | "low-power" | "high-performance" }): Promise<unknown>;
}

/**
 * Probe for browser contexts: checks WebGPU beyond `navigator.gpu` presence by
 * requesting a real adapter. Access to `navigator` is lazy (call time, never
 * module scope). The deeper session-creation check happens by actually
 * creating the pipeline in `createWebGpuProvider`.
 */
export function createNavigatorGpuProbe(): WebGpuProbe {
  return async (target: WebGpuProbeTarget): Promise<WebGpuProbeResult> => {
    const gpu = (globalThis as { navigator?: { gpu?: NavigatorGpuLike } }).navigator?.gpu;
    if (!gpu) {
      return { ok: false, reason: "WebGPU n'est pas exposé par cet environnement (navigator.gpu absent)." };
    }
    let adapter: unknown;
    try {
      adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    } catch (error) {
      return {
        ok: false,
        reason: `La demande d'adaptateur WebGPU a échoué : ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!adapter) {
      return { ok: false, reason: "Aucun adaptateur WebGPU disponible (matériel ou pilote non compatible)." };
    }
    return { ok: true };
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mistralProposal(reason: string): ProviderProposal {
  return {
    providerId: "mistral-byok",
    label: "Mistral (clé personnelle)",
    consentRequired: true,
    reason,
  };
}

export class WebGpuProvider implements ModelProvider {
  readonly id: string;
  readonly modelVersion: string;
  readonly capabilities: ModelCapabilities = { toolCalling: false, streaming: false };

  /** Number of generate() calls served — asserted by safety scenarios. */
  calls = 0;

  private pipeline: WebGpuPipeline | undefined;

  constructor(private readonly options: WebGpuProviderOptions) {
    this.id = `webgpu:${options.modelId}`;
    this.modelVersion = options.revision ? `${options.modelId}@${options.revision}` : options.modelId;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (request.signal?.aborted) {
      return { finishReason: "cancelled" };
    }
    if (!this.pipeline) {
      this.pipeline = await this.launch();
    }
    this.calls++;
    const defaults = this.options.generationParams ?? {};
    let output: WebGpuPipelineOutput;
    try {
      output = await this.pipeline.generate({
        messages: request.messages,
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : defaults.temperature !== undefined
            ? { temperature: defaults.temperature }
            : {}),
        ...(request.seed !== undefined
          ? { seed: request.seed }
          : defaults.seed !== undefined
            ? { seed: defaults.seed }
            : {}),
        ...(request.maxTokens !== undefined
          ? { maxTokens: request.maxTokens }
          : defaults.maxTokens !== undefined
            ? { maxTokens: defaults.maxTokens }
            : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      return {
        finishReason: "error",
        text: `Échec de génération WebGPU : ${describeError(error)}`,
      };
    }
    return { text: output.text, finishReason: "stop" };
  }

  /**
   * Launch gate: probe, then create the session. Any failure leaves the local
   * model NOT launched and throws — no CPU/WASM fallback ever executes.
   */
  private async launch(): Promise<WebGpuPipeline> {
    const target: WebGpuProbeTarget = {
      modelId: this.options.modelId,
      ...(this.options.revision !== undefined ? { revision: this.options.revision } : {}),
      device: "webgpu",
    };
    const probeResult = await this.options.probe(target);
    if (!probeResult.ok) {
      throw new ProviderUnavailableError(
        "WebGPU indisponible",
        `WebGPU est indisponible sur cette machine : ${probeResult.reason ?? "sonde en échec"}. ` +
          "Le modèle local n'est pas lancé et aucun repli CPU/WASM n'est prévu (WebGPU exclusif). " +
          "Alternative possible : Mistral avec votre clé personnelle, uniquement sur sélection explicite de votre part.",
        mistralProposal("WebGPU indisponible sur cette machine"),
      );
    }
    try {
      return await this.options.pipelineFactory({
        modelId: this.options.modelId,
        ...(this.options.revision !== undefined ? { revision: this.options.revision } : {}),
        device: "webgpu",
      });
    } catch (error) {
      throw new ProviderUnavailableError(
        "Session WebGPU impossible",
        `La session WebGPU du modèle local (${this.options.modelId}) n'a pas pu être créée : ${describeError(error)}. ` +
          "Le modèle local n'est pas lancé et aucun repli CPU/WASM n'est prévu (WebGPU exclusif). " +
          "Alternative possible : Mistral avec votre clé personnelle, uniquement sur sélection explicite de votre part.",
        mistralProposal("Création de session WebGPU impossible"),
      );
    }
  }
}

export function createWebGpuProvider(options: WebGpuProviderOptions): ModelProvider {
  return new WebGpuProvider(options);
}
