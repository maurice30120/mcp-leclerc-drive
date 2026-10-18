/**
 * Versioned common contract for every recipe handled by the plugin.
 *
 * Both collections share this shape: the embedded catalogue (delivered with
 * the extension, already structured) and the personal library (validated
 * recipes structured by the MCP client's model from a captured page).
 *
 * Required fields: stable id, title, positive reference servings, a non-empty
 * list of quantified ingredients (normalized name + explicit unit) and
 * non-empty steps, plus a provenance record. Category, prep time and cook
 * time are optional. A record missing any required field — or carrying an
 * invalid numeric value — is rejected whole: no partial recipe, no invented
 * quantity.
 *
 * Pure data validation only — no fetch, no storage, safe to bundle into every
 * extension context and to unit-test in Node.
 */

export const RECIPE_CONTRACT_VERSION = 1 as const;

/** Quantified ingredient: normalized name + finite positive quantity + unit. */
export interface RecipeIngredient {
  /** Deterministic superficial normalization (see normalizeIngredientName). */
  name: string;
  /** Finite number, strictly positive. */
  quantity: number;
  /** Explicit, trimmed, lowercased unit, e.g. "g", "ml", "pièce". */
  unit: string;
}

/** Provenance of a catalogue recipe (delivered with the extension). */
export interface CatalogueProvenance {
  origin: "catalogue";
  /** Human-readable source name, e.g. "Wikilivres" or "mcp-leclerc-drive". */
  source: string;
  /** Source page URL, when the recipe derives from one. */
  url?: string;
  /** Licence notice covering the recipe data (distinct from the MIT code). */
  licence: string;
  /** Authors / page attribution to preserve. */
  attribution?: string;
  /** Description of adaptations applied to the source version, if any. */
  adaptations?: string;
}

/** Provenance of a personal recipe (structured from a captured page). */
export interface PersonalProvenance {
  origin: "personnelle";
  /** URL of the captured page the recipe was structured from. */
  url: string;
  /** ISO date-time of the capture. */
  savedAt: string;
}

export type RecipeProvenance = CatalogueProvenance | PersonalProvenance;

/** A complete, validated recipe in the common versioned contract. */
export interface Recipe {
  contractVersion: typeof RECIPE_CONTRACT_VERSION;
  /** Stable, non-empty identifier. */
  id: string;
  title: string;
  /** Reference servings the quantities correspond to (integer >= 1). */
  servings: number;
  ingredients: RecipeIngredient[];
  steps: string[];
  provenance: RecipeProvenance;
  /** Optional dish category, e.g. "dessert". */
  category?: string;
  /** Optional prep time in minutes. */
  prepMinutes?: number;
  /** Optional cook time in minutes. */
  cookMinutes?: number;
}

export interface ParseRecipeOk {
  ok: true;
  recipe: Recipe;
}

export interface ParseRecipeErr {
  ok: false;
  error: string;
}

export type ParseRecipeResult = ParseRecipeOk | ParseRecipeErr;

/** Internal ok/err helper so sub-parsers compose without casts. */
type Result<T> = { ok: true; value: T } | ParseRecipeErr;

