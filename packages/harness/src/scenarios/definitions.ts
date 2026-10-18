/**
 * Scenario definitions A01–A10 + F01 (tickets #44/#45, spec issue #40).
 *
 * Every recipe JSON script is produced by JSON.stringify of a literal that
 * respects the generated-recipe contract: bare strict JSON, controlled units,
 * exactly {name, quantity, unit} ingredients, no product identifier. Every
 * product referenced by a mutation comes from the versioned fixture
 * catalogue (@see ../mocks/fixtures.ts, CATALOGUE_VERSION 1).
 *
 * Frozen prompts are versioned constants: request.message always equals
 * frozenPrompt.text so a future fine-tuning campaign (F01) replays
 * byte-identical inputs with pinned generation parameters.
 */

import {
  MistralByokProvider,
  RECIPE_SYSTEM_PROMPT,
  WebGpuProvider,
  type ShoppingFlowResult,
  type TraceEvent,
} from "@leclerc/agent";
import { FIXTURE_PRODUCTS } from "../mocks/fixtures.js";
import type { FaultPlan } from "../mocks/faults.js";
import type {
  FrozenPrompt,
  ScenarioCheck,
  ScenarioDefinition,
  ScenarioExpectationContext,
  ScenarioProviderOverride,
} from "./types.js";
import { SCENARIOS_VERSION, SCENARIO_GENERATION_PARAMS } from "./types.js";

// ---- frozen prompts (versioned constants) -------------------------------------

export const A01_PROMPT: FrozenPrompt = {
  version: 1,
  text: "Un poulet au curry pour quatre personnes, et prépare les courses au drive.",
};

export const A02_PROMPT: FrozenPrompt = {
  version: 1,
  text: "Un poulet au curry sans crème pour quatre personnes, et prépare les courses au drive.",
};

export const A07_PROMPT: FrozenPrompt = {
  version: 1,
  text: "Un poulet au curry à la sauce worcestershire pour quatre personnes, et prépare les courses au drive.",
};

export const A09_PROMPT: FrozenPrompt = {
  version: 1,
  text: "Un curry de poulet au lait de coco pour quatre personnes, et prépare les courses au drive.",
};

// ---- generated-recipe scripts (strict JSON, controlled units, no ids) -----------

const BASE_CURRY_RECIPE_JSON = JSON.stringify({
  title: "Poulet au curry au riz basmati",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g" },
    { name: "poudre de curry", quantity: 30, unit: "g" },
    { name: "riz basmati", quantity: 320, unit: "g" },
    { name: "oignons", quantity: 300, unit: "g" },
    { name: "gingembre frais", quantity: 20, unit: "g" },
  ],
  steps: [
    "Émincer les oignons et râper le gingembre frais.",
    "Découper les filets de poulet en morceaux.",
    "Faire revenir le poulet, puis ajouter la poudre de curry.",
    "Ajouter de l'eau, couvrir et laisser mijoter 20 minutes.",
    "Servir avec le riz basmati.",
  ],
  prepMinutes: 15,
  cookMinutes: 25,
  category: "plat principal",
});

const WORCESTERSHIRE_CURRY_RECIPE_JSON = JSON.stringify({
  title: "Poulet au curry à la sauce worcestershire",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g" },
    { name: "poudre de curry", quantity: 30, unit: "g" },
    { name: "sauce worcestershire", quantity: 2, unit: "cuillère à soupe" },
    { name: "riz basmati", quantity: 320, unit: "g" },
    { name: "oignons", quantity: 300, unit: "g" },
  ],
  steps: [
    "Découper les filets de poulet en morceaux.",
    "Faire revenir le poulet avec la poudre de curry.",
    "Déglacer avec la sauce worcestershire.",
    "Servir avec le riz basmati et les oignons émincés.",
  ],
  prepMinutes: 10,
  cookMinutes: 20,
  category: "plat principal",
});

const COCO_CURRY_RECIPE_JSON = JSON.stringify({
  title: "Curry de poulet au lait de coco",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g" },
    { name: "poudre de curry", quantity: 30, unit: "g" },
    { name: "lait de coco", quantity: 400, unit: "ml" },
    { name: "riz basmati", quantity: 320, unit: "g" },
  ],
  steps: [
    "Découper les filets de poulet en morceaux.",
    "Faire revenir le poulet, puis ajouter la poudre de curry.",
    "Verser le lait de coco et laisser mijoter 20 minutes.",
    "Servir avec le riz basmati.",
  ],
  prepMinutes: 15,
  cookMinutes: 20,
  category: "plat principal",
});

