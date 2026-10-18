/**
 * Personal recipe library — validated recipes structured by the MCP client's
 * model from captured pages, kept in local storage (chrome.storage.local in
 * the extension; a memory double in tests).
 *
 * Design decisions (spec + ADR 0008):
 *   - The record is validated with the common contract before storage: an
 *     invalid recipe is rejected whole, nothing partial is kept.
 *   - The identifier is derived deterministically from the source URL, so a
 *     replayed save (same capture, same page) is idempotent: the existing
 *     recipe is returned untouched and never re-announced.
 *   - The digest is local, persistent state: a recipe is "new" until one
 *     successful call has carried its announcement (`claimNew` marks it).
 *
 * The validator is injected (same convention as the catalogue) so this module
 * stays importable under Node's type-stripping test runner.
 */

import type { ParseRecipeResult, Recipe } from "./contract.js";
import type { CaptureStorageAdapter } from "./capture-store.js";

export const RECIPES_STORAGE_KEY = "mcp-leclerc-drive:recipes";
export const DIGEST_STORAGE_KEY = "mcp-leclerc-drive:recipe-digest";

export interface SaveRecipeOk {
  ok: true;
  recipe: Recipe;
  /** True when the recipe already existed (idempotent replay). */
  alreadySaved: boolean;
}

export interface SaveRecipeErr {
  ok: false;
  error: string;
}

export type SaveRecipeResult = SaveRecipeOk | SaveRecipeErr;

export interface LibraryStore {
  /** Validate + persist one raw recipe payload; idempotent per source URL. */
  save(raw: unknown): Promise<SaveRecipeResult>;
  /** One personal recipe by identifier, or undefined. */
  get(id: string): Promise<Recipe | undefined>;
  /** All personal recipes, oldest save first. */
  list(): Promise<Recipe[]>;
  /**
   * Digest: return the recipes never announced yet and mark them announced.
   * Atomic per call — the caller is expected to serialize calls (the
   * extension background does; see src/recipes/service.ts).
   */
  claimNew(): Promise<Recipe[]>;
}

/**
 * 32-bit FNV-1a — local mirror of the same helper in capture.ts (inlined so
 * this module stays self-contained under Node's type-stripping runner).
 * Keep in sync with src/recipes/capture.ts.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Personal recipes are identified by their source page, unambiguously. */
export function derivePersonalRecipeId(sourceUrl: string): string {
  return `pers-${fnv1a32(sourceUrl)}`;
}

interface DigestState {
  /** Identifiers already announced by a successful tool response. */
  announced: string[];
}

function assertRecipeMap(value: unknown): Record<string, Recipe> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Le stockage local des recettes personnelles est corrompu (format inattendu).");
  }
  const map = value as Record<string, unknown>;
  for (const [id, v] of Object.entries(map)) {
    if (typeof v !== "object" || v === null) {
      throw new Error(`Le stockage local des recettes personnelles est corrompu (recette ${id} invalide).`);
    }
    const r = v as Partial<Recipe>;
    if (
      typeof r.id !== "string" ||
      typeof r.title !== "string" ||
      typeof r.servings !== "number" ||
      !Array.isArray(r.ingredients) ||
      !Array.isArray(r.steps)
    ) {
      throw new Error(`Le stockage local des recettes personnelles est corrompu (recette ${id} invalide).`);
    }
  }
  return map as Record<string, Recipe>;
}

function assertDigestState(value: unknown): DigestState {
  if (value === undefined) return { announced: [] };
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { announced?: unknown }).announced) ||
    (value as { announced: unknown[] }).announced.some((x) => typeof x !== "string")
  ) {
    throw new Error("L'état local du digest de recettes est corrompu.");
  }
  return value as DigestState;
}

/** Oldest-save-first comparator (personal provenance always has savedAt). */
function bySavedAt(a: Recipe, b: Recipe): number {
  const da = a.provenance.origin === "personnelle" ? a.provenance.savedAt : "";
  const db = b.provenance.origin === "personnelle" ? b.provenance.savedAt : "";
  return da < db ? -1 : da > db ? 1 : 0;
}

/** Build a personal library store over a storage adapter. */
export function createLibraryStore(
  adapter: CaptureStorageAdapter,
  parse: (input: unknown) => ParseRecipeResult,
): LibraryStore {
  async function readMap(): Promise<Record<string, Recipe>> {
    return assertRecipeMap(await adapter.get(RECIPES_STORAGE_KEY));
  }

  async function readDigest(): Promise<DigestState> {
    return assertDigestState(await adapter.get(DIGEST_STORAGE_KEY));
  }

  return {
    async save(raw) {
      // The contract requires an id, but a personal recipe's identifier is
      // ALWAYS derived from its source URL — the model never provides it.
      // A placeholder lets the payload pass validation; it is replaced below.
      const payload =
        typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
          ? raw
          : { ...(raw as object | null | undefined), id: "pers-a-deriver" };
      const v = parse(payload);
      if (!v.ok) return { ok: false, error: v.error };
      const recipe = v.recipe;
      if (recipe.provenance.origin !== "personnelle") {
        return {
          ok: false,
          error: "Une recette personnelle doit porter une provenance « personnelle » avec son URL source.",
        };
      }
      const derivedId = derivePersonalRecipeId(recipe.provenance.url);
      const stored: Recipe = { ...recipe, id: derivedId };
      const map = await readMap();
      const existing = map[derivedId];
      if (existing) {
        // Idempotent replay: keep the first structured recipe untouched.
        return { ok: true, recipe: existing, alreadySaved: true };
      }
      map[derivedId] = stored;
      await adapter.set(RECIPES_STORAGE_KEY, map);
      return { ok: true, recipe: stored, alreadySaved: false };
    },

    async get(id) {
      const map = await readMap();
      return map[id];
    },

    async list() {
      const map = await readMap();
      return Object.values(map).sort(bySavedAt);
    },

    async claimNew() {
      const map = await readMap();
      const digest = await readDigest();
      const announced = new Set(digest.announced);
      const fresh = Object.values(map)
        .filter((r) => !announced.has(r.id))
        .sort(bySavedAt);
      if (fresh.length > 0) {
        await adapter.set(DIGEST_STORAGE_KEY, {
          announced: [...announced, ...fresh.map((r) => r.id)],
        });
      }
      return fresh;
    },
  };
}
