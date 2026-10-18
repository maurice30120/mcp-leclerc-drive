/**
 * Ingredient calculation — the deterministic arithmetic of the recipe
 * capability (tickets 15–18).
 *
 * What the calculator does (and only that):
 *   - multiplies each ingredient by target_servings / reference servings;
 *   - applies explicit temporary adaptations BEFORE the portions factor, with
 *     quantities expressed for the reference servings — the stored recipe is
 *     never modified and no variant is persisted;
 *   - sums only lines sharing the same normalized ingredient name AND the
 *     same unit; different units stay distinct even when a conversion would
 *     be possible; no semantic equivalence is ever deduced.
 *
 * What stays with the agent: choosing the recipes, the portions, the
 * substitutions, and mapping quantities to commercial packagings.
 *
 * Pure module — resolver-injected, unit-tested in Node.
 */

import type { Recipe, RecipeIngredient } from "./contract.js";

/** One retained recipe with its target servings and temporary adaptations. */
export interface CalcEntry {
  recipe_id: string;
  /** Portions wanted for this recipe (integer >= 1). */
  target_servings: number;
  /**
   * Temporary substitutions for this calculation only. A replacement quantity
   * is expressed for the recipe's REFERENCE servings; omitting the
   * replacement removes the ingredient.
   */
  substitutions?: Array<{
    /** Normalized-or-raw name of the reference ingredient to replace. */
    name: string;
    /** Mandatory close replacement — removing an ingredient is not a light
     *  adaptation and stays an explicit user instruction outside this tool. */
    replacement: { name: string; quantity: number; unit: string };
  }>;
}

/** One scaled ingredient line of one entry. */
export interface CalcLine {
  name: string;
  quantity: number;
  unit: string;
}

/** One grouped ingredient line: total + per-recipe contributions. */
export interface CalcGroupedLine {
  name: string;
  unit: string;
  total: number;
  contributions: Array<{ recipe: string; quantity: number }>;
}

export interface CalcEntryResult {
  recipe: Recipe;
  targetServings: number;
  factor: number;
  lines: CalcLine[];
}

export interface CalcResult {
  entries: CalcEntryResult[];
  grouped: CalcGroupedLine[];
}

export interface CalcOk {
  ok: true;
  result: CalcResult;
}

export interface CalcErr {
  ok: false;
  error: string;
}

export type CalculateResult = CalcOk | CalcErr;

/** Deterministic superficial normalization — mirror of contract.ts helpers. */
function normName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Render a quantity with stable decimals (no premature rounding in sums). */
export function formatQuantity(quantity: number): string {
  const rounded = Math.round(quantity * 10000) / 10000;
  return String(rounded);
}

function applySubstitutions(
  ingredients: RecipeIngredient[],
  substitutions: NonNullable<CalcEntry["substitutions"]>,
): RecipeIngredient[] {
  return ingredients.flatMap((ing) => {
    const sub = substitutions.find((s) => normName(s.name) === ing.name);
    if (!sub) return [ing];
    return [
      {
        name: normName(sub.replacement.name),
        quantity: sub.replacement.quantity,
        unit: sub.replacement.unit.trim().toLowerCase(),
      },
    ];
  });
}

/**
 * Scale + group the retained recipes. `resolve` looks recipes up in the
 * embedded catalogue and the personal library — the caller owns that order.
 */
export function calculateIngredients(
  entries: unknown,
  resolve: (id: string) => Recipe | undefined,
): CalculateResult {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: "Fournis au moins une recette avec ses portions cibles." };
  }

  const parsed: Array<{ recipe: Recipe; target: number; lines: CalcLine[] }> = [];
  const unknown: string[] = [];

  for (const [i, raw] of entries.entries()) {
    const o = raw as Partial<CalcEntry>;
    const id = typeof o.recipe_id === "string" ? o.recipe_id.trim() : "";
    if (id.length === 0) {
      return { ok: false, error: `entries[${i}].recipe_id doit être un identifiant non vide.` };
    }
    const target = o.target_servings;
    if (
      typeof target !== "number" ||
      !Number.isInteger(target) ||
      target < 1
    ) {
      return {
        ok: false,
        error: `entries[${i}].target_servings (${id}) doit être un entier >= 1.`,
      };
    }
    const recipe = resolve(id);
    if (!recipe) {
      unknown.push(id);
      continue;
    }
    const factor = target / recipe.servings;
    let base = recipe.ingredients;
    if (o.substitutions !== undefined) {
      if (!Array.isArray(o.substitutions)) {
        return { ok: false, error: `entries[${i}].substitutions doit être une liste.` };
      }
      for (const [j, sub] of o.substitutions.entries()) {
        if (
          typeof sub !== "object" ||
          sub === null ||
          typeof (sub as { name?: unknown }).name !== "string" ||
          typeof (sub as { replacement?: unknown }).replacement !== "object" ||
          (sub as { replacement?: unknown }).replacement === null
        ) {
          return {
            ok: false,
            error:
              `entries[${i}].substitutions[${j}] doit fournir un remplacement explicite ` +
              `(nom, quantité pour les portions de référence, unité) ; retirer un ingrédient ` +
              `n'est pas une adaptation légère.`,
          };
        }
      }
      base = applySubstitutions(base, o.substitutions);
    }
    parsed.push({
      recipe,
      target,
      lines: base.map((ing) => ({
        name: ing.name,
        quantity: ing.quantity * factor,
        unit: ing.unit,
      })),
    });
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Recette(s) inconnue(s) : ${unknown.join(", ")}. Utilise search_recipes pour trouver les identifiants valides.`,
    };
  }

  // Strict grouping: same normalized name + same unit only.
  const groupedMap = new Map<string, CalcGroupedLine>();
  const key = (name: string, unit: string) => `${name}|${unit}`;
  for (const entry of parsed) {
    for (const line of entry.lines) {
      const k = key(line.name, line.unit);
      const g = groupedMap.get(k) ?? {
        name: line.name,
        unit: line.unit,
        total: 0,
        contributions: [],
      };
      g.total += line.quantity;
      g.contributions.push({ recipe: entry.recipe.title, quantity: line.quantity });
      groupedMap.set(k, g);
    }
  }

  const grouped = [...groupedMap.values()].sort((a, b) =>
    a.name === b.name ? a.unit.localeCompare(b.unit) : a.name.localeCompare(b.name, "fr"),
  );

  return {
    ok: true,
    result: {
      entries: parsed.map((p) => ({
        recipe: p.recipe,
        targetServings: p.target,
        factor: p.target / p.recipe.servings,
        lines: p.lines,
      })),
      grouped,
    },
  };
}