/** A06a first attempt: valid JSON shape but forbidden product references. */
const INVALID_RECIPE_WITH_REFERENCE_JSON = JSON.stringify({
  title: "Poulet au curry",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g", id: "P-1001" },
    { name: "poudre de curry", quantity: 30, unit: "g", product_id: "P-1002" },
  ],
  steps: ["Cuire le poulet au curry."],
});

/** A06b first attempt: Markdown fence — rejected by the strict parse. */
const FENCED_RECIPE_TEXT = [
  "Voici la recette demandée :",
  "",
  "```json",
  '{"title":"Poulet au curry","servings":4,"ingredients":[{"name":"filets de poulet","quantity":800,"unit":"g"}],"steps":["Cuire."]}',
  "```",
].join("\n");

/** A06b second attempt: unknown unit — still invalid after the single repair. */
const UNKNOWN_UNIT_RECIPE_JSON = JSON.stringify({
  title: "Poulet au curry",
  servings: 4,
  ingredients: [{ name: "filets de poulet", quantity: 800, unit: "livres" }],
  steps: ["Cuire le poulet au curry."],
});

// ---- expected cart projections (pinned to CATALOGUE_VERSION 1) ----------------

interface ExpectedLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

const BASE_EXPECTED_LINES: ExpectedLine[] = [
  { productId: "P-1001", quantity: 2, unitPrice: 7.2, lineTotal: 14.4 },
  { productId: "P-1002", quantity: 1, unitPrice: 2.85, lineTotal: 2.85 },
  { productId: "P-1004", quantity: 1, unitPrice: 3.4, lineTotal: 3.4 },
  { productId: "P-1005", quantity: 1, unitPrice: 1.6, lineTotal: 1.6 },
  { productId: "P-1008", quantity: 1, unitPrice: 1.2, lineTotal: 1.2 },
];

const BASE_CART_ITEMS: [string, number][] = [
  ["P-1001", 2],
  ["P-1002", 1],
  ["P-1004", 1],
  ["P-1005", 1],
  ["P-1008", 1],
];

const COCO_EXPECTED_LINES: ExpectedLine[] = [
  { productId: "P-1001", quantity: 2, unitPrice: 7.2, lineTotal: 14.4 },
  { productId: "P-1002", quantity: 1, unitPrice: 2.85, lineTotal: 2.85 },
  { productId: "P-1003", quantity: 1, unitPrice: 1.95, lineTotal: 1.95 },
  { productId: "P-1004", quantity: 1, unitPrice: 3.4, lineTotal: 3.4 },
];

const COCO_CART_ITEMS: [string, number][] = [
  ["P-1001", 2],
  ["P-1002", 1],
  ["P-1003", 1],
  ["P-1004", 1],
];

/** A07: the worcestershire recipe has no ginger — 4 lines, 22.25 €. */
const WORCESTERSHIRE_EXPECTED_LINES: ExpectedLine[] = [
  { productId: "P-1001", quantity: 2, unitPrice: 7.2, lineTotal: 14.4 },
  { productId: "P-1002", quantity: 1, unitPrice: 2.85, lineTotal: 2.85 },
  { productId: "P-1004", quantity: 1, unitPrice: 3.4, lineTotal: 3.4 },
  { productId: "P-1005", quantity: 1, unitPrice: 1.6, lineTotal: 1.6 },
];

const WORCESTERSHIRE_CART_ITEMS: [string, number][] = [
  ["P-1001", 2],
  ["P-1002", 1],
  ["P-1004", 1],
  ["P-1005", 1],
];

const FIXTURE_IDS = new Set(FIXTURE_PRODUCTS.map((product) => product.id));

// ---- trace helpers (local to the scenario expectations) ------------------------

function previewLinesOf(result: ShoppingFlowResult): ExpectedLine[] {
  return (result.preview?.lines ?? []).map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
  }));
}

function cartItemsOf(result: ShoppingFlowResult): [string, number][] {
  return (result.cart?.items ?? []).map((item) => [item.product.id, item.quantity] as [string, number]);
}

function searchedIdsOf(trace: readonly TraceEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of trace) {
    if (event.type === "tool_result" && event.name === "search_product" && event.ok) {
      const products = (event.output as { products?: { id: string }[] } | undefined)?.products ?? [];
      for (const product of products) ids.add(product.id);
    }
  }
  return ids;
}

function indexOfFirstAddToCartCall(trace: readonly TraceEvent[]): number {
  return trace.findIndex((event) => event.type === "tool_call" && event.name === "add_to_cart");
}

// ---- common expectation builders -------------------------------------------------

