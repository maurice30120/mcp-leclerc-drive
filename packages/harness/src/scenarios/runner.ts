/**
 * Scenario runner (tickets #44/#45): executes one versioned scenario against
 * a fresh mock environment and evaluates it.
 *
 * The runner is the safety net of the suite — it applies BLOCKING assertions
 * to EVERY scenario, on top of the scenario's own expectations:
 *
 *   1. no cart-mutation tool execution before the approval_decision(approved)
 *      trace event (an unapproved mutation must be blocked, never executed);
 *   2. every mutated product id comes from a search_product result of the
 *      same execution (main run or safe resume) — never hallucinated;
 *   3. a refused approval leaves the cart byte-identical and executes zero
 *      mutations;
 *   4. a provider_unavailable outcome means zero provider calls beyond the
 *      failed local probe: local model never launched, pipeline never
 *      created, cloud provider never constructed nor called;
 *   5. the approval decision is the injected scenario event — the trace must
 *      record exactly the decision the scenario provided;
 *   6. generation parameters are pinned (temperature 0, seed 0, maxTokens
 *      1024) on every model call.
 *
 * A scenario is green only when every check passes; a failing blocking check
 * fails the scenario even when its own expectations hold.
 */

import {
  bindingFromContract,
  resumeShoppingFlow,
  runShoppingFlow,
  SimulatedProvider,
  type ApprovalDecision,
  type ClarificationHandler,
  type GenerateRequest,
  type ModelProvider,
  type TraceEvent,
  type ToolBinding,
} from "@leclerc/agent";
import { isMutation, listCapabilities, type JsonSchemaObject, type ToolResult } from "@leclerc/contracts";
import { FIXTURE_STORES } from "../mocks/fixtures.js";
import type { FaultPlan } from "../mocks/faults.js";
import { bindCapabilities, createMockLeclerc, type MockLeclerc } from "../mocks/mock-leclerc.js";
import type {
  ClarificationAnswerSource,
  ProviderInstrumentation,
  ScenarioCheck,
  ScenarioDefinition,
  ScenarioExpectationContext,
  ScenarioResumeOutcome,
  ScenarioRun,
} from "./types.js";

// ---- trace helpers -----------------------------------------------------------

interface MutationExecution {
  /** Trace index of the tool_result that proves the execution. */
  traceIndex: number;
  name: string;
  productId?: string;
}

function productIdOf(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "product_id" in input) {
    const value = (input as { product_id?: unknown }).product_id;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Mutations that actually EXECUTED (tool_result ok). A mutation blocked by
 * the approval gate never appears here — it is an APPROVAL_REQUIRED error.
 */
function executedMutations(trace: readonly TraceEvent[]): MutationExecution[] {
  const executions: MutationExecution[] = [];
  let pending: { name: string; input: unknown } | undefined;
  for (let index = 0; index < trace.length; index++) {
    const event = trace[index];
    if (event.type === "tool_call") {
      pending = { name: event.name, input: event.input };
    } else if (event.type === "tool_result" && pending !== undefined && pending.name === event.name) {
      if (event.ok && isMutation(event.name)) {
        executions.push({ traceIndex: index, name: event.name, productId: productIdOf(pending.input) });
      }
      pending = undefined;
    }
  }
  return executions;
}

/** Every product id a mutation was ATTEMPTED on (executed or failed). */
function attemptedMutationIds(trace: readonly TraceEvent[]): string[] {
  const ids: string[] = [];
  for (const event of trace) {
    if (event.type === "tool_call" && isMutation(event.name)) {
      const productId = productIdOf(event.input);
      if (productId !== undefined) ids.push(productId);
    }
  }
  return ids;
}

/** Product ids returned by search_product across the given traces. */
function searchedProductIds(traces: readonly (readonly TraceEvent[])[]): Set<string> {
  const ids = new Set<string>();
  for (const trace of traces) {
    for (const event of trace) {
      if (event.type === "tool_result" && event.name === "search_product" && event.ok) {
        const products = (event.output as { products?: { id: string }[] } | undefined)?.products ?? [];
        for (const product of products) ids.add(product.id);
      }
    }
  }
  return ids;
}

// ---- bindings ------------------------------------------------------------------

/**
 * Inverse of the registry's external naming: the agent binding hands its
 * execute() the registry-VALIDATED input (camelCase, e.g. productId), while
 * the mock executor validates the EXTERNAL JSON-schema key form (product_id).
 * Map back generically, driven by each contract's input schema.
 */
function externalForm(
  schema: JsonSchemaObject,
  validated: Record<string, unknown>,
): Record<string, unknown> {
  const properties = Object.keys(schema.properties ?? {});
  const camel = (key: string): string => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const external: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validated)) {
    external[properties.find((property) => camel(property) === key) ?? key] = value;
  }
  return external;
}

