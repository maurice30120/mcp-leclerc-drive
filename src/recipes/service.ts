/**
 * Recipe service — the runtime the recipe MCP tools talk to (tickets 07–11).
 *
 * Composes the capture store and the personal library behind one interface,
 * so the extension background and the integration harness share exactly the
 * same behavior; only the storage adapter differs (chrome.storage.local vs
 * an in-memory double).
 *
 * Concurrency: digest-touching operations (save, claim) are serialized
 * through an internal queue, so two concurrent tool responses can never
 * announce the same recipe twice — the single background service worker
 * serializes the whole extension anyway, and the queue keeps the guarantee
 * even if a caller forgets.
 *
 * Restart resilience (ticket 31): the service holds no state of its own —
 * rebuilding it over the same storage restores captures, recipes and the
 * digest state as they were.
 */

import type { Recipe } from "./contract.js";
import type { Capture } from "./capture.js";
import type { CaptureStore } from "./capture-store.js";
import type { LibraryStore } from "./library.js";

/** Compact capture line for listings and notices (no excerpt). */
export interface CaptureSummary {
  id: string;
  url: string;
  capturedAt: string;
  title?: string;
}

export type ServiceSaveResult =
  | {
      ok: true;
      recipe: Recipe;
      /** True when the recipe already existed (idempotent replay). */
      alreadySaved: boolean;
      /** True when the linked capture existed and was finished by this save. */
      captureFinished: boolean;
    }
  | {
      ok: false;
      error: string;
      /** Always false on failure — a technical failure never finishes a capture. */
      captureFinished: boolean;
    };

/** The runtime surface consumed by the recipe MCP tools. */
export interface RecipeRuntime {
  /** Pending captures, oldest first (no excerpt). */
  listCaptures(): Promise<CaptureSummary[]>;
  /** One pending capture with its excerpt, or undefined. */
  getCapture(id: string): Promise<Capture | undefined>;
  /** Validate + persist a personal recipe; idempotent per source URL. */
  saveRecipe(raw: unknown, captureId?: string): Promise<ServiceSaveResult>;
  /** Drop an unusable capture; false when the id is unknown. */
  abandonCapture(id: string): Promise<boolean>;
  /** One personal recipe by id, or undefined. */
  getPersonalRecipe(id: string): Promise<Recipe | undefined>;
  /** All personal recipes (bounded collection, for unified search). */
  personalRecipes(): Promise<Recipe[]>;
  /** Digest: return unannounced recipes and mark them announced. */
  claimNewRecipes(): Promise<Recipe[]>;
}

export interface RecipeServiceDeps {
  captureStore: CaptureStore;
  libraryStore: LibraryStore;
}

/** Build the runtime over the two stores. */
export function createRecipeService(deps: RecipeServiceDeps): RecipeRuntime {
  const { captureStore, libraryStore } = deps;

  // Promise-chain mutex: serializes digest-relevant read-modify-write cycles.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async listCaptures() {
      const captures = await captureStore.list();
      return captures.map((c) => ({
        id: c.id,
        url: c.url,
        capturedAt: c.capturedAt,
        ...(c.title ? { title: c.title } : {}),
      }));
    },

    async getCapture(id) {
      return captureStore.get(id);
    },

    async saveRecipe(raw, captureId) {
      return serialize(async () => {
        const saved = await libraryStore.save(raw);
        if (!saved.ok) {
          return { ...saved, captureFinished: false };
        }
        let captureFinished = false;
        if (captureId !== undefined) {
          captureFinished = await captureStore.finish(captureId);
        }
        return { ...saved, captureFinished };
      });
    },

    async abandonCapture(id) {
      return captureStore.finish(id);
    },

    async getPersonalRecipe(id) {
      return libraryStore.get(id);
    },

    async personalRecipes() {
      return libraryStore.list();
    },

    async claimNewRecipes() {
      return serialize(() => libraryStore.claimNew());
    },
  };
}
