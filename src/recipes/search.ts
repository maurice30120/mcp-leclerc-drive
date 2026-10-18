/**
 * Unified recipe search — one query across the embedded catalogue and the
 * personal library, with compact results and pagination (tickets 12–14, 30).
 *
 * Deterministic and superficial by design: case- and accent-insensitive
 * matching over title, category and ingredient names; multi-word queries are
 * AND-ed; no synonyms, no stemming, no semantic equivalence. Result lines are
 * compact (id, title, servings, origin) — the full recipe comes from
 * `get_recipe`. Identifiers are unambiguous because personal recipes are
 * always `pers-…` (see library.ts).
 *
 * Pure module — collections are injected, unit-tested in Node.
 */

import type { Recipe } from "./contract.js";

export const DEFAULT_SEARCH_PAGE_SIZE = 10;
export const MAX_SEARCH_PAGE_SIZE = 50;

export type RecipeOrigin = "catalogue" | "personnelle";

/** Compact search result line. */
export interface RecipeSearchResult {
  id: string;
  title: string;
  servings: number;
  origin: RecipeOrigin;
}

export interface SearchPage {
  results: RecipeSearchResult[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number;
}

export interface SearchSources {
  catalogue: readonly Recipe[];
  personal: readonly Recipe[];
}

export interface SearchOptions {
  page?: number;
  pageSize?: number;
}

/** Accent-folding + case-folding normalization (deterministic, superficial). */
function fold(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Does `query` match this recipe (title, category or any ingredient name)? */
function matches(recipe: Recipe, terms: string[]): boolean {
  const haystacks = [
    fold(recipe.title),
    recipe.category ? fold(recipe.category) : "",
    ...recipe.ingredients.map((i) => fold(i.name)),
  ];
  return terms.every((term) =>
    haystacks.some((h) => term.length === 0 || h.includes(term)),
  );
}

/**
 * Search both collections. Empty query matches everything. `page` starts at
 * 1; `pageSize` defaults to {@link DEFAULT_SEARCH_PAGE_SIZE}, capped at
 * {@link MAX_SEARCH_PAGE_SIZE}. Invalid pagination throws — the tool layer
 * turns it into an exploitable MCP error.
 */
export function searchRecipes(
  query: unknown,
  sources: SearchSources,
  options: SearchOptions = {},
): SearchPage {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("page doit être un entier >= 1.");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_SEARCH_PAGE_SIZE) {
    throw new Error(`pageSize doit être un entier entre 1 et ${MAX_SEARCH_PAGE_SIZE}.`);
  }

  const q = typeof query === "string" ? query : "";
  const terms = fold(q).split(" ").filter((t) => t.length > 0);

  const all: RecipeSearchResult[] = [
    ...sources.catalogue.map((r) => ({
      id: r.id,
      title: r.title,
      servings: r.servings,
      origin: "catalogue" as const,
    })),
    ...sources.personal.map((r) => ({
      id: r.id,
      title: r.title,
      servings: r.servings,
      origin: "personnelle" as const,
    })),
  ];

  const matched = all
    .filter((line) => {
      const recipe =
        line.origin === "catalogue"
          ? sources.catalogue.find((r) => r.id === line.id)
          : sources.personal.find((r) => r.id === line.id);
      return recipe ? matches(recipe, terms) : false;
    })
    .sort((a, b) => a.title.localeCompare(b.title, "fr") || a.id.localeCompare(b.id));

  const start = (page - 1) * pageSize;
  const results = matched.slice(start, start + pageSize);
  return {
    results,
    page,
    pageSize,
    hasMore: start + results.length < matched.length,
    total: matched.length,
  };
}