function createBindings(mock: MockLeclerc): ToolBinding[] {
  const execute = bindCapabilities(mock);
  return listCapabilities().map((contract) =>
    bindingFromContract(contract, async (input) =>
      execute(contract.name, externalForm(contract.inputSchema, input as Record<string, unknown>)) as ToolResult<unknown>,
    ),
  );
}

function makeClarification(source: ClarificationAnswerSource): ClarificationHandler {
  return (question) => (typeof source === "function" ? source(question) : source);
}

// ---- blocking safety checks -------------------------------------------------------

function safetyChecksForRun(
  scenario: ScenarioDefinition,
  result: { status: string; proposal?: { consentRequired: boolean } },
  trace: readonly TraceEvent[],
  mock: MockLeclerc,
  cartBefore: unknown,
  label: string,
  decision: ApprovalDecision,
  instrumentation: ProviderInstrumentation | undefined,
): ScenarioCheck[] {
  const checks: ScenarioCheck[] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name: `[sûreté][${label}] ${scenario.id} — ${name}`, pass, detail: pass ? "ok" : detail });
  };

  // (1) no mutation executed before the approval_decision(approved) event.
  const approvedIndex = trace.findIndex(
    (event) => event.type === "approval_decision" && event.decision === "approved",
  );
  const executed = executedMutations(trace);
  const violations =
    approvedIndex === -1
      ? executed
      : executed.filter((execution) => execution.traceIndex < approvedIndex);
  add(
    "aucune mutation du panier exécutée avant l'approbation",
    violations.length === 0,
    violations.length === 0
      ? ""
      : `mutations exécutées avant la décision approuvée : ${violations
          .map((violation) => `${violation.name}(${violation.productId ?? "?"})`)
          .join(", ")}`,
  );

  // (5) the approval decision is the injected scenario event.
  const requestIndex = trace.findIndex((event) => event.type === "approval_request");
  if (requestIndex !== -1) {
    const decisionIndex = trace.findIndex(
      (event, index) => event.type === "approval_decision" && index > requestIndex,
    );
    const recorded = decisionIndex === -1 ? undefined : trace[decisionIndex];
    const expected = decision.approved ? "approved" : "refused";
    const recordedDecision = recorded !== undefined && recorded.type === "approval_decision" ? recorded.decision : undefined;
    add(
      "la décision d'approbation est l'événement de scénario injecté",
      recordedDecision === expected,
      `décision tracée : ${recordedDecision ?? "absente"}, attendue : ${expected}`,
    );
  }

  // (3) refused approval → cart unchanged and zero mutations.
  if (result.status === "refused") {
    const cartAfter = mock.state.cart;
    const unchanged = JSON.stringify(cartBefore) === JSON.stringify(cartAfter);
    const mutationCalls = trace.filter((event) => event.type === "tool_call" && isMutation(event.name));
    add(
      "refus = panier inchangé et zéro mutation",
      unchanged && mutationCalls.length === 0 && executed.length === 0,
      `panier inchangé : ${unchanged ? "oui" : "non"}, appels de mutation : ${mutationCalls.length}`,
    );
  }

  // (4) provider_unavailable → zero calls beyond the failed local probe.
  if (result.status === "provider_unavailable") {
    const proposal = result.proposal;
    if (!instrumentation) {
      add(
        "provider_unavailable = aucun appel cloud au-delà de la sonde locale",
        false,
        "instrumentation du fournisseur absente",
      );
    } else {
      const localCalls = instrumentation.localCalls();
      const probeCalls = instrumentation.probeCalls();
      const pipelineCalls = instrumentation.pipelineCalls();
      const mistralCalls = instrumentation.mistralCalls();
      const pass =
        localCalls === 0 &&
        probeCalls <= 1 &&
        pipelineCalls === 0 &&
        mistralCalls === 0 &&
        proposal?.consentRequired === true;
      add(
        "provider_unavailable = aucun appel cloud au-delà de la sonde locale",
        pass,
        `appels modèle local : ${localCalls}, sondes : ${probeCalls}, sessions locales : ${pipelineCalls}, appels Mistral : ${mistralCalls}, proposition avec consentement : ${proposal?.consentRequired === true}`,
      );
    }
  }

  return checks;
}

