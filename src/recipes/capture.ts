/**
 * Capture record — a recipe page saved by an explicit user action, waiting to
 * be structured into a recipe by the MCP client's model.
 *
 * A capture is NOT a recipe: it holds a source URL, a capture date and a
 * bounded excerpt of the page's useful visible content. Its state stays
 * distinct from any validated recipe; nothing here invents ingredients,
 * portions or quantities.
 *
 * Pure validation/bounding only — no Chrome APIs, so it is unit-tested in
 * Node and reused by the background service worker.
 */

/** Upper bound for the stored excerpt. */
export const MAX_EXCERPT_CHARS = 20000;

/** A capture is always pending until an explicit follow-up ends it. */
export const CAPTURE_STATE_PENDING = "pending" as const;

export interface Capture {
  /** Stable identifier, deterministically derived from the source URL. */
  id: string;
  /** Normalized source URL (http/https). */
  url: string;
  /** ISO date-time of the capture. */
  capturedAt: string;
  /** Page title, when available. */
  title?: string;
  /** Bounded excerpt of the page's visible content (plain text only). */
  excerpt: string;
  state: typeof CAPTURE_STATE_PENDING;
}

export interface BuildCaptureOk {
  ok: true;
  capture: Capture;
}

export interface BuildCaptureErr {
  ok: false;
  error: string;
}

export type BuildCaptureResult = BuildCaptureOk | BuildCaptureErr;

export interface BuildCaptureInput {
  url: unknown;
  capturedAt: unknown;
  title?: unknown;
  excerpt: unknown;
}

/**
 * 32-bit FNV-1a over a string — deterministic, dependency-free, enough for a
 * stable per-URL capture identifier (this is not a security hash).
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic capture identifier for a normalized URL. */
export function deriveCaptureId(normalizedUrl: string): string {
  return `cap-${fnv1a32(normalizedUrl)}`;
}

/** Normalize a source URL: must be absolute http(s); returns null otherwise. */
export function normalizeCaptureUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    // `href` re-serializes the URL without fragments or transient junk.
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/** Bound an excerpt: trim, collapse blank lines, cap at MAX_EXCERPT_CHARS. */
export function boundExcerpt(excerpt: string): string {
  const collapsed = excerpt.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length > MAX_EXCERPT_CHARS
    ? collapsed.slice(0, MAX_EXCERPT_CHARS)
    : collapsed;
}

/**
 * Build a pending capture record from untrusted page data. The excerpt is
 * bounded; a missing URL, an unusable URL or an empty excerpt is an error —
 * a capture with no exploitable content is never stored.
 */
export function buildCaptureRecord(input: BuildCaptureInput): BuildCaptureResult {
  if (typeof input.url !== "string") {
    return { ok: false, error: "L'URL de la page capturée est manquante." };
  }
  const url = normalizeCaptureUrl(input.url);
  if (!url) {
    return { ok: false, error: `URL source invalide (http/https requis) : ${String(input.url)}` };
  }

  let capturedAtMs: number;
  if (typeof input.capturedAt === "number" && Number.isFinite(input.capturedAt)) {
    capturedAtMs = input.capturedAt;
  } else if (typeof input.capturedAt === "string" && !Number.isNaN(Date.parse(input.capturedAt))) {
    capturedAtMs = Date.parse(input.capturedAt);
  } else {
    return { ok: false, error: "Date de capture invalide." };
  }

  if (typeof input.excerpt !== "string") {
    return { ok: false, error: "Aucun contenu exploitable n'a été lu sur la page." };
  }
  const excerpt = boundExcerpt(input.excerpt);
  if (excerpt.length === 0) {
    return { ok: false, error: "Aucun contenu visible exploitable sur cette page." };
  }

  let title: string | undefined;
  if (input.title !== undefined && input.title !== null && String(input.title).trim() !== "") {
    title = String(input.title).trim();
  }

  return {
    ok: true,
    capture: {
      id: deriveCaptureId(url),
      url,
      capturedAt: new Date(capturedAtMs).toISOString(),
      ...(title === undefined ? {} : { title }),
      excerpt,
      state: CAPTURE_STATE_PENDING,
    },
  };
}

/** Type guard: is this stored value a well-formed pending capture? */
export function isCapture(value: unknown): value is Capture {
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
