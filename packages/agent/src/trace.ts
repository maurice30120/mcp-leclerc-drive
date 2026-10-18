/**
 * Trace (ticket #44): one evaluable event stream per shopping-flow run.
 *
 * Every observable step of a scenario — user message, model output, tool
 * calls (model-driven or deterministic), tool results, the single repair
 * attempt, approval request/decision, safety blocks, clarifications and
 * explicit errors — is recorded here with an ISO timestamp and, where
 * relevant, a duration in milliseconds. The harness (ticket #45) asserts
 * scenario invariants (e.g. zero mutations before the approval decision)
 * directly on this stream.
 */

import type { RecipeIssue, ToolError, ToolResult } from "@leclerc/contracts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ClarificationAnswer,
  ClarificationQuestion,
} from "./approval.js";

/** Where a tool call comes from: the model, or the deterministic flow code. */
export type ToolCallSource = "model" | "deterministic";

export interface UserMessageEvent {
  type: "user_message";
  timestamp: string;
  content: string;
}

export interface ModelTextEvent {
  type: "model_text";
  timestamp: string;
  text: string;
  /** Generation wall-clock duration in milliseconds. */
  durationMs?: number;
}

export interface ToolCallEvent {
  type: "tool_call";
  timestamp: string;
  source: ToolCallSource;
  /** Capability name from the contracts registry. */
  name: string;
  /** Unvalidated input as received (before validateInput). */
  input: unknown;
  /** Provider-assigned call id for model calls. */
  callId?: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  timestamp: string;
  name: string;
  callId?: string;
  ok: boolean;
  /** Structured output on success. */
  output?: unknown;
  /** Normalized tool error on failure. */
  error?: ToolError;
  /** Execution wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface RepairAttemptEvent {
  type: "repair_attempt";
  timestamp: string;
  /** Repair round number (1 = the single allowed round). */
  attempt: number;
  /** Issues found on the previous attempt, fed to buildRepairPrompt. */
  issues: RecipeIssue[];
}

export interface ApprovalRequestEvent {
  type: "approval_request";
  timestamp: string;
  request: ApprovalRequest;
}

export interface ApprovalDecisionEvent {
  type: "approval_decision";
  timestamp: string;
  decision: "approved" | "refused";
  reason?: string;
}

export interface SafetyBlockEvent {
  type: "safety_block";
  timestamp: string;
  /** Mutation tool that was blocked. */
  name: string;
  /** Human-readable French reason. */
  reason: string;
}

export interface ClarificationEvent {
  type: "clarification";
  timestamp: string;
  question: ClarificationQuestion;
  answer?: ClarificationAnswer;
}

export interface ErrorEvent {
  type: "error";
  timestamp: string;
  /** Stable machine code, e.g. "RECIPE_INVALID", "PROVIDER_ERROR". */
  code: string;
  /** Human-readable French message. */
  message: string;
  details?: Record<string, unknown>;
}

export type TraceEvent =
  | { type: "product_choices"; timestamp: string; choices: Array<{ ingredientIndex: number; productId?: string; skip?: true }> }
  | { type: "preparation_authorized"; timestamp: string; flowId: string }
  | { type: "ingredient_progress"; timestamp: string; ingredientIndex: number; status: string; message?: string }
  | { type: "cart_intent"; timestamp: string; flowId: string; ingredientIndex: number; productId: string; before: number; target: number; operation: "add" | "remove" }
  | { type: "cart_verified"; timestamp: string; ingredientIndex: number; productId: string; quantity: number; operation: "add" | "remove" }
  | { type: "model_call"; timestamp: string; purpose: "recipe" | "selection"; durationMs: number; success: boolean }
  | { type: "selection_round"; timestamp: string; round: number; durationMs: number;
      decisions: Array<{ ingredientIndex: number; action: string; reason: string; productId?: string }> }
  | { type: "product_review"; timestamp: string; uncertainCount: number; uncertainIngredientIndices: number[]; selectedCount: number; skippedCount: number }
  | UserMessageEvent
  | ModelTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | RepairAttemptEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | SafetyBlockEvent
  | ClarificationEvent
  | ErrorEvent;

/** Builds the event stream of one run. Pure bookkeeping, no I/O. */
export class TraceBuilder {
  readonly events: TraceEvent[] = [];

  now(): string {
    return new Date().toISOString();
  }

  userMessage(content: string): void {
    this.events.push({ type: "user_message", timestamp: this.now(), content });
  }

  modelText(text: string, durationMs?: number): void {
    this.events.push({
      type: "model_text",
      timestamp: this.now(),
      text,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  toolCall(source: ToolCallSource, name: string, input: unknown, callId?: string): void {
    this.events.push({
      type: "tool_call",
      timestamp: this.now(),
      source,
      name,
      input,
      ...(callId !== undefined ? { callId } : {}),
    });
  }

  toolResult(name: string, callId: string | undefined, result: ToolResult<unknown>, durationMs: number): void {
    this.events.push({
      type: "tool_result",
      timestamp: this.now(),
      name,
      ...(callId !== undefined ? { callId } : {}),
      ok: result.ok,
      ...(result.ok ? { output: result.output } : { error: result }),
      durationMs,
    });
  }

  repairAttempt(attempt: number, issues: RecipeIssue[]): void {
    this.events.push({ type: "repair_attempt", timestamp: this.now(), attempt, issues });
  }

  approvalRequest(request: ApprovalRequest): void {
    this.events.push({ type: "approval_request", timestamp: this.now(), request });
  }

  approvalDecision(decision: ApprovalDecision): void {
    this.events.push({
      type: "approval_decision",
      timestamp: this.now(),
      decision: decision.approved ? "approved" : "refused",
      ...(!decision.approved && decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
  }

  safetyBlock(name: string, reason: string): void {
    this.events.push({ type: "safety_block", timestamp: this.now(), name, reason });
  }

  clarification(question: ClarificationQuestion, answer?: ClarificationAnswer): void {
    this.events.push({
      type: "clarification",
      timestamp: this.now(),
      question,
      ...(answer !== undefined ? { answer } : {}),
    });
  }

  error(code: string, message: string, details?: Record<string, unknown>): void {
    this.events.push({
      type: "error",
      timestamp: this.now(),
      code,
      message,
      ...(details ? { details } : {}),
    });
  }
}

export function createTraceBuilder(): TraceBuilder {
  return new TraceBuilder();
}
