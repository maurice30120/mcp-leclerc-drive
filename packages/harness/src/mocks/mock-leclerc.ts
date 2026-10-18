/**
 * Deterministic in-memory mock of the Leclerc environment (issue #42).
 *
 * createMockLeclerc() builds a fresh environment (catalogue, drives, cart,
 * fault plan, per-call counters) from the versioned fixtures. Every capability
 * is executed through its registry contract from @leclerc/contracts —
 * validateInput first, then the mock handler — and resolves to either a
 * structured output or a normalized ToolError. Raw exceptions never cross the
 * boundary. bindCapabilities(env) exposes the same execution as a single
 * executor function, the seam the agent engine plugs into.
 */

import {
  getCapability,
  toolError,
  toToolError,
  type Cart,
  type CartItem,
  type DriveStore,
  type Product,
  type ToolResult,
} from "@leclerc/contracts";
import {
  FIXTURE_HABITUAL_PRODUCT_IDS,
  FIXTURE_PRODUCTS,
  FIXTURE_STORES,
} from "./fixtures.js";
import {
  evaluateFault,
  validateFaultPlan,
  type FaultPlan,
  type FaultRule,
} from "./faults.js";

/** Observable mock state for scenario assertions. */
export interface MockLeclercState {
  /** Currently selected drive, or undefined before set_store. */
  readonly selectedStore: DriveStore | undefined;
  /** Current cart snapshot (quantities and totals recomputed on access). */
  readonly cart: Cart;
}

/**
 * The in-memory Leclerc environment: fresh per createMockLeclerc() call.
 * `call` executes capabilities through their registry contract.
 */
export interface MockLeclerc {
  readonly state: MockLeclercState;
  /** Replace the fault plan between calls (scenario injection points). */
  setFaultPlan(plan: FaultPlan): void;
  /** Restore pristine fixture state, clear faults and call counters. */
  reset(): void;
  /** Execute a capability by registry name (structured result, never throws). */
  call(name: string, input?: unknown): ToolResult<unknown>;
}

/** Executor seam bound to one mock environment (consumed by the agent engine). */
export type CapabilityExecutor = (name: string, input?: unknown) => ToolResult<unknown>;

interface CartLine {
  product: Product;
  quantity: number;
}

interface EnvInternals {
  products: Map<string, Product>;
  habitualIds: readonly string[];
  cart: Map<string, CartLine>;
  store: DriveStore | undefined;
  faults: FaultPlan;
  callCounts: Map<string, number>;
  faultMatches: Map<FaultRule, number>;
}

function makeInternals(faults: FaultPlan, products: readonly Product[] = FIXTURE_PRODUCTS, habitualIds: readonly string[] = FIXTURE_HABITUAL_PRODUCT_IDS): EnvInternals {
  return {
    habitualIds: [...habitualIds],
    products: new Map(products.map((p) => [p.id, { ...p }])),
    cart: new Map(),
    store: undefined,
    faults,
    callCounts: new Map(),
    faultMatches: new Map(),
  };
}

/** Per-environment internals, reachable from bindCapabilities and reset. */
const internalsOf = new WeakMap<MockLeclerc, EnvInternals>();

// ---- text helpers (deterministic, accent-insensitive matching) -----------

function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** AND semantics: every query token must appear in the haystack tokens. */
function matchesTokens(queryTokens: string[], haystackTokens: ReadonlySet<string>): boolean {
  return queryTokens.length > 0 && queryTokens.every((t) => haystackTokens.has(t));
}

function requireStore(state: EnvInternals): DriveStore {
  if (!state.store) {
    throw toolError(
      "SESSION_EXPIRED",
      "Aucun drive sélectionné : appelez find_stores puis set_store.",
    );
  }
  return state.store;
}

function buildCart(state: EnvInternals): Cart {
  const items: CartItem[] = [...state.cart.values()].map((line) => ({
    product: { ...line.product },
    quantity: line.quantity,
    lineTotal: round2(line.quantity * line.product.price),
  }));
  const total = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  return {
    items,
    itemCount: items.length,
    total,
    storeId: state.store?.id ?? "",
  };
}

// ---- capability handlers ---------------------------------------------------
// Input shapes are guaranteed by the registry's validateInput; the casts below
// are therefore safe and stay local to the dispatcher.

type Handler = (state: EnvInternals, input: Record<string, unknown>) => unknown;

const findStores: Handler = (state, input) => {
  const { query } = input as unknown as { query: string };
  const queryTokens = tokenize(query);
  const stores = FIXTURE_STORES.filter((store) => {
    const haystack = new Set(
      tokenize([store.name, store.city, store.postalCode, store.id].filter(Boolean).join(" ")),
    );
    return matchesTokens(queryTokens, haystack);
  });
  if (stores.length === 0) {
    throw toolError("EMPTY_RESULT", `Aucun drive trouvé pour '${query}'.`, { query });
  }
  return { stores: stores.map((s) => ({ ...s })) };
};

const setStore: Handler = (state, input) => {
  const { storeId } = input as unknown as { storeId: string };
  const store = FIXTURE_STORES.find((s) => s.id === storeId);
  if (!store) {
    throw toolError("INVALID_ID", `Drive inconnu : '${storeId}'.`, { storeId });
  }
  state.store = { ...store };
  return { store: { ...store } };
};

const getStore: Handler = (state) => {
  const store = requireStore(state);
  return { store: { ...store } };
};

