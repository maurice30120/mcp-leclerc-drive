/**
 * Pure domain types for the Leclerc Drive capabilities.
 *
 * This package is the single source of truth for the shapes exchanged by the
 * agent, the WebMCP projection and the Node harness. It must stay free of any
 * browser, Node, MCP or model-library dependency (see ADR-0011).
 */

/** Sales product as returned by the catalogue tools. */
export interface Product {
  /** Stable product identifier, the only one accepted by cart mutations. */
  id: string;
  /** Display label, e.g. "Filets de poulet 600 g". Untrusted content. */
  label: string;
  /** Brand, e.g. "Marque Repère". Optional. */
  brand?: string;
  /** Unit price in euros. */
  price: number;
  /** Price per kilo / litre as displayed, e.g. "11,99 €/kg". Optional. */
  pricePerUnit?: string;
  /** Nutri-Score letter A–E, when available. */
  nutriScore?: string;
  /** Whether the item is currently orderable in the selected store. */
  available: boolean;
  /** Thumbnail image URL, when available. */
  imageUrl?: string;
  /**
   * Sales packaging as displayed by the catalogue, e.g. "600 g", "1 L",
   * "6 pièces". Purchase quantities are computed ONLY from this field,
   * never invented by the model.
   */
  packaging?: string;
}

/** One line of a cart. */
export interface CartItem {
  product: Product;
  quantity: number;
  /** quantity * unit price, in euros. */
  lineTotal: number;
}

/** Cart state as re-readable via the get_cart capability. */
export interface Cart {
  items: CartItem[];
  /** Number of distinct lines in the cart. */
  itemCount: number;
  /** Sum of all line totals, in euros. */
  total: number;
  storeId: string;
}

/** A Leclerc Drive store as returned by the store finder. */
export interface DriveStore {
  /** Store identifier used to select the drive (e.g. "053701"). */
  id: string;
  /** Display name, e.g. "Leclerc Drive La Ville-aux-Dames". */
  name: string;
  /** City, when known. */
  city?: string;
  /** Postal code, when known. */
  postalCode?: string;
  /** Drive URL, when known. */
  url?: string;
}
