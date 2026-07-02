/**
 * Recipe inference test fixtures.
 *
 * Each fixture pairs a natural-language request with the *mandatory*
 * ingredients the model is expected to infer — i.e. ingredients without which
 * the dish is not the dish. Optional/common pantry items (sel, poivre, huile,
 * eau…) are deliberately NOT asserted: we only check that the model captures
 * the defining, purchasable ingredients.
 *
 * These fixtures drive `tests/model-inference.test.ts`, which runs the *real*
 * local Qwen3 model (the same `@huggingface/transformers` pipeline the
 * extension's offscreen runtime uses) and verifies the parsed `Plan` contains
 * each mandatory ingredient as a `query` (matched loosely, accent + case
 * insensitive, so "pâtes spaghetti" matches "pate spaghetti").
 *
 * The goal is NOT to make every test pass on the first run — it is to surface
 * where the model's inference diverges from culinary common sense, so the
 * prompt (in `src/orchestrator/prompt.ts`) can be tightened iteratively.
 */

export interface RecipeExpectation {
  /** Short id used in test names. */
  id: string;
  /** Natural-language request exactly as a user would type it. */
  request: string;
  /**
   * Mandatory ingredients the inferred plan MUST contain. Each entry is a list
   * of alternative query fragments: the plan matches if at least one fragment
   * is found (case + accent insensitive) in any item's `query`.
   */
  mandatory: string[][];
  /**
   * Optional: ingredients the plan MUST NOT contain — catches the model
   * hallucinating ingredients foreign to the dish (e.g. tomato in a
   * carbonara).
   */
  forbidden?: string[][];
}

export const RECIPES: RecipeExpectation[] = [
  {
    id: "spaghetti-bolognaise",
    request: "recette de spaghetti bolognaise pour 4 personnes",
    mandatory: [
      ["pâtes spaghetti", "spaghetti", "pate spaghetti"],
      ["tomate", "sauce tomate", "tomate pelée", "pulpe de tomate"],
    ],
    forbidden: [["pâte carbonara"], ["lardons"]],
  },
  {
    id: "carbonara",
    request: "pâtes carbonara pour 2 personnes",
    mandatory: [
      ["pâtes", "spaghetti", "pate"],
      ["lardons", "guanciale", "pancetta"],
      ["oeufs", "oeuf", "jaune d'oeuf"],
      ["parmesan", "pecorino", "fromage râpé"],
    ],
    forbidden: [["tomate"], ["sauce tomate"], ["crème fraîche"]],
  },
  {
    id: "crepes",
    request: "je veux faire des crêpes",
    mandatory: [
      ["farine", "farine de blé"],
      ["oeufs", "oeuf"],
      ["lait"],
    ],
  },
  {
    id: "ratatouille",
    request: "prépare une ratatouille",
    mandatory: [
      ["aubergine"],
      ["courgette"],
      ["tomate"],
    ],
  },
  {
    id: "omelette",
    request: "une omelette au fromage pour 1 personne",
    mandatory: [
      ["oeufs", "oeuf"],
      ["fromage"],
    ],
  },
  {
    id: "direct-ingredient",
    request: "achète 500 g de lardons fumés",
    mandatory: [
      ["lardons fumés", "lardons"],
    ],
  },
];
