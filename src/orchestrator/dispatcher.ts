/**
 * Dispatcher command validation — the pure seam between the orchestrator's
 * typed command vocabulary and the Leclerc business logic.
 *
 * The MAIN-world bridge (`extension/inject.ts`) exposes a single
 * `dispatch(call)` entry point. Every command the orchestrator can issue
 * (popup, offscreen model) must pass `validateCommand` first, which:
 *   - rejects unknown commands,
 *   - rejects mutation commands whose host isn't a Leclerc Drive backend,
 *   - coerces + bounds the args into a typed {@link DispatchCall}.
 *
 * Read vs mutation is a first-class classification here so the popup can
 * enforce "no mutation without explicit user validation": it never sends a
 * mutation command until the user clicks *Valider*, and the bridge re-checks
 * the host before touching the cart.
 *
 * Pure, fetch-free, storage-free — unit-tested in
 * `tests/orchestrator-dispatcher.test.ts`.
 */

import type {
  LeclercCommandName,
  MutationCommand,
  ReadCommand,
} from "./messages.js";

/**
 * Local mirror of the command vocabulary (src/orchestrator/messages.ts).
 * Inlined here — rather than imported as values — so this pure module stays
 * self-contained under Node's type-stripping test runner (which cannot resolve
 * a `.js` specifier to `.ts`, and Node16 forbids `.ts` specifiers).
 * Keep in sync with messages.ts.
 */
const READ_COMMANDS = new Set<string>(["search_products", "get_cart", "get_store"]);
const MUTATION_COMMANDS = new Set<string>([
  "add_to_cart",
  "update_quantity",
  "remove_from_cart",
]);

function isReadCommand(name: string): name is ReadCommand {
  return READ_COMMANDS.has(name);
}

function isMutationCommand(name: string): name is MutationCommand {
  return MUTATION_COMMANDS.has(name);
}

/**
 * Local mirror of `isLeclercHost` (src/leclerc/api.ts). Inlined here for the
 * same reason as the command sets above. Keep in sync with api.ts.
 */
function isLeclercHost(host: string): boolean {
  return /^fd\d+-courses\.leclercdrive\.fr$/i.test(host);
}

/** A validated, ready-to-run read command. */
export type ReadCall =
  | { command: "search_products"; query: string }
  | { command: "get_cart" }
  | { command: "get_store" };

/** A validated, ready-to-run mutation command. */
export type MutationCall =
  | { command: "add_to_cart"; productId: string; quantity: number }
  | { command: "update_quantity"; productId: string; quantity: number }
  | { command: "remove_from_cart"; productId: string };

export type DispatchCall = ReadCall | MutationCall;

/** A single validated entry in the public WebMCP add_many batch. */
export type AddManyCall = Extract<MutationCall, { command: "add_to_cart" }>;

/** Keep a batch small enough for the browser's existing request throttle. */
export const MAX_ADD_MANY_ITEMS = 20;

export type ValidateAddManyResult =
  | { ok: true; items: AddManyCall[] }
  | { ok: false; error: string };

/**
 * Validate the entire batch before any cart mutation takes place.
 * Uses exactly the same product/quantity/host rules as add_to_cart.
 */
export function validateAddMany(items: unknown, host?: string): ValidateAddManyResult {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "add_many: 'items' doit contenir au moins un produit." };
  }
  if (items.length > MAX_ADD_MANY_ITEMS) {
    return { ok: false, error: `add_many: maximum ${MAX_ADD_MANY_ITEMS} produits par appel.` };
  }

  const validated: AddManyCall[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `add_many: items[${i}] doit être un objet.` };
    }
    const item = raw as Record<string, unknown>;
    const result = validateCommand(
      "add_to_cart",
      { product_id: item.product_id, quantity: item.quantity === undefined ? 1 : item.quantity },
      host,
    );
    if (!result.ok) return { ok: false, error: `add_many: items[${i}]: ${result.error}` };
    if (result.call.command !== "add_to_cart") {
      return { ok: false, error: "add_many: commande inattendue." };
    }
    if (seen.has(result.call.productId)) {
      return { ok: false, error: `add_many: product_id répété : ${result.call.productId}.` };
    }
    seen.add(result.call.productId);
    validated.push(result.call);
  }

  return { ok: true, items: validated };
}

