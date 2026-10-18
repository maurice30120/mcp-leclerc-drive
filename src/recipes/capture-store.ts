/**
 * Capture store — the bounded set of operations on captured recipe pages.
 *
 * Backed by a key-value storage adapter (chrome.storage.local in the
 * extension; an in-memory double in tests). Only capture operations live
 * here — list, read, save, finish — so later tickets can surface captures to
 * the MCP client without touching the popup controller.
 *
 * A storage failure always throws (and is reported by the caller as a
 * failure): it is never silently turned into a success. Corrupt stored data
 * fails loudly instead of being returned as a capture.
 */

import type { Capture } from "./capture.js";

// Local mirrors of capture.ts constants (inlined — rather than imported as
// values — so this module stays self-contained under Node's type-stripping
// test runner; same convention as the orchestrator dispatcher).
// Keep in sync with src/recipes/capture.ts.
const CAPTURE_STATE_PENDING = "pending";
const MAX_EXCERPT_CHARS = 20000;

/**
 * Local mirror of `isCapture` (src/recipes/capture.ts), built on the mirrored
 * constants above. Keep in sync with capture.ts.
 */
function isCapture(value: unknown): value is Capture {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Partial<Capture>;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.url === "string" &&
    /^https?:\/\//i.test(c.url) &&
    typeof c.capturedAt === "string" &&
    !Number.isNaN(Date.parse(c.capturedAt)) &&
    typeof c.excerpt === "string" &&
    c.excerpt.length > 0 &&
    c.excerpt.length <= MAX_EXCERPT_CHARS &&
    c.state === CAPTURE_STATE_PENDING
  );
}

/** Storage key holding the capture map (id → Capture). */
export const CAPTURES_STORAGE_KEY = "mcp-leclerc-drive:captures";

/** Minimal async key-value adapter. chrome.storage.local satisfies it. */
export interface CaptureStorageAdapter {
  /** Return the value stored at key, or undefined. */
  get(key: string): Promise<unknown>;
  /** Store a JSON-compatible value at key. */
  set(key: string, value: unknown): Promise<void>;
}

export interface CaptureStore {
  /** Persist one validated capture; returns the stored record. */
  save(capture: Capture): Promise<Capture>;
  /** All pending captures, oldest first. */
  list(): Promise<Capture[]>;
  /** One capture by identifier, or undefined. */
  get(id: string): Promise<Capture | undefined>;
  /**
   * End a capture (success after structuring, or explicit abandon).
   * Returns true when a capture was removed, false when the id is unknown.
   */
  finish(id: string): Promise<boolean>;
}

function assertCaptureMap(value: unknown): Record<string, Capture> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Le stockage local des captures est corrompu (format inattendu).");
  }
  const map = value as Record<string, unknown>;
  for (const [id, v] of Object.entries(map)) {
    if (!isCapture(v)) {
      throw new Error(`Le stockage local des captures est corrompu (capture ${id} invalide).`);
    }
  }
  return map as Record<string, Capture>;
}

/** Build a capture store over a storage adapter. */
export function createCaptureStore(adapter: CaptureStorageAdapter): CaptureStore {
  async function readMap(): Promise<Record<string, Capture>> {
    return assertCaptureMap(await adapter.get(CAPTURES_STORAGE_KEY));
  }

  return {
    async save(capture) {
      if (!isCapture(capture)) {
        throw new Error("Enregistrement refusé : capture invalide.");
      }
      const map = await readMap();
      map[capture.id] = capture;
      await adapter.set(CAPTURES_STORAGE_KEY, map);
      return capture;
    },

    async list() {
      const map = await readMap();
      return Object.values(map).sort((a, b) =>
        a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0,
      );
    },

    async get(id) {
      const map = await readMap();
      return map[id];
    },

    async finish(id) {
      const map = await readMap();
      if (map[id] === undefined) return false;
      delete map[id];
      await adapter.set(CAPTURES_STORAGE_KEY, map);
      return true;
    },
  };
}