const searchProduct: Handler = (state, input) => {
  requireStore(state);
  const { query } = input as unknown as { query: string };
  const queryTokens = tokenize(query);
  const products: Product[] = [];
  for (const product of state.products.values()) {
    const haystack = new Set(tokenize(`${product.label} ${product.brand ?? ""}`));
    if (matchesTokens(queryTokens, haystack)) {
      products.push({ ...product });
    }
  }
  if (products.length === 0) {
    throw toolError("EMPTY_RESULT", `Aucun produit trouvé pour '${query}'.`, { query });
  }
  return { products };
};

const listHabitualProducts: Handler = (state) => {
  requireStore(state);
  const products: Product[] = [];
  for (const id of state.habitualIds) {
    const product = state.products.get(id);
    if (product) products.push({ ...product });
  }
  return { products };
};

const getCart: Handler = (state) => {
  requireStore(state);
  return { cart: buildCart(state) };
};

function requireProduct(state: EnvInternals, productId: string): Product {
  const product = state.products.get(productId);
  if (!product) {
    throw toolError("PRODUCT_NOT_FOUND", `Produit introuvable dans le catalogue : '${productId}'.`, {
      productId,
    });
  }
  return product;
}

const addToCart: Handler = (state, input) => {
  requireStore(state);
  const { productId, quantity } = input as unknown as { productId: string; quantity: number };
  const product = requireProduct(state, productId);
  if (!product.available) {
    throw toolError(
      "PRODUCT_UNAVAILABLE",
      `Produit indisponible dans ce drive : '${product.label}'.`,
      { productId },
    );
  }
  const existing = state.cart.get(productId);
  state.cart.set(productId, { product, quantity: (existing?.quantity ?? 0) + quantity });
  return { cart: buildCart(state) };
};

const updateQuantity: Handler = (state, input) => {
  requireStore(state);
  const { productId, quantity } = input as unknown as { productId: string; quantity: number };
  const product = requireProduct(state, productId);
  if (quantity > 0 && !product.available) throw toolError("PRODUCT_UNAVAILABLE", "Produit indisponible.");
  if (quantity === 0) state.cart.delete(productId);
  else state.cart.set(productId, { product, quantity });
  return { cart: buildCart(state) };
};

const removeFromCart: Handler = (state, input) => {
  requireStore(state);
  const { productId } = input as unknown as { productId: string };
  requireProduct(state, productId);
  if (!state.cart.has(productId)) {
    throw toolError("CART_MUTATION_REFUSED", `Produit '${productId}' absent du panier.`, {
      productId,
    });
  }
  state.cart.delete(productId);
  return { cart: buildCart(state) };
};

const HANDLERS: Record<string, Handler> = {
  find_stores: findStores,
  set_store: setStore,
  get_store: getStore,
  search_product: searchProduct,
  list_habitual_products: listHabitualProducts,
  get_cart: getCart,
  add_to_cart: addToCart,
  update_quantity: updateQuantity,
  remove_from_cart: removeFromCart,
};

// ---- environment -----------------------------------------------------------

function execute(env: MockLeclerc, name: string, value: Record<string, unknown>): ToolResult<unknown> {
  const internal = internalsOf.get(env);
  if (!internal) {
    return toolError("UNKNOWN_CAPABILITY", "Environnement mock non initialisé.");
  }
  const callIndex = (internal.callCounts.get(name) ?? 0) + 1;
  internal.callCounts.set(name, callIndex);
  const productId = typeof value.productId === "string" ? value.productId : undefined;
  const fault = evaluateFault(
    internal.faults,
    { capability: name, productId, callIndex },
    internal.faultMatches,
  );
  if (fault) return fault;
  try {
    const handler = HANDLERS[name];
    return { ok: true, output: handler(internal, value) };
  } catch (e) {
    return toToolError(e, name);
  }
}

/**
 * Bind the nine capabilities of one mock environment to their registry
 * contracts. Unknown names resolve to UNKNOWN_CAPABILITY, invalid inputs to
 * the registry's INVALID_INPUT, matching fault-plan rules to the injected
 * family, and any residual unexpected exception to CAPABILITY_FAILED.
 */
export function bindCapabilities(env: MockLeclerc): CapabilityExecutor {
  return (name: string, input: unknown = {}) => {
    const contract = getCapability(name);
    if (!contract) {
      return toolError("UNKNOWN_CAPABILITY", `Capacité inconnue : '${name}'.`, { capability: name });
    }
    const validated = contract.validateInput(input);
    if (!validated.ok) return validated;
    return execute(env, name, validated.value as unknown as Record<string, unknown>);
  };
}

/**
 * Create a fresh deterministic mock environment. State is isolated per call:
 * scenario runs never share cart, store, fault counters or fixture data.
 */
export function createMockLeclerc(options?: { faults?: FaultPlan; products?: readonly Product[]; habitualIds?: readonly string[] }): MockLeclerc {
  const faults = options?.faults ?? [];
  validateFaultPlan(faults);
  const env: MockLeclerc = {
    state: {
      get selectedStore() {
        return internalsOf.get(env)?.store ? { ...internalsOf.get(env)!.store! } : undefined;
      },
      get cart() {
        const internal = internalsOf.get(env);
        return internal ? buildCart(internal) : { items: [], itemCount: 0, total: 0, storeId: "" };
      },
    },
    setFaultPlan(plan) {
      validateFaultPlan(plan);
      const internal = internalsOf.get(env);
      if (internal) internal.faults = plan;
    },
    reset() {
      internalsOf.set(env, makeInternals([], options?.products, options?.habitualIds));
    },
    call(name: string, input: unknown = {}) {
      return bound(name, input);
    },
  };
  internalsOf.set(env, makeInternals(faults, options?.products, options?.habitualIds));
  const bound = bindCapabilities(env);
  return env;
}
