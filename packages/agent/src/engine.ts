/**
 * Agent engine (ticket #44): injectable tool executor and generic
 * tool-calling loop.
 *
 * The executor binds capability contracts from @leclerc/contracts to concrete
 * executions (the real Leclerc adapter in Chrome, the harness mocks in Node).
 * It applies the registry validateInput BEFORE any execution and the
 * ApprovalGate BEFORE any mutation: a blocked call is never executed and
 * surfaces to the model as a typed APPROVAL_REQUIRED tool error.
 *
 * The loop is the generic model-driven tool-calling facility, with clean
 * stop statuses on turn/tool-call limits and on AbortSignal cancellation.
 */

import type {
  CapabilityContract,
  InputValidationResult,
  JsonSchemaObject,
  ToolResult,
} from "@leclerc/contracts";
import { toolError, toToolError } from "@leclerc/contracts";
import type { ApprovalGate } from "./approval.js";
import type {
  GenerateRequest,
  ModelProvider,
  ProviderMessage,
  ProviderToolSpec,
} from "./provider.js";
import type { ToolCallSource, TraceBuilder } from "./trace.js";

/** A capability contract bound to a concrete execution. */
export interface ToolBinding {
  /** Registry capability name. */
  name: string;
  /** True for cart mutations — guarded by the ApprovalGate. */
  mutation: boolean;
  /** JSON schema of the input, advertised to providers. */
  inputSchema: JsonSchemaObject;
  /** Description advertised to providers. */
  description: string;
  /** Registry validation: always applied before execute. */
  validateInput(input: unknown): InputValidationResult<unknown>;
  /** Concrete execution; resolves to a typed result, never throws. */
  execute(input: unknown): Promise<ToolResult<unknown>>;
}

/**
 * Bind a registry contract to a concrete execution. The binding inherits
 * name, mutation kind, schema, description and validateInput from the
 * contract — the single source of truth.
 */
export function bindingFromContract<TInput, TOutput>(
  contract: CapabilityContract<TInput, TOutput>,
  execute: (input: TInput) => Promise<ToolResult<TOutput>>,
): ToolBinding {
  return {
    name: contract.name,
    mutation: contract.kind === "mutation",
    inputSchema: contract.inputSchema,
    description: contract.description,
    validateInput: (input) => contract.validateInput(input),
    execute: (input) => execute(input as TInput),
  };
}

export interface ToolExecutorOptions {
  /** All bindings available in this engine (injectable per environment). */
  bindings: readonly ToolBinding[];
  /** The only door to mutation tools. */
  gate: ApprovalGate;
  /** Trace where every call, result and safety block is recorded. */
  trace: TraceBuilder;
}

/**
 * Executes tool calls through the contracts registry contracts. Every call is
 * traced; mutations without approval are blocked before execution.
 */
export class ToolExecutor {
  private readonly byName = new Map<string, ToolBinding>();
  readonly gate: ApprovalGate;
  private readonly trace: TraceBuilder;

