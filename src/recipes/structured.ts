/**
 * Structured recipe data extraction (ticket 03).
 *
 * Cooking pages often embed a schema.org/Recipe JSON-LD block. When the user
 * captures such a page, the capture keeps a bounded, plain-text summary of
 * that structured data ahead of the visible excerpt — it usually carries the
 * servings and quantified ingredients the contract requires, which makes the
 * client model's structuring far more reliable than free text alone.
 *
 * Security posture (spec): the page's data is untrusted. Everything is
 * serialized as inert text — angle brackets escaped, nothing executed, no
 * markup boundary — and the block is hard-bounded.
 *
 * Pure module — the background passes the raw `application/ld+json` script
 * texts fetched from the page by the injected function; unit-tested in Node.
 */

/** Hard bound for the structured block stored in the capture. */
export const MAX_STRUCTURED_CHARS = 4000;

const RECIPE_TYPE = "recipe";

function isRecipeNode(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const t = (node as { "@type"?: unknown })["@type"];
  if (typeof t === "string") return t.toLowerCase() === RECIPE_TYPE;
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.toLowerCase() === RECIPE_TYPE);
  return false;
}

/** Depth-first search for a Recipe node, @graph included. */
function findRecipeNode(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || typeof value !== "object" || value === null) return null;
  if (isRecipeNode(value)) return value as Record<string, unknown>;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findRecipeNode(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const found = findRecipeNode(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Inert text: escape markup so nothing can form an HTML/tag boundary. */
function inert(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function asTextArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "object" && v !== null) {
      const text = (v as { text?: unknown }).text;
      if (typeof text === "string") out.push(text);
      const name = (v as { name?: unknown }).name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out.filter((s) => s.trim().length > 0);
}

/**
 * Build the bounded structured block from raw JSON-LD script texts.
 * Returns "" when no usable Recipe node is found. Malformed JSON is skipped
 * silently — the visible excerpt remains the fallback.
 */
export function extractStructuredRecipe(jsonTexts: readonly string[]): string {
  for (const raw of jsonTexts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const node = findRecipeNode(parsed);
    if (!node) continue;

    const lines: string[] = ["--- Données structurées (schema.org/Recipe) ---"];
    const name = node.name;
    if (typeof name === "string" && name.trim()) lines.push(`Titre : ${inert(name.trim())}`);
    const yieldText = node.recipeYield;
    if (typeof yieldText === "string" && yieldText.trim()) {
      lines.push(`Portions : ${inert(yieldText.trim())}`);
    }
    const ingredients = asTextArray(node.recipeIngredient);
    if (ingredients.length > 0) {
      lines.push("Ingrédients :");
      for (const ing of ingredients) lines.push(`- ${inert(ing.trim())}`);
    }
    const steps = asTextArray(node.recipeInstructions);
    if (steps.length > 0) {
      lines.push("Étapes :");
      steps.forEach((step, i) => lines.push(`${i + 1}. ${inert(step.trim())}`));
    }

    let block = lines.join("\n");
    if (block.length > MAX_STRUCTURED_CHARS) {
      block = `${block.slice(0, MAX_STRUCTURED_CHARS - 5)}\n[…]`;
    }
    return block;
  }
  return "";
}