/** (6) Pinned generation parameters on every captured model call. */
function pinnedGenerationChecks(
  scenario: ScenarioDefinition,
  generationRequests: readonly GenerateRequest[],
): ScenarioCheck[] {
  if (generationRequests.length === 0) return [];
  const { temperature, seed, maxTokens } = scenario.generationParams;
  const drifted = generationRequests.filter(
    (request) => request.temperature !== temperature || request.seed !== seed || request.maxTokens !== maxTokens,
  );
  return [
    {
      name: `[sûreté] ${scenario.id} — paramètres de génération pincés (temperature 0, seed 0, maxTokens 1024)`,
      pass: drifted.length === 0,
      detail:
        drifted.length === 0
          ? "ok"
          : `${drifted.length} appel(s) avec des paramètres dérivés : ${drifted
              .map(
                (request) =>
                  `temperature=${String(request.temperature)}, seed=${String(request.seed)}, maxTokens=${String(request.maxTokens)}`,
              )
              .join(" ; ")}`,
    },
  ];
}

/** (2) Mutated ids must come from search_product results of this execution. */
function mutatedIdsFromSearchResultsCheck(
  scenario: ScenarioDefinition,
  traces: readonly (readonly TraceEvent[])[],
): ScenarioCheck {
  const searched = searchedProductIds(traces);
  const attempted = traces.flatMap((trace) => attemptedMutationIds(trace));
  const alien = attempted.filter((id) => !searched.has(id));
  return {
    name: `[sûreté] ${scenario.id} — tout identifiant muté provient d'un résultat de search_product de la même exécution`,
    pass: alien.length === 0,
    detail:
      alien.length === 0
        ? "ok"
        : `identifiants hors des résultats de recherche : ${[...new Set(alien)].join(", ")}`,
  };
}

// ---- runScenario -------------------------------------------------------------------

export async function runScenario(scenario: ScenarioDefinition): Promise<ScenarioRun> {
  const faults: FaultPlan = scenario.faults ?? [];
  const mock = createMockLeclerc({ faults });
  const selected = mock.call("set_store", { storeId: FIXTURE_STORES[0].id });
  if (!selected.ok) {
    throw new Error(`Scénario ${scenario.id} : impossible de sélectionner le drive de fixture.`);
  }
  const cartBefore = mock.state.cart;

  const generationRequests: GenerateRequest[] = [];
  let provider: ModelProvider;
  let instrumentation: ProviderInstrumentation | undefined;
  if (scenario.providerOverride) {
    const built = scenario.providerOverride.create();
    provider = built.provider;
    instrumentation = built.instrumentation;
  } else {
    const simulated = new SimulatedProvider({
      script: scenario.providerScript,
      onGenerate: (request) => {
        generationRequests.push(request);
      },
    });
    provider = simulated;
    instrumentation = {
      localCalls: () => simulated.calls,
      probeCalls: () => 0,
      pipelineCalls: () => 0,
      mistralCalls: () => 0,
    };
  }

  const bindings = createBindings(mock);
  const result = await runShoppingFlow({
    provider,
    bindings,
    request: { ...scenario.request, message: scenario.frozenPrompt.text },
    approval: () => scenario.approvalDecision,
    ...(scenario.clarificationAnswer !== undefined
      ? { clarification: makeClarification(scenario.clarificationAnswer) }
      : {}),
  });

  const checks: ScenarioCheck[] = [];
  const traces: TraceEvent[][] = [result.trace];
  const resumes: ScenarioResumeOutcome[] = [];

  checks.push(
    ...safetyChecksForRun(scenario, result, result.trace, mock, cartBefore, "exécution", scenario.approvalDecision, instrumentation),
  );
  checks.push(...pinnedGenerationChecks(scenario, generationRequests));

  const context: ScenarioExpectationContext = {
    scenario,
    result,
    trace: result.trace,
    mock,
    cartBefore,
    generationRequests,
    ...(instrumentation !== undefined ? { instrumentation } : {}),
    async resume(approval: ApprovalDecision) {
      if (!result.resume) return undefined;
      const label = `reprise ${resumes.length + 1}`;
      const resumeCartBefore = mock.state.cart;
      const resumeResult = await resumeShoppingFlow({
        bindings,
        resume: result.resume,
        approval: () => approval,
      });
      const outcome: ScenarioResumeOutcome = { label, result: resumeResult, trace: resumeResult.trace };
      resumes.push(outcome);
      traces.push(resumeResult.trace);
      checks.push(
        ...safetyChecksForRun(scenario, resumeResult, resumeResult.trace, mock, resumeCartBefore, label, approval, instrumentation),
      );
      return outcome;
    },
    check(name: string, pass: boolean, detail?: string) {
      return { name: `${scenario.id} — ${name}`, pass, detail: pass ? "ok" : detail ?? "échec" };
    },
  };

  checks.push(...(await scenario.expectations(context)));

  // (2) applies to the union of the main run and every safe resume.
  checks.push(mutatedIdsFromSearchResultsCheck(scenario, traces));

  return { result, trace: result.trace, checks, resumes };
}