function expectCompletedRun(
  ctx: ScenarioExpectationContext,
  expected: {
    title: string;
    lines: ExpectedLine[];
    total: number;
    cartItems: [string, number][];
  },
): ScenarioCheck[] {
  const { result, check } = ctx;
  const lines = previewLinesOf(result);
  const items = cartItemsOf(result);
  return [
    check("statut completed", result.status === "completed", `statut : ${result.status}`),
    check(
      `recette « ${expected.title} » pour 4 convives`,
      result.recipe?.title === expected.title && result.recipe?.servings === 4,
      `titre : ${result.recipe?.title ?? "aucun"}, convives : ${String(result.recipe?.servings ?? "?")}`,
    ),
    check(
      "aperçu : lignes, quantités et prix attendus",
      JSON.stringify(lines) === JSON.stringify(expected.lines),
      `lignes : ${JSON.stringify(lines)}`,
    ),
    check(
      `total de l'aperçu = ${expected.total.toFixed(2)} €`,
      result.preview?.total === expected.total,
      `total : ${String(result.preview?.total)}`,
    ),
    check(
      "panier final : articles et quantités attendus",
      JSON.stringify(items) === JSON.stringify(expected.cartItems),
      `articles : ${JSON.stringify(items)}`,
    ),
    check(
      `total du panier final = ${expected.total.toFixed(2)} €`,
      result.cart?.total === expected.total,
      `total : ${String(result.cart?.total)}`,
    ),
  ];
}

function expectNoIssues(ctx: ScenarioExpectationContext): ScenarioCheck {
  return ctx.check("aucun problème signalé", ctx.result.issues.length === 0, JSON.stringify(ctx.result.issues));
}

function expectGenerationCalls(ctx: ScenarioExpectationContext, expected: number): ScenarioCheck {
  const calls = ctx.instrumentation?.localCalls() ?? -1;
  return ctx.check(
    `${expected} appel(s) de génération exactement`,
    calls === expected,
    `appels : ${String(calls)}`,
  );
}

// ---- scenario definitions --------------------------------------------------------

const A01: ScenarioDefinition = {
  id: "A01",
  title: "parcours nominal : une recette pour 4 → un panier approuvé",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => [
    ...expectCompletedRun(ctx, {
      title: "Poulet au curry au riz basmati",
      lines: BASE_EXPECTED_LINES,
      total: 23.45,
      cartItems: BASE_CART_ITEMS,
    }),
    ctx.check(
      "règle de conditionnement : 800 g / paquets de 600 g → 2 paquets",
      ctx.result.preview?.lines.find((line) => line.productId === "P-1001")?.quantity === 2,
      "quantité P-1001 inattendue",
    ),
    expectNoIssues(ctx),
    expectGenerationCalls(ctx, 1),
  ],
};

const A02: ScenarioDefinition = {
  id: "A02",
  title: "exclusion d'ingrédient : aucune crème recherchée, prévue ou ajoutée",
  frozenPrompt: A02_PROMPT,
  request: { message: A02_PROMPT.text, servings: 4, excludedIngredients: ["crème"] },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const traceText = JSON.stringify(ctx.trace);
    const creamInRecipe = ctx.result.recipe?.ingredients.some((ingredient) =>
      ingredient.name.toLowerCase().includes("crème"),
    );
    return [
      ...expectCompletedRun(ctx, {
        title: "Poulet au curry au riz basmati",
        lines: BASE_EXPECTED_LINES,
        total: 23.45,
        cartItems: BASE_CART_ITEMS,
      }),
      ctx.check(
        "recette sans crème (exclusion respectée à la génération)",
        creamInRecipe !== true,
        "la recette contient de la crème",
      ),
      ctx.check(
        "aucune trace de la crème P-1007 (recherche, aperçu, panier)",
        !traceText.includes("P-1007") && !traceText.includes("Crème fraîche"),
        "P-1007 ou son libellé apparaît dans la trace",
      ),
      expectNoIssues(ctx),
      expectGenerationCalls(ctx, 1),
    ];
  },
};

