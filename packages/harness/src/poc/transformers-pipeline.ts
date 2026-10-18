/**
 * Real Transformers.js pipelineFactory adapter for createWebGpuProvider
 * (spec issue #40, ticket #47).
 *
 * The ONLY device value ever handed to Transformers.js is the literal
 * "webgpu" — there is no CPU/WASM fallback anywhere. The dynamic import of
 * @huggingface/transformers is lazy (first pipeline creation, never at module
 * scope), so importing this module has zero side effects and tests can mock
 * the dependency.
 *
 * This adapter does plain text generation: it does NOT implement native tool
 * calling (a `tools` input is not translated). Whether the base model can do
 * real tool calling is assessed separately via the Transformers.js ↔ Vercel AI
 * SDK integration described in docs/poc/model-selection.md; the fallback
 * design is the deterministic orchestration of the agent engine.
 */

import type {
  WebGpuPipeline,
  WebGpuPipelineFactory,
  WebGpuPipelineInput,
} from "@leclerc/agent";

/** Load and generation timings exposed for the POC report. */
export interface TransformersPipelineMetrics {
  /** Wall-clock ms spent creating the Transformers.js pipeline (model load). */
  loadMs: number;
  /** Wall-clock ms of the most recent generate call, undefined before the first. */
  lastGenerationMs: number | undefined;
}

export interface TransformersWebGpuPipeline extends WebGpuPipeline {
  readonly metrics: TransformersPipelineMetrics;
}

export interface TransformersPipelineFactoryConfig {
  /** ONNX dtype to load on the WebGPU device (e.g. "q4f16", "fp32"). */
  dtype: string;
}

/**
 * Extracts the assistant text from a Transformers.js text-generation output.
 * Handles both shapes seen across versions: a plain string, or the full
 * chat-template conversation (last assistant message).
 */
export function extractGeneratedText(output: unknown): string {
  if (Array.isArray(output) && output.length > 0) {
    const generated = (output[0] as { generated_text?: unknown } | undefined)?.generated_text;
    if (typeof generated === "string") {
      return generated;
    }
    if (Array.isArray(generated)) {
      const assistant = generated
        .slice()
        .reverse()
        .find((message) => (message as { role?: string } | undefined)?.role === "assistant") as
        | { content?: unknown }
        | undefined;
      if (typeof assistant?.content === "string") {
        return assistant.content;
      }
    }
    if (generated !== undefined) {
      return String(generated);
    }
  }
  return String(output);
}

interface TransformersChatMessage {
  role: string;
  content: string;
}

/** Minimal structural type of the dynamically imported module. */
interface TransformersModule {
  pipeline(
    task: "text-generation",
    modelId: string,
    options: { device: "webgpu"; dtype: string; revision?: string },
  ): Promise<{
    (messages: TransformersChatMessage[], options: Record<string, unknown>): Promise<unknown>;
  }>;
}

/**
 * Builds the real pipelineFactory wired into createWebGpuProvider by the
 * opt-in runner. `dtype` is POC configuration; the device is not configurable.
 */
export function createTransformersPipelineFactory(
  config: TransformersPipelineFactoryConfig,
): WebGpuPipelineFactory {
  return async (options): Promise<TransformersWebGpuPipeline> => {
    const loadStartedAt = Date.now();
    const { pipeline } = (await import("@huggingface/transformers")) as TransformersModule;
    const generate = await pipeline("text-generation", options.modelId, {
      device: "webgpu",
      dtype: config.dtype,
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
    });
    const metrics: TransformersPipelineMetrics = {
      loadMs: Date.now() - loadStartedAt,
      lastGenerationMs: undefined,
    };
    return {
      metrics,
      async generate(input: WebGpuPipelineInput) {
        const generationStartedAt = Date.now();
        const messages: TransformersChatMessage[] = input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        }));
        const output = await generate(messages, {
          ...(input.maxTokens !== undefined ? { max_new_tokens: input.maxTokens } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        });
        metrics.lastGenerationMs = Date.now() - generationStartedAt;
        return { text: extractGeneratedText(output) };
      },
    };
  };
}
