import type { ProductReview } from "@leclerc/agent";
import { SCENARIOS_VERSION, SCENARIO_GENERATION_PARAMS, type ScenarioDefinition } from "./types.js";

const recipe = JSON.stringify({ title: "Riz au lait de coco", servings: 4,
  ingredients: [{ name: "riz basmati", quantity: 500, unit: "g" }, { name: "lait de coco", quantity: 400, unit: "ml" }],
  steps: ["Cuire le riz avec le lait de coco."] });
const rice = { ingredientIndex: 0, action: "select", productId: "P-1004", compatibility: "exact", labelEvidence: "Riz basmati", reason: "Riz habituel adapté à la cuisson, paquet de 1 kg." };
const coconut = { ingredientIndex: 1, action: "select", productId: "P-1003", compatibility: "exact", labelEvidence: "Lait de coco", reason: "Le paquet de 400 ml couvre le besoin." };
const answer = (review: ProductReview) => review.items.map((item) => item.selectedProductId
  ? { ingredientIndex: item.ingredientIndex, productId: item.selectedProductId }
  : { ingredientIndex: item.ingredientIndex, skip: true as const });

function scenario(id: string, title: string, decisions: unknown[], overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  const text = "Un riz au lait de coco pour 4 personnes, avec mes produits habituels.";
  return { id, title, version: SCENARIOS_VERSION, generationParams: SCENARIO_GENERATION_PARAMS,
    frozenPrompt: { version: 1, text }, request: { message: text, servings: 4 },
    providerScript: [{ text: recipe }, ...decisions.map((entry) => ({ text: JSON.stringify({ decisions: entry }) }))],
    approvalDecision: { approved: false }, reviewAnswer: answer,
    expectedSelections: { 0: ["P-1004"], 1: ["P-1003", "P-2001"] },
    expectations: async (ctx) => [
      ctx.check("sélection attendue et quantités établies par le catalogue", JSON.stringify(ctx.result.preview?.lines.map((line) => [line.productId, line.quantity])) === JSON.stringify([["P-1004", 1], ["P-1003", 1]])),
      ctx.check("deux choix automatiques sans question évitable", ctx.trace.some((event) => event.type === "product_review" && event.uncertainCount === 0)),
      ctx.check("habitudes lues une seule fois", ctx.trace.filter((event) => event.type === "tool_call" && event.name === "list_habitual_products").length === 1),
      ctx.check("aucune clarification pendant les recherches", !ctx.trace.some((event) => event.type === "clarification")),
    ], ...overrides };
}

export const SELECTION_SCENARIOS: readonly ScenarioDefinition[] = [
  scenario("S01", "sélection étayée et produit habituel, sans question évitable", [[rice, coconut]]),
  scenario("S02", "référence inventée : doute regroupé et aucun ajout implicite", [[rice, { ...coconut, productId: "INVENTED" }]], {
    expectations: async (ctx) => [
      ctx.check("la référence inventée n'atteint pas l'aperçu", ctx.result.preview?.lines.every((line) => line.productId !== "INVENTED") === true),
      ctx.check("le produit incertain est passé explicitement", ctx.result.preview?.lines.length === 1 && ctx.result.issues.length === 1),
      ctx.check("un seul groupe de révision, avec un doute", ctx.trace.filter((event) => event.type === "product_review" && event.uncertainCount === 1).length === 1),
    ],
  }),
  scenario("S03", "recherche ciblée après résultat vide, seuls les doutes sont réévalués", [
    [rice, { ingredientIndex: 1, action: "research", query: "coco", reason: "Retrouver le conditionnement du lait de coco." }],
    [coconut],
  ], {
    faults: [{ capability: "search_product", code: "EMPTY_RESULT", nth: 2 }],
    expectations: async (ctx) => [
      ctx.check("deux tours seulement", ctx.trace.filter((event) => event.type === "selection_round").length === 2),
      ctx.check("la seconde évaluation exclut le riz déjà choisi", JSON.parse(ctx.generationRequests[2]?.messages[1]?.content ?? "{}").ingredients?.map((entry: { ingredientIndex: number }) => entry.ingredientIndex).join() === "1"),
      ctx.check("résultat catalogue vérifié après relance", ctx.result.preview?.lines.some((line) => line.productId === "P-1003") === true),
    ],
  }),
  scenario("S04", "arrêt sans progrès : une recherche identique ne consomme pas trois tours", [
    [rice, { ingredientIndex: 1, action: "research", query: "lait de coco", reason: "Vérifier le même conditionnement." }],
  ], {
    expectations: async (ctx) => [
      ctx.check("un seul tour sans information nouvelle", ctx.trace.filter((event) => event.type === "selection_round").length === 1),
      ctx.check("la recherche identique n'est pas répétée", ctx.trace.filter((event) => event.type === "tool_call" && event.name === "search_product").length === 2),
      ctx.check("le doute est remonté à la révision", ctx.result.issues.some((issue) => issue.kind === "ambiguous_unresolved")),
    ],
  }),
];