const A03: ScenarioDefinition = {
  id: "A03",
  title: "aucun identifiant halluciné : ids mutés issus du catalogue et des recherches",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const appliedIds = ctx.result.gap?.applied.map((line) => line.productId) ?? [];
    const searched = searchedIdsOf(ctx.trace);
    const mutatedInSearch = appliedIds.every((id) => searched.has(id));
    const mutatedInCatalogue = appliedIds.every((id) => FIXTURE_IDS.has(id));
    const previewInCatalogue = (ctx.result.preview?.lines ?? []).every((line) => FIXTURE_IDS.has(line.productId));
    return [
      ...expectCompletedRun(ctx, {
        title: "Poulet au curry au riz basmati",
        lines: BASE_EXPECTED_LINES,
        total: 23.45,
        cartItems: BASE_CART_ITEMS,
      }),
      ctx.check(
        "produits mutés = exactement les 5 ids attendus",
        JSON.stringify(appliedIds) === JSON.stringify(BASE_EXPECTED_LINES.map((line) => line.productId)),
        `ids mutés : ${JSON.stringify(appliedIds)}`,
      ),
      ctx.check(
        "chaque id muté provient d'un résultat de search_product de la même exécution",
        mutatedInSearch,
        `ids hors recherche : ${JSON.stringify(appliedIds.filter((id) => !searched.has(id)))}`,
      ),
      ctx.check(
        "chaque id muté existe dans le catalogue de fixtures",
        mutatedInCatalogue,
        `ids hors catalogue : ${JSON.stringify(appliedIds.filter((id) => !FIXTURE_IDS.has(id)))}`,
      ),
      ctx.check(
        "chaque ligne de l'aperçu référence un produit du catalogue",
        previewInCatalogue,
        "ligne d'aperçu hors catalogue",
      ),
    ];
  },
};

const A04: ScenarioDefinition = {
  id: "A04",
  title: "aucune mutation avant l'approbation, toutes les mutations après",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const requestIndex = ctx.trace.findIndex((event) => event.type === "approval_request");
    const decisionIndex = ctx.trace.findIndex(
      (event) => event.type === "approval_decision" && event.decision === "approved",
    );
    const firstMutationIndex = indexOfFirstAddToCartCall(ctx.trace);
    const safetyBlocks = ctx.trace.filter((event) => event.type === "safety_block");
    const addToCartResults = ctx.trace.filter(
      (event) => event.type === "tool_result" && event.name === "add_to_cart",
    );
    return [
      ...expectCompletedRun(ctx, {
        title: "Poulet au curry au riz basmati",
        lines: BASE_EXPECTED_LINES,
        total: 23.45,
        cartItems: BASE_CART_ITEMS,
      }),
      ctx.check(
        "ordre de trace : demande puis décision d'approbation AVANT le premier ajout au panier",
        requestIndex !== -1 &&
          decisionIndex !== -1 &&
          firstMutationIndex !== -1 &&
          requestIndex < decisionIndex &&
          decisionIndex < firstMutationIndex,
        `demande=${String(requestIndex)}, décision=${String(decisionIndex)}, premier ajout=${String(firstMutationIndex)}`,
      ),
      ctx.check(
        "5 ajouts exécutés après l'approbation, tous en succès",
        addToCartResults.length === 5 && addToCartResults.every((event) => event.type === "tool_result" && event.ok),
        `résultats add_to_cart : ${addToCartResults.length}`,
      ),
      ctx.check(
        "aucun blocage de sûreté (rien de tenté avant l'approbation)",
        safetyBlocks.length === 0,
        `blocages : ${safetyBlocks.length}`,
      ),
    ];
  },
};

const A05: ScenarioDefinition = {
  id: "A05",
  title: "refus d'approbation : panier inchangé, zéro mutation",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: false, reason: "L'utilisateur refuse le panier proposé." },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const mutationCalls = ctx.trace.filter(
      (event) => event.type === "tool_call" && event.name === "add_to_cart",
    );
    const decision = ctx.trace.find((event) => event.type === "approval_decision");
    return [
      ctx.check("statut refused", ctx.result.status === "refused", `statut : ${ctx.result.status}`),
      ctx.check(
        "l'aperçu complet a bien été soumis à l'utilisateur",
        ctx.result.preview?.lines.length === 5,
        `lignes : ${String(ctx.result.preview?.lines.length)}`,
      ),
      ctx.check(
        "décision « refused » tracée",
        decision !== undefined && decision.type === "approval_decision" && decision.decision === "refused",
        "décision absente ou inattendue",
      ),
      ctx.check("aucun appel d'ajout au panier", mutationCalls.length === 0, `appels : ${mutationCalls.length}`),
      ctx.check(
        "panier vide après le refus",
        ctx.mock.state.cart.itemCount === 0 && ctx.mock.state.cart.total === 0,
        `panier : ${JSON.stringify(ctx.mock.state.cart)}`,
      ),
      expectGenerationCalls(ctx, 1),
    ];
  },
};

