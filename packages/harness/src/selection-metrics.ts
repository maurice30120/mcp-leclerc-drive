import { SELECTION_PROMPT_VERSION, type ShoppingFlowResult, type TraceEvent } from "@leclerc/agent";

/** Quality is measured against scenario fixtures, never against the model's own judgement. */
export function selectionMetrics(result: ShoppingFlowResult, trace: readonly TraceEvent[], expected?: Readonly<Record<number, readonly string[]>>) {
  const automatic = new Map<number, string>();
  const uncertain = new Set<number>();
  for (const event of trace) {
    if (event.type === "selection_round") {
      for (const decision of event.decisions) if (decision.action === "select" && decision.productId) automatic.set(decision.ingredientIndex, decision.productId);
    }
    if (event.type === "product_review") event.uncertainIngredientIndices.forEach((index) => uncertain.add(index));
    if (event.type === "clarification") {
      const index = result.recipe?.ingredients.findIndex((ingredient) => ingredient.name === event.question.ingredient);
      if (index !== undefined && index >= 0) uncertain.add(index);
    }
  }
  const errors = new Set<number>();
  for (const [index, id] of automatic) if (expected?.[index] && !expected[index].includes(id)) errors.add(index);
  for (const line of result.preview?.lines ?? []) {
    const index = result.recipe?.ingredients.findIndex((ingredient) => ingredient.name === line.ingredient);
    if (index !== undefined && expected?.[index] && !expected[index].includes(line.productId)) errors.add(index);
  }
  return {
    selectionPromptVersion: SELECTION_PROMPT_VERSION,
    modelCalls: trace.filter((event) => event.type === "model_call").length,
    toolCalls: trace.filter((event) => event.type === "tool_call").length,
    selectionRounds: trace.filter((event) => event.type === "selection_round").length,
    automaticSelections: automatic.size,
    clarificationCount: uncertain.size,
    selectionErrors: expected ? errors.size : null,
    avoidableQuestions: expected ? [...uncertain].filter((index) => (expected[index]?.length ?? 0) > 0).length : null,
  };
}
