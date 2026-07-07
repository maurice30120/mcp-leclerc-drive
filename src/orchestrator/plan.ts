/**
 * Model output parsing + validation — the pure seam between the local
 * Transformers.js model and the orchestrator's cart workflow.
 *
 * The offscreen document runs the model and feeds its raw text output here.
 * The model is *never* allowed to emit a `product_id`: those come only from
 * real Leclerc `search_products` responses (untrusted catalogue data). The
 * parser therefore:
 *   - extracts the first JSON object/array from the model text,
 *   - validates the `{ items[], questions? }` shape,
 *   - drops any `product_id` / `id` fields the model hallucinates,
 *   - bounds quantities to 1..99 and trims free-text fields.
 *
 * Pure, fetch-free, model-free — unit-tested in
 * `tests/orchestrator-plan.test.ts` with mocked model strings.
 */

export interface PlanItem {
  /** Catalogue search query, e.g. "lait demi-écrémé bio". Never a product id. */
  query: string;
  /** Requested quantity, bounded to 1..99. */
  quantity: number;
  /** Optional free-text constraint, e.g. "1L", "sans gluten". */
  constraints?: string;
  /** Optional free-text note for the user, never interpreted as an instruction. */
  notes?: string;
}

export interface Plan {
  items: PlanItem[];
  /** Clarifying questions the model wants the user to answer (v1: surfaced only). */
  questions?: string[];
}

export interface ParseOk {
  ok: true;
  plan: Plan;
}

export interface ParseErr {
  ok: false;
  error: string;
}

export type ParseResult = ParseOk | ParseErr;

export const MAX_QUANTITY = 99;
export const MIN_QUANTITY = 1;

/**
 * Parse a raw model text blob into a validated {@link Plan}.
 *
 * Tolerant of markdown fences (```json … ```) and trailing prose: we scan for
 * the first balanced `{ … }` and JSON-parse that. A missing/empty plan is an
 * error (the orchestrator must not silently no-op).
 */
export function parsePlan(raw: string): ParseResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: "Modèle : sortie vide." };
  }

  const unwrapped = unwrapJsonStringOutput(raw);
  const jsonText = extractFirstJsonObject(unwrapped ?? raw);
  if (jsonText === null) {
    return {
      ok: false,
      error: "Modèle : aucun objet JSON trouvé dans la sortie.",
    };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      error: "Modèle : JSON invalide — " + (e as Error).message,
    };
  }

  return validatePlan(obj);
}

/**
 * Some models return a JSON object double-encoded as a JSON string:
 * `"{\"items\":[...]}"`. Decode that wrapper before scanning for the object.
 */
function unwrapJsonStringOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Validate an already-parsed JS value as a {@link Plan}. Exported for tests. */
export function validatePlan(obj: unknown): ParseResult {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, error: "Modèle : la racine doit être un objet." };
  }
  const root = obj as Record<string, unknown>;

  const itemsRaw = root.items;
  if (!Array.isArray(itemsRaw)) {
    return { ok: false, error: "Modèle : 'items' doit être un tableau." };
  }
  if (itemsRaw.length === 0) {
    // An empty items array is only valid if the model asked clarifying questions.
    const questions = parseQuestions(root.questions);
    if (questions.length > 0) {
      return { ok: true, plan: { items: [], questions } };
    }
    return { ok: false, error: "Modèle : 'items' vide sans question de clarification." };
  }

  const items: PlanItem[] = [];
  for (let i = 0; i < itemsRaw.length; i++) {
    const r = parseItem(itemsRaw[i], i);
    if (!r.ok) return r;
    items.push(r.item);
  }

  const questions = parseQuestions(root.questions);

  // SECURITY: scrub any leaked product id fields defensively — the model must
  // not produce them, but if it does we drop them rather than trust them.
  for (const it of items) {
    delete (it as unknown as Record<string, unknown>).product_id;
    delete (it as unknown as Record<string, unknown>).id;
  }

  return { ok: true, plan: { items, questions: questions.length ? questions : undefined } };
}

// ---- internals -------------------------------------------------------------

interface ItemOk {
  ok: true;
  item: PlanItem;
}
interface ItemErr {
  ok: false;
  error: string;
}

function parseItem(raw: unknown, index: number): ItemOk | ItemErr {
  const where = `items[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `Modèle : ${where} doit être un objet.` };
  }
  const o = raw as Record<string, unknown>;

  const query = strTrim(o.query);
  if (!query) return { ok: false, error: `Modèle : ${where}.query requis (chaîne non vide).` };
  if (isPlaceholder(query)) {
    return { ok: false, error: `Modèle : ${where}.query contient une valeur placeholder.` };
  }

  const quantity = clampQuantity(o.quantity);
  if (quantity === null) {
    return { ok: false, error: `Modèle : ${where}.quantity doit être un entier ≥ 1.` };
  }

  const constraintsRaw = strTrim(o.constraints);
  const notesRaw = strTrim(o.notes);
  const constraints = constraintsRaw && !isPlaceholder(constraintsRaw) ? constraintsRaw : undefined;
  const notes = notesRaw && !isPlaceholder(notesRaw) ? notesRaw : undefined;

  return { ok: true, item: { query, quantity, constraints, notes } };
}

function parseQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const q of raw) {
    if (typeof q === "string") {
      const t = q.trim();
      if (t && !isPlaceholder(t)) out.push(t.slice(0, 280));
    }
  }
  return out;
}

function strTrim(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 200);
}

function isPlaceholder(v: string): boolean {
  const normalized = v
    .trim()
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
  return (
    normalized === "terme de recherche catalogue" ||
    normalized === "optionnel" ||
    normalized === "produit" ||
    normalized === "query" ||
    normalized === "notes" ||
    normalized === "constraints"
  );
}

function clampQuantity(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) n = Number(v.trim());
  if (n === null) return null;
  if (n < MIN_QUANTITY) return null;
  if (n > MAX_QUANTITY) n = MAX_QUANTITY;
  return n;
}

/**
 * Extract the first balanced top-level `{ … }` from `raw`, tolerating strings
 * that contain braces. Returns the matched substring or null.
 */
export function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