const A06a: ScenarioDefinition = {
  id: "A06a",
  title: "recette invalide puis UNE réparation guidée → parcours complété",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: INVALID_RECIPE_WITH_REFERENCE_JSON }, { text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const repairs = ctx.trace.filter((event) => event.type === "repair_attempt");
    const repair = repairs[0];
    const repairIssues = repair !== undefined && repair.type === "repair_attempt" ? repair.issues : [];
    const secondRequest = ctx.generationRequests[1];
    return [
      ...expectCompletedRun(ctx, {
        title: "Poulet au curry au riz basmati",
        lines: BASE_EXPECTED_LINES,
        total: 23.45,
        cartItems: BASE_CART_ITEMS,
      }),
      ctx.check(
        "exactement une réparation guidée (tentative 1)",
        repairs.length === 1 && repair?.type === "repair_attempt" && repair.attempt === 1,
        `réparations : ${repairs.length}`,
      ),
      ctx.check(
        "le problème relevé était une référence produit interdite",
        repairIssues.some((issue) => issue.code === "INGREDIENT_REFERENCE"),
        `problèmes : ${JSON.stringify(repairIssues.map((issue) => issue.code))}`,
      ),
      ctx.check(
        "la réparation est guidée : sortie erronée + consigne renvoyées au modèle",
        secondRequest !== undefined &&
          secondRequest.messages.length === 4 &&
          secondRequest.messages[2]?.content === INVALID_RECIPE_WITH_REFERENCE_JSON &&
          (secondRequest.messages[3]?.content ?? "").includes("recette JSON valide"),
        `messages de réparation : ${String(secondRequest?.messages.length)}`,
      ),
      expectNoIssues(ctx),
      expectGenerationCalls(ctx, 2),
    ];
  },
};

const A06b: ScenarioDefinition = {
  id: "A06b",
  title: "recette invalide deux fois → erreur explicite, zéro mutation",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: FENCED_RECIPE_TEXT }, { text: UNKNOWN_UNIT_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const repairs = ctx.trace.filter((event) => event.type === "repair_attempt");
    const toolCalls = ctx.trace.filter((event) => event.type === "tool_call");
    const approvalRequests = ctx.trace.filter((event) => event.type === "approval_request");
    const errors = ctx.trace.filter((event) => event.type === "error");
    return [
      ctx.check("statut recipe_invalid", ctx.result.status === "recipe_invalid", `statut : ${ctx.result.status}`),
      ctx.check(
        "erreur explicite RECIPE_INVALID",
        ctx.result.error?.code === "RECIPE_INVALID",
        `erreur : ${ctx.result.error?.code ?? "aucune"}`,
      ),
      ctx.check("aucune recette retenue", ctx.result.recipe === undefined, "une recette est présente"),
      ctx.check(
        "exactement une réparation tentée (jamais deux)",
        repairs.length === 1,
        `réparations : ${repairs.length}`,
      ),
      ctx.check(
        "aucune erreur tracée RECIPE_INVALID après la réparation",
        errors.some((event) => event.type === "error" && event.code === "RECIPE_INVALID"),
        "erreur RECIPE_INVALID absente de la trace",
      ),
      ctx.check(
        "zéro appel d'outil (aucune recherche, aucune mutation)",
        toolCalls.length === 0,
        `appels d'outil : ${toolCalls.length}`,
      ),
      ctx.check("zéro demande d'approbation", approvalRequests.length === 0, `demandes : ${approvalRequests.length}`),
      ctx.check(
        "panier vide",
        ctx.mock.state.cart.itemCount === 0,
        `articles : ${String(ctx.mock.state.cart.itemCount)}`,
      ),
      expectGenerationCalls(ctx, 2),
    ];
  },
};

