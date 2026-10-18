/**
 * Scenario suite types (tickets #44/#45, spec issue #40).
 *
 * A scenario is a fully deterministic, versioned replay of the shopping flow:
 * a frozen French prompt, a scripted SimulatedProvider (or an explicit
 * provider override such as the A10 WebGPU failure), an injectable fault plan,
 * the approval decision injected as a scenario event, and typed expectations
 * asserted on the ShoppingFlowResult and its trace.
 *
 * The runner applies BLOCKING safety assertions to every scenario on top of
 * the per-scenario expectations; a scenario is green only when every check
 * passes.
 */

import type {
  ApprovalDecision,
  ClarificationAnswer,
  ClarificationQuestion,
  GenerateRequest,
  ModelProvider,
  ShoppingFlowRequest,
  ShoppingFlowResult,
  SimulatedStep,
  TraceEvent,
} from "@leclerc/agent";
import type { Cart } from "@leclerc/contracts";
import type { FaultPlan } from "../mocks/faults.js";
import type { MockLeclerc } from "../mocks/mock-leclerc.js";

/** Bump when any scenario definition, prompt or script changes. */
export const SCENARIOS_VERSION = 1 as const;

/**
 * Pinned generation parameters for every scenario (spec decision):
 * temperature 0, seed 0, maxTokens 1024 — byte-identical replays.
 */
export const SCENARIO_GENERATION_PARAMS = {
  temperature: 0,
  seed: 0,
  maxTokens: 1024,
} as const;

/** A frozen prompt constant: version plus the exact replayed text. */
export interface FrozenPrompt {
  /** Bump when the text changes; fine-tuning comparisons pin this. */
  version: number;
  text: string;
}

/** One named assertion outcome — blocking when pass is false. */
export interface ScenarioCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * Observable provider-side counters a scenario provider override must expose
 * so the runner can assert the zero-cloud-call safety rules (A10).
 */
export interface ProviderInstrumentation {
  /** generate() calls served by the flow's provider. */
  localCalls(): number;
  /** Local availability probe executions (WebGPU probe). */
  probeCalls(): number;
  /** Local pipeline/session creations (must stay 0 when the probe fails). */
  pipelineCalls(): number;
  /** Cloud (Mistral BYOK) generate() or network calls — must stay 0. */
  mistralCalls(): number;
}

/** Replaces the SimulatedProvider for scenarios exercising real provider classes. */
export interface ScenarioProviderOverride {
  create(): { provider: ModelProvider; instrumentation: ProviderInstrumentation };
}

/** Clarification answer: a constant, or computed from the question asked. */
export type ClarificationAnswerSource =
  | ClarificationAnswer
  | ((question: ClarificationQuestion) => ClarificationAnswer);

/** One safe-resume execution triggered from scenario expectations. */
export interface ScenarioResumeOutcome {
  label: string;
  result: ShoppingFlowResult;
  trace: TraceEvent[];
}

/** What scenario expectations may observe and do. */
export interface ScenarioExpectationContext {
  readonly scenario: ScenarioDefinition;
  readonly result: ShoppingFlowResult;
  readonly trace: TraceEvent[];
  /** The mock environment (fault plan injectable between phases). */
  readonly mock: MockLeclerc;
  /** Cart snapshot taken before the run, after the drive was selected. */
  readonly cartBefore: Cart;
  /** Every provider generate() request captured (simulated providers only). */
  readonly generationRequests: readonly GenerateRequest[];
  /** Provider counters when the scenario supplied an instrumented provider. */
  readonly instrumentation?: ProviderInstrumentation;
  /**
   * Complete the pending mutations with a FRESH approval decision. The
   * runner applies the same blocking safety assertions to the resume trace.
   * Undefined when the run produced no resume object.
   */
  resume(approval: ApprovalDecision): Promise<ScenarioResumeOutcome | undefined>;
  /** Build a scenario check; detail describes the failure when pass is false. */
  check(name: string, pass: boolean, detail?: string): ScenarioCheck;
}

/** A versioned scenario of the safety suite. */
export interface ScenarioDefinition {
  /** Stable id: A01…A10, F01. */
  readonly id: string;
  readonly title: string;
  /** Frozen prompt constant — request.message must equal frozenPrompt.text. */
  readonly frozenPrompt: FrozenPrompt;
  readonly request: ShoppingFlowRequest;
  /** SimulatedProvider steps, consumed in order (empty for provider overrides). */
  readonly providerScript: readonly SimulatedStep[];
  /** Explicit provider wiring (A10); replaces the SimulatedProvider. */
  readonly providerOverride?: ScenarioProviderOverride;
  /** Fault plan injected into the mock environment before the run. */
  readonly faults?: FaultPlan;
  /** The global approval decision, injected as a scenario event. */
  readonly approvalDecision: ApprovalDecision;
  /** Clarification answer injected as a scenario event (A09). */
  readonly clarificationAnswer?: ClarificationAnswerSource;
  /** Typed assertions on the result and trace. */
  readonly expectations: (ctx: ScenarioExpectationContext) => Promise<readonly ScenarioCheck[]>;
  readonly version: typeof SCENARIOS_VERSION;
  readonly generationParams: typeof SCENARIO_GENERATION_PARAMS;
}

/** The outcome of running one scenario through the harness. */
export interface ScenarioRun {
  result: ShoppingFlowResult;
  trace: TraceEvent[];
  /** Blocking safety assertions + scenario expectations, in order. */
  checks: ScenarioCheck[];
  /** Safe-resume executions triggered by the expectations, in order. */
  resumes: ScenarioResumeOutcome[];
}
