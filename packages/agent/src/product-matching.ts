import type { Product } from "@leclerc/contracts";

const STOPWORDS = new Set([
  "de", "du", "des", "le", "la", "les", "l", "d", "a", "au", "aux", "et", "en", "un", "une",
]);

export function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map((token) => token.length > 3 && token.endsWith("s") && !token.endsWith("us") ? token.slice(0, -1) : token);
}

export function matchesIngredientIdentity(ingredient: string, label: string): boolean {
  const tokens = tokenize(ingredient);
  const productTokens = new Set(tokenize(label));
  // A shared adjective is insufficient: e.g. « blancs » in an unrelated food.
  if (!tokens[0] || !productTokens.has(tokens[0])) return false;
  // Search results may contain ready meals and substitutes named after the
  // requested ingredient. Never treat them as that ingredient automatically.
  const transformations = [
    /\b(vege|vegetal\w*|vegetarien\w*|vegan)\b/,
    /\bplat(?:s)? cuisine\w*\b/,
    /\b(cassoulet|choucroute|pizza|quiche|soupe|veloute|puree|croquette)\b/,
  ];
  return transformations.every((pattern) => !pattern.test(fold(label)) || pattern.test(fold(ingredient)));
}

/**
 * Explicit matching rule: a product's score for an ingredient is the number
 * of the ingredient's meaningful tokens found in the product label, with
 * singular/plural normalization. Candidates must also match the ingredient's
 * first meaningful word and pass the prepared-food/substitute filter. Ties
 * are ordered by ascending product id and resolved by clarification.
 */
function matchScore(ingredientTokens: string[], labelTokens: Set<string>): number {
  let score = 0;
  for (const token of ingredientTokens) {
    if (labelTokens.has(token)) score++;
  }
  return score;
}

type MatchOutcome =
  | { kind: "selected"; product: Product; score: number }
  | { kind: "ambiguous"; candidates: Product[]; score: number }
  | { kind: "none" };

export function matchIngredient(ingredientName: string, products: Product[]): MatchOutcome {
  const ingredientTokens = tokenize(ingredientName);
  const scored = products
    .filter((product) => matchesIngredientIdentity(ingredientName, product.label))
    .map((product) => ({
      product,
      score: matchScore(ingredientTokens, new Set(tokenize(product.label))),
    }))
    .filter((entry) => entry.score >= 1);
  if (scored.length === 0) return { kind: "none" };
  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored
    .filter((entry) => entry.score === best)
    .sort((a, b) => (a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0));
  if (top.length === 1) return { kind: "selected", product: top[0].product, score: best };
  return { kind: "ambiguous", candidates: top.map((entry) => entry.product), score: best };
}

// ---- packaging ceil rule -------------------------------------------------------

type UnitFamily = "mass" | "volume" | "count";

const MASS_FACTORS: Record<string, number> = {
  g: 1, gr: 1, gramme: 1, grammes: 1, kg: 1000,
  // Kitchen equivalences (fixed approximations, base unit g).
  pincee: 1, pincees: 1, poignee: 30, poignees: 30,
};
const VOLUME_FACTORS: Record<string, number> = {
  ml: 1, cl: 10, l: 1000,
  // Kitchen equivalences (fixed approximations, base unit ml).
  "cuillere a soupe": 15, "cuillere soupe": 15, "c a soupe": 15, cs: 15, cas: 15, "c a s": 15,
  "cuillere a cafe": 5, "cuillere cafe": 5, "c a cafe": 5, cc: 5, cac: 5, "c a c": 5,
  filet: 10, filets: 10, tasse: 250, tasses: 250,
};
const COUNT_FACTORS: Record<string, number> = {
  piece: 1, pieces: 1, tranche: 1, tranches: 1, gousse: 1, gousses: 1,
  sachet: 1, sachets: 1, boite: 1, boites: 1, pot: 1, pots: 1, botte: 1, bottes: 1,
  bouquet: 1, bouquets: 1, brin: 1, brins: 1, barquette: 1, barquettes: 1,
};

function unitFactor(unit: string): { family: UnitFamily; factor: number } | undefined {
  const folded = fold(unit).replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  if (folded in MASS_FACTORS) return { family: "mass", factor: MASS_FACTORS[folded] };
  if (folded in VOLUME_FACTORS) return { family: "volume", factor: VOLUME_FACTORS[folded] };
  if (folded in COUNT_FACTORS) return { family: "count", factor: COUNT_FACTORS[folded] };
  return undefined;
}

/**
 * DOCUMENTED EXPLICIT RULE — packaging ceil: the purchase quantity is the
 * number of sales packages needed to cover the ingredient quantity:
 * ceil(needed amount in base unit / packaging amount in base unit), minimum 1.
 * Recipe kitchen units (cuillère à soupe, pincée…) are converted into the
 * packaging family by fixed approximations. A counted need (pièces, gousses…)
 * against a weighed or measured package accepts the larger package as a
 * single unit: the sale package is presumed to carry the pieces. When the
 * packaging is missing, unexploitable, or of another family, an EXPLICIT
 * DEFAULT of 1 package is applied and reported as an issue (never an
 * invented quantity).
 */
export function purchaseQuantity(
  needed: { quantity: number; unit: string },
  packaging: string | undefined,
): { quantity: number; note?: string } {
  if (packaging === undefined) {
    return {
      quantity: 1,
      note: "Conditionnement inconnu : quantité par défaut de 1 unité.",
    };
  }
  const need = unitFactor(needed.unit);
  const measurements = fold(packaging).split(" / ")
    .map((part) => part.match(/^([0-9]+(?:[.,][0-9]+)?)\s*([a-z ]+)$/))
    .filter((part) => part !== null);
  const parsed = measurements.find((part) => unitFactor(part[2])?.family === need?.family) ?? measurements[0];
  if (!parsed) {
    return {
      quantity: 1,
      note: `Conditionnement « ${packaging} » non exploitable : quantité par défaut de 1 unité.`,
    };
  }
  const packAmount = parseFloat(parsed[1].replace(",", "."));
  const pack = unitFactor(parsed[2]);
  if (!pack || !need || packAmount <= 0) {
    return {
      quantity: 1,
      note: `Unité « ${needed.unit} » incompatible avec le conditionnement « ${packaging} » : quantité par défaut de 1 unité.`,
    };
  }
  if (pack.family !== need.family) {
    if (need.family === "count") return { quantity: 1 };
    return {
      quantity: 1,
      note: `Unité « ${needed.unit} » incompatible avec le conditionnement « ${packaging} » : quantité par défaut de 1 unité.`,
    };
  }
  const neededBase = needed.quantity * need.factor;
  const packBase = packAmount * pack.factor;
  return { quantity: Math.max(1, Math.ceil(neededBase / packBase)) };
}