const A07: ScenarioDefinition = {
  id: "A07",
  title: "ingrédient introuvable : signalement, aucun identifiant inventé, le reste procède",
  frozenPrompt: A07_PROMPT,
  request: { message: A07_PROMPT.text, servings: 4 },
  providerScript: [{ text: WORCESTERSHIRE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const notFound = ctx.result.issues.filter(
      (issue) => issue.kind === "ingredient_not_found" && issue.ingredient === "sauce worcestershire",
    );
    const emptySearch = ctx.trace.some(
      (event) =>
        event.type === "tool_result" &&
        event.name === "search_product" &&
        !event.ok &&
        event.error?.code === "EMPTY_RESULT",
    );
    const worcestershireLine = ctx.result.preview?.lines.find(
      (line) => line.ingredient === "sauce worcestershire",
    );
    const traceText = JSON.stringify(ctx.trace);
    return [
      ...expectCompletedRun(ctx, {
        title: "Poulet au curry à la sauce worcestershire",
        lines: WORCESTERSHIRE_EXPECTED_LINES,
        total: 22.25,
        cartItems: WORCESTERSHIRE_CART_ITEMS,
      }),
      ctx.check(
        "l'ingrédient introuvable est signalé",
        notFound.length === 1,
        `signalements : ${JSON.stringify(ctx.result.issues)}`,
      ),
      ctx.check(
        "la recherche a bien échoué par EMPTY_RESULT (catalogue sans sauce worcestershire)",
        emptySearch,
        "aucun résultat EMPTY_RESULT tracé",
      ),
      ctx.check(
        "aucune ligne d'aperçu pour l'ingrédient introuvable",
        worcestershireLine === undefined,
        `ligne inattendue : ${JSON.stringify(worcestershireLine)}`,
      ),
      ctx.check(
        "aucun identifiant inventé pour l'ingrédient introuvable",
        !traceText.includes("P-1009") || !ctx.result.preview?.lines.some((line) => line.productId === "P-1009"),
        "référence inattendue dans l'aperçu",
      ),
    ];
  },
};

const A08_FAULTS: FaultPlan = [
  {
    code: "TRANSIENT_ERROR",
    capability: "add_to_cart",
    productId: "P-1002",
    message: "Erreur transitoire injectée par le scénario A08.",
  },
];

const A08: ScenarioDefinition = {
  id: "A08",
  title: "échec d'ajout du second produit : arrêt, relecture, écarts, reprise sûre",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  faults: A08_FAULTS,
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const checks: ScenarioCheck[] = [];
    const { result, check } = ctx;
    const gap = result.gap;
    const failedIndex = ctx.trace.findIndex(
      (event) => event.type === "tool_result" && event.name === "add_to_cart" && !event.ok,
    );
    const rereadIndex = ctx.trace.findIndex(
      (event, index) => event.type === "tool_call" && event.name === "get_cart" && index > failedIndex,
    );

    checks.push(
      check("statut partial_failure", result.status === "partial_failure", `statut : ${result.status}`),
      check(
        "écart appliqué : uniquement P-1001",
        JSON.stringify(gap?.applied.map((line) => line.productId)) === JSON.stringify(["P-1001"]),
        `appliqués : ${JSON.stringify(gap?.applied.map((line) => line.productId))}`,
      ),
      check(
        "écart échoué : P-1002 avec l'erreur injectée",
        gap?.failed.length === 1 &&
          gap.failed[0].line.productId === "P-1002" &&
          gap.failed[0].error.code === "TRANSIENT_ERROR" &&
          gap.failed[0].error.details?.injected === true,
        `échoués : ${JSON.stringify(gap?.failed.map((entry) => [entry.line.productId, entry.error.code]))}`,
      ),
      check(
        "écart non tenté : le reste est arrêté (jamais d'atomicité prétendue)",
        JSON.stringify(gap?.notAttempted.map((line) => line.productId)) ===
          JSON.stringify(["P-1004", "P-1005", "P-1008"]),
        `non tentés : ${JSON.stringify(gap?.notAttempted.map((line) => line.productId))}`,
      ),
      check(
        "relecture de l'état réel du panier observable dans la trace",
        failedIndex !== -1 && rereadIndex !== -1,
        `échec=${String(failedIndex)}, relecture=${String(rereadIndex)}`,
      ),
      check(
        "panier réellement partiel : seul P-1001 (×2) a été ajouté",
        JSON.stringify(cartItemsOf(result)) === JSON.stringify([["P-1001", 2]]),
        `panier : ${JSON.stringify(cartItemsOf(result))}`,
      ),
      check(
        "proposition de reprise : 3 articles restants",
        result.resume !== undefined && result.resume.pending.length === 3,
        `restants : ${String(result.resume?.pending.length)}`,
      ),
    );

    // Reprise 1 : refus → rien ne bouge (l'approbation précédente ne se
    // reporte jamais sur la reprise). A refused resume returns no cart
    // snapshot: the mock state is the ground truth.
    const refusedResume = await ctx.resume({ approved: false, reason: "Pas maintenant." });
    const cartAfterRefusedResume = ctx.mock.state.cart.items.map(
      (item) => [item.product.id, item.quantity] as [string, number],
    );
    checks.push(
      check(
        "reprise refusée : statut refused",
        refusedResume?.result.status === "refused",
        `statut : ${refusedResume?.result.status ?? "aucune reprise"}`,
      ),
      check(
        "reprise refusée : panier toujours partiel et inchangé",
        JSON.stringify(cartAfterRefusedResume) === JSON.stringify([["P-1001", 2]]),
        `panier : ${JSON.stringify(cartAfterRefusedResume)}`,
      ),
    );

    // Reprise 2 : nouvel accord explicite → le reste se complète.
    ctx.mock.setFaultPlan([]);
    const resumed = await ctx.resume({ approved: true });
    const resumedCart = cartItemsOf(resumed?.result ?? result);
    checks.push(
      check(
        "reprise approuvée : statut completed",
        resumed?.result.status === "completed",
        `statut : ${resumed?.result.status ?? "aucune reprise"}`,
      ),
      check(
        "panier final : 4 articles (P-1002 n'a jamais été ajouté)",
        JSON.stringify(resumedCart) ===
          JSON.stringify([["P-1001", 2], ["P-1004", 1], ["P-1005", 1], ["P-1008", 1]]),
        `panier : ${JSON.stringify(resumedCart)}`,
      ),
      check(
        "panier final : total = 20,60 €",
        resumed?.result.cart?.total === 20.6,
        `total : ${String(resumed?.result.cart?.total)}`,
      ),
      check(
        "écarts cumulés : 4 appliqués, 1 échoué, 0 non tenté",
        resumed?.result.gap?.applied.length === 4 &&
          resumed.result.gap?.failed.length === 1 &&
          resumed.result.gap?.notAttempted.length === 0,
        `écarts : ${JSON.stringify({
          appliques: resumed?.result.gap?.applied.length,
          echoues: resumed?.result.gap?.failed.length,
          nonTentes: resumed?.result.gap?.notAttempted.length,
        })}`,
      ),
    );
    return checks;
  },
};