  constructor(options: ToolExecutorOptions) {
    for (const binding of options.bindings) {
      this.byName.set(binding.name, binding);
    }
    this.gate = options.gate;
    this.trace = options.trace;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Provider-facing tool specs projected from the bound contracts. */
  providerToolSpecs(): ProviderToolSpec[] {
    return [...this.byName.values()].map((b) => ({
      name: b.name,
      description: b.description,
      inputSchema: b.inputSchema,
      mutation: b.mutation,
    }));
  }

  /**
   * Execute one tool call. Order of enforcement:
   * 1. binding lookup (UNKNOWN_CAPABILITY),
   * 2. registry validateInput (INVALID_INPUT / contract errors),
   * 3. approval guard for mutations (APPROVAL_REQUIRED, tool NOT executed,
   *    safety_block traced),
   * 4. concrete execution (exceptions normalized to CAPABILITY_FAILED).
   */
  async call(
    name: string,
    input: unknown,
    source: ToolCallSource,
    callId?: string,
  ): Promise<ToolResult<unknown>> {
    const started = Date.now();
    this.trace.toolCall(source, name, input, callId);

    const binding = this.byName.get(name);
    if (!binding) {
      const err = toolError("UNKNOWN_CAPABILITY", `Capacité inconnue : '${name}'.`);
      this.trace.toolResult(name, callId, err, Date.now() - started);
      return err;
    }

    const validated = binding.validateInput(input);
    if (!validated.ok) {
      this.trace.toolResult(name, callId, validated, Date.now() - started);
      return validated;
    }

    if (binding.mutation && !this.gate.isApproved()) {
      this.trace.safetyBlock(
        name,
        "Approbation globale de l'utilisateur requise avant toute mutation du panier.",
      );
      const err = toolError(
        "APPROVAL_REQUIRED",
        "Mutation refusée : approbation globale du panier requise avant tout ajout au panier.",
        { capability: name },
      );
      this.trace.toolResult(name, callId, err, Date.now() - started);
      return err;
    }

    let result: ToolResult<unknown>;
    try {
      result = await binding.execute(validated.value);
    } catch (err) {
      result = toToolError(err, name);
    }
    this.trace.toolResult(name, callId, result, Date.now() - started);
    return result;
  }
}

// ---- generic tool-calling loop ----------------------------------------------

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOOL_CALLS = 32;

export type ToolLoopStatus = "completed" | "cancelled" | "limits_exceeded" | "provider_error";

export interface ToolLoopOptions {
  provider: ModelProvider;
  executor: ToolExecutor;
  messages: ProviderMessage[];
  tools?: ProviderToolSpec[];
  maxTurns?: number;
  maxToolCalls?: number;
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional trace for model text and provider errors. */
  trace?: TraceBuilder;
}

export interface ToolLoopResult {
  status: ToolLoopStatus;
  messages: ProviderMessage[];
  finalText?: string;
  turns: number;
  toolCallCount: number;
}

/**
 * Generic model-driven tool loop: generate, execute requested tool calls via
 * the executor, feed typed results back, until the model stops or a limit /
 * cancellation ends the run with a clean status.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const {
    provider,
    executor,
    tools,
    maxTurns = DEFAULT_MAX_TURNS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    temperature,
    seed,
    maxTokens,
    signal,
    trace,
  } = options;

  const messages = [...options.messages];
  let turns = 0;
  let toolCallCount = 0;

  for (;;) {
    if (signal?.aborted) {
      return { status: "cancelled", messages, turns, toolCallCount };
    }
    if (turns >= maxTurns) {
      return { status: "limits_exceeded", messages, turns, toolCallCount };
    }

    const request: GenerateRequest = {
      messages,
      ...(tools ? { tools } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(signal ? { signal } : {}),
    };
    const response = await provider.generate(request);
    turns++;

    if (signal?.aborted || response.finishReason === "cancelled") {
      return { status: "cancelled", messages, turns, toolCallCount };
    }

    if (response.finishReason === "error") {
      if (response.text !== undefined) {
        trace?.modelText(response.text);
      }
      trace?.error(
        "PROVIDER_ERROR",
        `Le modèle a répondu par une erreur : ${response.text ?? "sortie inexploitable"}.`,
      );
      return {
        status: "provider_error",
        messages,
        finalText: response.text,
        turns,
        toolCallCount,
      };
    }

    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: response.text ?? "",
        toolCalls,
      });
      if (response.text !== undefined && response.text !== "") {
        trace?.modelText(response.text);
      }
      for (const call of toolCalls) {
        if (toolCallCount >= maxToolCalls) {
          return { status: "limits_exceeded", messages, turns, toolCallCount };
        }
        toolCallCount++;
        const result = await executor.call(call.name, call.input, "model", call.id);
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
      continue;
    }

    if (response.text !== undefined) {
      trace?.modelText(response.text);
      messages.push({ role: "assistant", content: response.text });
    }
    return {
      status: "completed",
      messages,
      finalText: response.text ?? "",
      turns,
      toolCallCount,
    };
  }
}
