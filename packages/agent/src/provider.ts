/**
 * The ModelProvider seam (spec issue #40, decision list).
 *
 * The orchestrator knows nothing about Mistral, ONNX or WebGPU: it only talks
 * to this interface. Four provider configurations are expected behind it —
 * Mistral BYOK, a small base model, the same model after LoRA fine-tuning,
 * and a simulated model with predictable responses for tests — and none of
 * them is ever selected implicitly: no cloud call without an explicit user
 * choice, no silent fallback after a local failure (A10).
 */

import type { JsonSchemaObject } from "@leclerc/contracts";

/** A tool call requested by the model. */
export interface ToolCallRequest {
  /** Provider-assigned call id, echoed back in the tool result message. */
  id: string;
  /** Capability name from the contracts registry. */
  name: string;
  /** Unvalidated input — always validated against the registry contract. */
  input: unknown;
}

export type ProviderRole = "system" | "user" | "assistant" | "tool";

/** One conversation message exchanged with a provider. */
export interface ProviderMessage {
  role: ProviderRole;
  content: string;
  /** Assistant message carrying tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Tool result message: which call it answers. */
  toolCallId?: string;
  /** Tool result message: which capability produced it. */
  toolName?: string;
}

/** A tool advertised to the provider, projected from the capability registry. */
export interface ProviderToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  /** True for cart mutations — lets providers describe the approval policy. */
  mutation: boolean;
}

export interface ModelCapabilities {
  /** Whether the provider can emit native tool calls. */
  toolCalling: boolean;
  /** Whether the provider can stream partial text. */
  streaming: boolean;
}

export interface GenerateRequest {
  messages: ProviderMessage[];
  tools?: ProviderToolSpec[];
  temperature?: number;
  /** Seed when the provider controls it — recorded in campaign reports. */
  seed?: number;
  maxTokens?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

export type GenerateFinishReason = "stop" | "tool_calls" | "length" | "cancelled" | "error";

export interface GenerateUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface GenerateResponse {
  text?: string;
  toolCalls?: ToolCallRequest[];
  finishReason: GenerateFinishReason;
  usage?: GenerateUsage;
}

/** The single interface every model configuration implements. */
export interface ModelProvider {
  /** Stable provider id, e.g. "simulated", "mistral-byok", "webgpu:<model>". */
  readonly id: string;
  /** Model/version identity recorded in traces and campaign reports. */
  readonly modelVersion: string;
  readonly capabilities: ModelCapabilities;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

/** An alternative provider proposed to the user — never called automatically. */
export interface ProviderProposal {
  providerId: string;
  label: string;
  /** Always true: a proposal never executes without explicit consent. */
  consentRequired: true;
  /** Why this provider is proposed (diagnostic context, shown to the user). */
  reason?: string;
}

/**
 * A provider exists but cannot run here (WebGPU unavailable, session creation
 * failed…). The local model must NOT be launched and no cloud call happens:
 * the caller surfaces the diagnostic and, at most, a proposal.
 */
export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE" as const;
  constructor(
    message: string,
    /** Human-readable French diagnostic. */
    readonly diagnostic: string,
    /** Optional alternative provider proposed — with consent, never auto-run. */
    readonly proposal?: ProviderProposal,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