const A09: ScenarioDefinition = {
  id: "A09",
  title: "produit ambigu : question de clarification, réponse de scénario, règle de conditionnement",
  frozenPrompt: A09_PROMPT,
  request: { message: A09_PROMPT.text, servings: 4 },
  providerScript: [{ text: COCO_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  clarificationAnswer: { productId: "P-1003" },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const clarification = ctx.trace.find((event) => event.type === "clarification");
    const question = clarification !== undefined && clarification.type === "clarification" ? clarification.question : undefined;
    const answer = clarification !== undefined && clarification.type === "clarification" ? clarification.answer : undefined;
    const cocoLine = ctx.result.preview?.lines.find((line) => line.ingredient === "lait de coco");
    const packagingDefault = ctx.result.issues.some(
      (issue) => issue.kind === "packaging_default" && issue.ingredient === "lait de coco",
    );
    return [
      ...expectCompletedRun(ctx, {
        title: "Curry de poulet au lait de coco",
        lines: COCO_EXPECTED_LINES,
        total: 22.6,
        cartItems: COCO_CART_ITEMS,
      }),
      ctx.check(
        "question de clarification posée pour « lait de coco » (P-1003 vs P-2001)",
        question?.kind === "ambiguous_match" &&
          question.ingredient === "lait de coco" &&
          JSON.stringify(question.candidates.map((candidate) => candidate.productId)) ===
            JSON.stringify(["P-1003", "P-2001"]),
        `question : ${JSON.stringify(question)}`,
      ),
      ctx.check(
        "réponse de scénario enregistrée : P-1003",
        answer !== undefined && "productId" in answer && answer.productId === "P-1003",
        `réponse : ${JSON.stringify(answer)}`,
      ),
      ctx.check(
        "règle de conditionnement explicite : 400 ml / paquet de 400 ml → 1 paquet",
        cocoLine?.productId === "P-1003" &&
          cocoLine.quantity === 1 &&
          cocoLine.packaging === "400 ml",
        `ligne : ${JSON.stringify(cocoLine)}`,
      ),
      ctx.check(
        "aucun défaut de conditionnement inventé pour la ligne clarifiée",
        !packagingDefault,
        "défaut de conditionnement signalé à tort",
      ),
    ];
  },
};

const A10_PROVIDER_OVERRIDE: ScenarioProviderOverride = {
  create() {
    let probeCalls = 0;
    let pipelineCalls = 0;
    let mistralNetworkCalls = 0;
    const local = new WebGpuProvider({
      modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
      probe: async () => {
        probeCalls++;
        return { ok: false, reason: "scénario A10 : aucun adaptateur WebGPU (sonde injectée en échec)." };
      },
      pipelineFactory: async () => {
        pipelineCalls++;
        throw new Error("A10 : la session locale ne doit jamais être créée (sonde en échec).");
      },
    });
    // Instrumented Mistral BYOK: constructed by the SCENARIO only, never handed
    // to the flow — zero calls proves the cloud was never reached.
    const mistral = new MistralByokProvider({
      apiKey: "cle-de-test-a10",
      model: "mistral-small-latest",
      fetchImpl: async () => {
        mistralNetworkCalls++;
        throw new Error("A10 : aucun appel réseau Mistral attendu.");
      },
    });
    return {
      provider: local,
      instrumentation: {
        localCalls: () => local.calls,
        probeCalls: () => probeCalls,
        pipelineCalls: () => pipelineCalls,
        mistralCalls: () => mistral.calls + mistralNetworkCalls,
      },
    };
  },
};

const A10: ScenarioDefinition = {
  id: "A10",
  title: "WebGPU indisponible : modèle local non lancé, Mistral proposé mais jamais appelé",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [],
  providerOverride: A10_PROVIDER_OVERRIDE,
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const { result, check } = ctx;
    const instrumentation = ctx.instrumentation;
    const toolCalls = ctx.trace.filter((event) => event.type === "tool_call");
    const approvalRequests = ctx.trace.filter((event) => event.type === "approval_request");
    const providerErrors = ctx.trace.filter(
      (event) => event.type === "error" && event.code === "PROVIDER_UNAVAILABLE",
    );
    return [
      check("statut provider_unavailable", result.status === "provider_unavailable", `statut : ${result.status}`),
      check(
        "diagnostic français présent",
        (result.diagnostic ?? "").includes("WebGPU"),
        `diagnostic : ${result.diagnostic ?? "aucun"}`,
      ),
      check(
        "proposition Mistral en données pures, consentement explicite requis",
        result.proposal?.providerId === "mistral-byok" &&
          result.proposal.consentRequired === true,
        `proposition : ${JSON.stringify(result.proposal)}`,
      ),
      check(
        "sonde locale exécutée exactement une fois",
        (instrumentation?.probeCalls() ?? -1) === 1,
        `sondes : ${String(instrumentation?.probeCalls())}`,
      ),
      check(
        "modèle local jamais lancé : zéro appel, zéro session",
        (instrumentation?.localCalls() ?? -1) === 0 && (instrumentation?.pipelineCalls() ?? -1) === 0,
        `appels : ${String(instrumentation?.localCalls())}, sessions : ${String(instrumentation?.pipelineCalls())}`,
      ),
      check(
        "Mistral jamais construit ni appelé par le parcours",
        (instrumentation?.mistralCalls() ?? -1) === 0,
        `appels Mistral : ${String(instrumentation?.mistralCalls())}`,
      ),
      check(
        "aucun appel d'outil ni demande d'approbation",
        toolCalls.length === 0 && approvalRequests.length === 0,
        `outils : ${toolCalls.length}, approbations : ${approvalRequests.length}`,
      ),
      check(
        "erreur PROVIDER_UNAVAILABLE tracée",
        providerErrors.length === 1,
        `erreurs tracées : ${providerErrors.length}`,
      ),
    ];
  },
};

