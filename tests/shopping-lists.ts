/**
 * Shopping-list inference test fixtures.
 *
 * Each fixture pairs a user request with the products the local model is
 * allowed to normalize. The model must not infer ingredients from a recipe or
 * dish name; recipe-only requests should return an empty plan plus a question.
 */

export interface ExpectedQuantity {
  /** Query fragments that identify the item whose quantity is asserted. */
  item: string[];
  quantity: number;
}

export interface ShoppingListExpectation {
  /** Short id used in test names. */
  id: string;
  /** Natural-language request exactly as a user would type it. */
  request: string;
  /**
   * Mandatory explicit products the normalized plan MUST contain. Each entry is
   * a list of alternative query fragments matched case/accent-insensitively.
   */
  mandatory?: string[][];
  /** Optional products the plan MUST NOT contain. */
  forbidden?: string[][];
  /** Optional quantity checks for explicit unit counts such as x2 or x6. */
  quantities?: ExpectedQuantity[];
  /** True when the request should be refused with an empty plan + question. */
  expectClarification?: boolean;
}

export const SHOPPING_LISTS: ShoppingListExpectation[] = [
  {
    id: "direct-ingredient-with-weight",
    request: "achète 500 g de lardons fumés",
    mandatory: [["lardons fumés", "lardons"]],
  },
  {
    id: "comma-separated-list",
    request: "lait demi-écrémé 1L, oeufs x6, farine 1kg",
    mandatory: [
      ["lait demi-écrémé", "lait"],
      ["oeufs", "oeuf"],
      ["farine"],
    ],
    quantities: [{ item: ["oeufs", "oeuf"], quantity: 6 }],
  },
  {
    id: "multiline-list",
    request: "- riz basmati 1 kg\n- poulet x2\n- tomates cerises 250 g",
    mandatory: [
      ["riz basmati", "riz"],
      ["poulet"],
      ["tomates cerises", "tomate"],
    ],
    quantities: [{ item: ["poulet"], quantity: 2 }],
  },
  {
    id: "explicit-package-count",
    request: "2 paquets de pâtes spaghetti",
    mandatory: [["pâtes spaghetti", "spaghetti", "pates"]],
    quantities: [{ item: ["spaghetti", "pâtes", "pates"], quantity: 2 }],
  },
  {
    id: "refuses-dish-name",
    request: "carbonara pour 4",
    expectClarification: true,
    forbidden: [["lardons"], ["oeufs"], ["parmesan"], ["tomate"]],
  },
  {
    id: "refuses-recipe-request",
    request: "recette de crêpes",
    expectClarification: true,
    forbidden: [["farine"], ["oeufs"], ["lait"]],
  },
];