function err(error: string): ParseRecipeErr {
  return { ok: false, error };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Deterministic, superficial ingredient-name normalization. */
export function normalizeIngredientName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Deterministic unit normalization (trim + lowercase). */
export function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

function asObject(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Trimmed non-empty string, or null. */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function positiveInteger(v: unknown, field: string): Result<number> {
  if (!isFiniteNumber(v) || !Number.isInteger(v) || v < 1) {
    return err(`${field} doit être un entier positif (reçu : ${String(v)}).`);
  }
  return ok(v);
}

function optionalPositiveInteger(
  recipe: Record<string, unknown>,
  field: "prepMinutes" | "cookMinutes",
): Result<number | undefined> {
  const v = recipe[field];
  if (v === undefined) return ok(undefined);
  const n = positiveInteger(v, field);
  return n.ok ? ok(n.value) : n;
}

function parseIngredients(v: unknown): Result<RecipeIngredient[]> {
  if (!Array.isArray(v) || v.length === 0) {
    return err("ingredients doit être une liste non vide d'ingrédients quantifiés.");
  }
  const ingredients: RecipeIngredient[] = [];
  for (const [i, raw] of v.entries()) {
    const o = asObject(raw);
    if (!o) return err(`ingredients[${i}] doit être un objet.`);
    const name = nonEmptyString(o.name);
    if (!name) return err(`ingredients[${i}].name doit être un nom d'ingrédient non vide.`);
    if (!isFiniteNumber(o.quantity) || (o.quantity as number) <= 0) {
      return err(`ingredients[${i}].quantity doit être un nombre fini strictement positif.`);
    }
    const unit = nonEmptyString(o.unit);
    if (!unit) return err(`ingredients[${i}].unit doit être une unité explicite non vide.`);
    ingredients.push({
      name: normalizeIngredientName(name),
      quantity: o.quantity as number,
      unit: normalizeUnit(unit),
    });
  }
  return ok(ingredients);
}

function parseSteps(v: unknown): Result<string[]> {
  if (!Array.isArray(v) || v.length === 0) {
    return err("steps doit être une liste non vide d'étapes de préparation.");
  }
  const steps: string[] = [];
  for (const [i, raw] of v.entries()) {
    const s = nonEmptyString(raw);
    if (!s) return err(`steps[${i}] doit être une étape non vide.`);
    steps.push(s);
  }
  return ok(steps);
}

function parseProvenance(v: unknown): Result<RecipeProvenance> {
  const o = asObject(v);
  if (!o) return err("provenance doit décrire l'origine de la recette.");
  if (o.origin === "catalogue") {
    const source = nonEmptyString(o.source);
    if (!source) return err("provenance.source doit être un nom de source non vide.");
    const licence = nonEmptyString(o.licence);
    if (!licence) {
      return err("provenance.licence doit indiquer la licence du catalogue (distincte du code).");
    }
    const prov: CatalogueProvenance = { origin: "catalogue", source, licence };
    const url = nonEmptyString(o.url);
    if (o.url !== undefined && !url) return err("provenance.url doit être une URL non vide.");
    if (url) prov.url = url;
    const attribution = nonEmptyString(o.attribution);
    if (o.attribution !== undefined && !attribution) {
      return err("provenance.attribution doit être une mention non vide.");
    }
    if (attribution) prov.attribution = attribution;
    const adaptations = nonEmptyString(o.adaptations);
    if (o.adaptations !== undefined && !adaptations) {
      return err("provenance.adaptations doit être une mention non vide.");
    }
    if (adaptations) prov.adaptations = adaptations;
    return ok(prov);
  }
  if (o.origin === "personnelle") {
    const url = nonEmptyString(o.url);
    if (!url) return err("provenance.url (recette personnelle) doit être l'URL source non vide.");
    if (!/^https?:\/\//i.test(url)) {
      return err("provenance.url (recette personnelle) doit être une URL http(s).");
    }
    const savedAt = nonEmptyString(o.savedAt);
    if (!savedAt || Number.isNaN(Date.parse(savedAt))) {
      return err("provenance.savedAt doit être une date ISO valide.");
    }
    return ok({ origin: "personnelle", url, savedAt });
  }
  return err("provenance.origin doit valoir « catalogue » ou « personnelle ».");
}

/**
 * Validate an untrusted recipe payload against the common contract.
 * Returns a whole, normalized recipe or an exploitable error — never a
 * partial recipe, never an invented quantity.
 */
export function parseRecipe(input: unknown): ParseRecipeResult {
  const o = asObject(input);
  if (!o) return err("La recette doit être un objet JSON.");

  const id = nonEmptyString(o.id);
  if (!id) return err("id doit être un identifiant stable non vide.");
  if (!/^[\p{L}\p{N}\-_.]+$/u.test(id)) {
    return err("id doit être composé de lettres, chiffres, tirets, points ou underscores.");
  }

  const title = nonEmptyString(o.title);
  if (!title) return err("title doit être un titre non vide.");

  if (o.servings === undefined) {
    return err("servings est obligatoire : une recette sans portions de référence est refusée.");
  }
  const servings = positiveInteger(o.servings, "servings");
  if (!servings.ok) return servings;

  const ingredients = parseIngredients(o.ingredients);
  if (!ingredients.ok) return ingredients;

  const steps = parseSteps(o.steps);
  if (!steps.ok) return steps;

  const provenance = parseProvenance(o.provenance);
  if (!provenance.ok) return provenance;

  const recipe: Recipe = {
    contractVersion: RECIPE_CONTRACT_VERSION,
    id: id,
    title,
    servings: servings.value,
    ingredients: ingredients.value,
    steps: steps.value,
    provenance: provenance.value,
  };

  if (o.category !== undefined) {
    const category = nonEmptyString(o.category);
    if (!category) return err("category, si présent, doit être une catégorie non vide.");
    recipe.category = category;
  }

  const prep = optionalPositiveInteger(o, "prepMinutes");
  if (!prep.ok) return prep;
  if (prep.value !== undefined) recipe.prepMinutes = prep.value;

  const cook = optionalPositiveInteger(o, "cookMinutes");
  if (!cook.ok) return cook;
  if (cook.value !== undefined) recipe.cookMinutes = cook.value;

  return { ok: true, recipe };
}

/** Type guard: is this stored value a complete validated recipe? */
export function isRecipe(input: unknown): input is Recipe {
  return parseRecipe(input).ok;
}