const F01: ScenarioDefinition = {
  id: "F01",
  title: "prompt de génération figé : fixture de comparaison pour un futur fine-tuning",
  frozenPrompt: A01_PROMPT,
  request: { message: A01_PROMPT.text, servings: 4 },
  providerScript: [{ text: BASE_CURRY_RECIPE_JSON }],
  approvalDecision: { approved: true },
  version: SCENARIOS_VERSION,
  generationParams: SCENARIO_GENERATION_PARAMS,
  expectations: async (ctx) => {
    const request = ctx.generationRequests[0];
    const modelText = ctx.trace.find((event) => event.type === "model_text");
    const scriptedText = modelText !== undefined && modelText.type === "model_text" ? modelText.text : undefined;
    return [
      ctx.check(
        "une seule requête de génération capturée",
        ctx.generationRequests.length === 1,
        `requêtes : ${ctx.generationRequests.length}`,
      ),
      ctx.check(
        "prompt système figé, identique octet par octet",
        request?.messages[0]?.role === "system" && request.messages[0]?.content === RECIPE_SYSTEM_PROMPT,
        "prompt système divergent",
      ),
      ctx.check(
        "message utilisateur figé, identique octet par octet",
        request?.messages[1]?.role === "user" && request.messages[1]?.content === ctx.scenario.frozenPrompt.text,
        "message utilisateur divergent",
      ),
      ctx.check(
        "sortie du modèle enregistrée dans la trace (fixture de comparaison)",
        scriptedText === BASE_CURRY_RECIPE_JSON,
        "sortie modèle absente ou divergente",
      ),
      ctx.check(
        "statut completed sur le prompt figé",
        ctx.result.status === "completed",
        `statut : ${ctx.result.status}`,
      ),
      ctx.check(
        "recette rejouée identique",
        ctx.result.recipe?.title === "Poulet au curry au riz basmati",
        `titre : ${ctx.result.recipe?.title ?? "aucun"}`,
      ),
    ];
  },
};

// ---- registry ---------------------------------------------------------------------

export const SCENARIOS: readonly ScenarioDefinition[] = [
  A01,
  A02,
  A03,
  A04,
  A05,
  A06a,
  A06b,
  A07,
  A08,
  A09,
  A10,
  F01,
];

export function getScenario(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}
