/**
 * Normaliseur déterministe de liste de courses.
 *
 * Port isolé et fidèle de mcp-leclerc-drive (src/orchestrator/shopping-list.ts).
 * L'API IA reste filet de sécurité, mais les listes explicites ne
 * dépendent pas de la qualité générative : ce parseur couvre la surface v1
 * (produits directs, listes virgules/retours, comptes unitaires, poids/volumes,
 * refus des recettes seules).
 */

import type { Plan, PlanItem } from './plan';

const RECIPE_QUESTION = 'Donne-moi les ingrédients à acheter pour cette recette.';

const DISH_WORDS = [
  'carbonara',
  'ratatouille',
  'bolognaise',
  'crêpes',
  'crepes',
  'omelette',
  'lasagnes',
  'couscous',
  'tartiflette',
];

export interface NormalizeOk {
  ok: true;
  plan: Plan;
  source: 'deterministic';
}
export type NormalizeResult = NormalizeOk | null;

export function normalizeShoppingList(text: string): NormalizeResult {
  const input = text.trim();
  if (!input) return null;

  if (isRecipeOnlyRequest(input)) {
    return { ok: true, source: 'deterministic', plan: { items: [], questions: [RECIPE_QUESTION] } };
  }

  const items = splitList(input).flatMap(parseListPart);
  if (items.length === 0) return null;

  return { ok: true, source: 'deterministic', plan: { items } };
}

function isRecipeOnlyRequest(input: string): boolean {
  const normalized = normalize(input);
  if (/\b(recette|plat|menu)\b/.test(normalized)) return true;
  if (DISH_WORDS.some((word) => normalized.includes(normalize(word)))) {
    return !hasExplicitGroceryShape(normalized);
  }
  return false;
}

function hasExplicitGroceryShape(normalized: string): boolean {
  return (
    /[,;\n]/.test(normalized) ||
    /\bx\s*\d+\b/.test(normalized) ||
    /\b\d+\s*(g|kg|l|ml|cl)\b/.test(normalized) ||
    /\b\d+\s+(paquets?|bouteilles?|boites?|boîtes?|pots?|sachets?|barquettes?)\b/.test(normalized)
  );
}

function splitList(input: string): string[] {
  return stripRecipePrefix(input)
    .replace(/\r/g, '\n')
    .split(/[\n,;]+/g)
    .map((part) => part.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean);
}

function stripRecipePrefix(input: string): string {
  const colon = input.indexOf(':');
  if (colon === -1) return input;
  const prefix = normalize(input.slice(0, colon));
  if (/\b(recette|plat|menu)\b/.test(prefix)) return input.slice(colon + 1);
  if (DISH_WORDS.some((word) => prefix.includes(normalize(word)))) return input.slice(colon + 1);
  return input;
}

function parseListPart(raw: string): PlanItem[] {
  let part = raw
    .trim()
    .replace(/^(?:ach[eè]te|acheter|prends?|prendre|ajoute|ajouter)\s+/i, '')
    .trim();
  if (!part) return [];

  let quantity = 1;
  let constraints: string | undefined;

  const unitCount = part.match(
    /^(\d{1,2})\s+(paquets?|bouteilles?|boites?|boîtes?|pots?|sachets?|barquettes?)\s+(?:de |d'|du |des )?(.+)$/i,
  );
  if (unitCount) {
    quantity = clampQuantity(Number(unitCount[1]));
    constraints = unitCount[2].toLocaleLowerCase('fr-FR');
    part = unitCount[3].trim();
  }

  const trailingCount =
    part.match(/\s+x\s*(\d{1,2})\s*$/i) ?? part.match(/\s+x(\d{1,2})\s*$/i);
  if (trailingCount) {
    quantity = clampQuantity(Number(trailingCount[1]));
    part = part.slice(0, trailingCount.index).trim();
  }

  const leadingMeasure = part.match(
    /^(\d+(?:[,.]\d+)?)\s*(kg|g|l|ml|cl)\s+(?:de |d'|du |des )?(.+)$/i,
  );
  if (leadingMeasure) {
    constraints = formatMeasure(leadingMeasure[1], leadingMeasure[2]);
    part = leadingMeasure[3].trim();
  } else {
    const trailingMeasure = part.match(/\b(\d+(?:[,.]\d+)?)\s*(kg|g|l|ml|cl)\b\s*$/i);
    if (trailingMeasure) {
      constraints = formatMeasure(trailingMeasure[1], trailingMeasure[2]);
      part = part.slice(0, trailingMeasure.index).trim();
    }
  }

  const query = cleanQuery(part);
  if (!query || isRecipeOnlyRequest(query)) return [];

  return [{ query, quantity, ...(constraints ? { constraints } : {}) }];
}

function cleanQuery(raw: string): string {
  return raw.replace(/^(?:de |d'|du |des )/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function formatMeasure(value: string, unit: string): string {
  const normalizedUnit = unit.toLocaleLowerCase('fr-FR') === 'l' ? 'L' : unit.toLocaleLowerCase('fr-FR');
  return `${value.replace(',', '.')} ${normalizedUnit}`;
}
function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(99, Math.trunc(value)));
}
function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}
