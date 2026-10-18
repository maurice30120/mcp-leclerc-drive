/**
 * Simulated model provider: deterministic, scripted, offline (spec issue #40).
 *
 * Used by the agent scenarios and the CI: responses are fixed in advance so
 * the orchestration, safety and error handling of the agent are exercised
 * reproducibly. Each generate() call consumes the next scripted step; an
 * exhausted script ends the conversation cleanly.
 */

import type {
  GenerateRequest,
  GenerateResponse,
  ModelCapabilities,
  ModelProvider,
  ToolCallRequest,
} from "../provider.js";

export type SimulatedStep =
  | { text: string }
  | { toolCalls: ToolCallRequest[] }
  | { text: string; toolCalls: ToolCallRequest[] }
  | { error: string };

export interface SimulatedProviderOptions {
  id?: string;
  modelVersion?: string;
  /** Scripted responses, consumed in order on each generate() call. */
  script: readonly SimulatedStep[];
  /** Instrumentation hook for tests (call counting, assertions). */
  onGenerate?: (request: GenerateRequest) => void;
}

export class SimulatedProvider implements ModelProvider {
  readonly id: string;
  readonly modelVersion: string;
  readonly capabilities: ModelCapabilities = { toolCalling: true, streaming: false };

  /** Number of generate() calls served — asserted by safety scenarios. */
  calls = 0;

  private next = 0;

  constructor(private readonly options: SimulatedProviderOptions) {
    this.id = options.id ?? "simulated";
    this.modelVersion = options.modelVersion ?? "simulated-1.0";
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.calls++;
    this.options.onGenerate?.(request);
    if (request.signal?.aborted) {
      return { finishReason: "cancelled" };
    }
    const step = this.options.script[this.next];
    this.next++;
    if (step === undefined) {
      return { finishReason: "stop", text: "" };
    }
    if ("error" in step) {
      return { finishReason: "error", text: step.error };
    }
    const toolCalls = "toolCalls" in step && step.toolCalls ? step.toolCalls : undefined;
    const text = "text" in step ? step.text : undefined;
    return {
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      finishReason: toolCalls ? "tool_calls" : "stop",
    };
  }
}

export function createSimulatedProvider(options: SimulatedProviderOptions): ModelProvider {
  return new SimulatedProvider(options);
}