export interface AddManyExecutionResult<T> {
  added: AddManyCall[];
  failed: { productId: string; quantity: number; error: string }[];
  /** Value returned by the last successful add; not necessarily the final cart on failure. */
  lastResult?: T;
}

/**
 * Execute additions sequentially, preserving the existing add_to_cart path
 * (and its anti-DataDome throttle). A failed item does not abort later items.
 * Completed changes are never rolled back automatically.
 */
export async function executeAddMany<T>(
  items: readonly AddManyCall[],
  addOne: (item: AddManyCall) => Promise<T>,
): Promise<AddManyExecutionResult<T>> {
  const added: AddManyCall[] = [];
  const failed: AddManyExecutionResult<T>["failed"] = [];
  let lastResult: T | undefined;

  for (const item of items) {
    try {
      lastResult = await addOne(item);
      added.push(item);
    } catch (error) {
      failed.push({
        productId: item.productId,
        quantity: item.quantity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { added, failed, lastResult };
}

export interface ValidateOk {
  ok: true;
  call: DispatchCall;
}

export interface ValidateErr {
  ok: false;
  error: string;
}

export type ValidateResult = ValidateOk | ValidateErr;

/** True for the three cart-mutating commands. */
export function isMutationCall(call: DispatchCall): boolean {
  return (
    call.command === "add_to_cart" ||
    call.command === "update_quantity" ||
    call.command === "remove_from_cart"
  );
}

/** True for the three read-only commands. */
export function isReadCall(call: DispatchCall): boolean {
  return !isMutationCall(call);
}

/**
 * Validate + coerce a raw `{ command, args, host? }` into a typed
 * {@link DispatchCall}. `host` is checked for Leclerc membership on mutations
 * (defence in depth: the bridge already refuses to run off a Leclerc tab, but
 * a persisted host string is untrusted).
 */
export function validateCommand(
  command: string,
  args: Record<string, unknown> | null | undefined,
  host?: string,
): ValidateResult {
  if (!isReadCommand(command) && !isMutationCommand(command)) {
    return { ok: false, error: `Commande inconnue : ${command}` };
  }
  const a = args ?? {};

  if (command === "search_products") {
    const query = strField(a, "query");
    if (query === null) return { ok: false, error: "search_products: 'query' requis (chaîne)." };
    const trimmed = query.trim();
    if (!trimmed) return { ok: false, error: "search_products: 'query' vide." };
    return { ok: true, call: { command: "search_products", query: trimmed } };
  }

  if (command === "get_cart") return { ok: true, call: { command: "get_cart" } };
  if (command === "get_store") return { ok: true, call: { command: "get_store" } };

  // Mutations: require productId + host check.
  if (isMutationCommand(command)) {
    if (host !== undefined && !isLeclercHost(host)) {
      return { ok: false, error: `Host refusé (non-Leclerc) : ${host}` };
    }
    const productId = strictStr(a, "product_id");
    if (productId === null) {
      return { ok: false, error: `${command}: 'product_id' requis (chaîne).` };
    }
    if (command === "remove_from_cart") {
      return { ok: true, call: { command: "remove_from_cart", productId } };
    }
    const qty = intField(a, "quantity");
    if (qty === null) {
      return { ok: false, error: `${command}: 'quantity' requis (entier).` };
    }
    if (command === "add_to_cart") {
      if (qty < 1) return { ok: false, error: "add_to_cart: 'quantity' doit être ≥ 1." };
      return { ok: true, call: { command: "add_to_cart", productId, quantity: qty } };
    }
    // update_quantity
    if (qty < 0) return { ok: false, error: "update_quantity: 'quantity' doit être ≥ 0." };
    return { ok: true, call: { command: "update_quantity", productId, quantity: qty } };
  }

  // Unreachable: covered by the unknown-command check above.
  return { ok: false, error: `Commande non gérée : ${command}` };
}

/** Strongly-typed name of a validated call (helper for switch exhaustiveness). */
export function callName(call: DispatchCall): LeclercCommandName {
  return call.command as LeclercCommandName;
}

export type { LeclercCommandName, MutationCommand, ReadCommand };

// ---- field coercions -------------------------------------------------------

function strField(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Strict string field — no numeric coercion (used for product_id). */
function strictStr(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  if (typeof v === "string") return v.trim() ? v : null;
  return null;
}

function intField(a: Record<string, unknown>, key: string): number | null {
  const v = a[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    if (Number.isInteger(n)) return n;
  }
  return null;
}
