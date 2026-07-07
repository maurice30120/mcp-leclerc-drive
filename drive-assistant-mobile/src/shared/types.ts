/**
 * Modèle de domaine partagé du Drive Assistant Mobile.
 *
 * Porte indépendante des types de mcp-leclerc-drive/src/types.ts : les shapes
 * exposées au runtime MCP et au modèle IA. Les shapes brutes du backend
 * Leclerc (RawProduct, CartEvent) vivent dans features/leclerc/api.ts et sont
 * mappées ici par mapProduct / cartFrom*.
 */

export interface Product {
  /** Identifiant produit stable utilisé par add_to_cart / update_quantity. */
  id: string;
  /** Libellé, ex. "Lait demi-écrémé Bio 1L". */
  label: string;
  /** Marque, ex. "Marque Repère". Optionnel. */
  brand?: string;
  /** Prix unitaire en euros, ex. 1.29. */
  price: number;
  /** Prix au kilo / litre quand le site l'expose, ex. "1,29 €/L". */
  pricePerUnit?: string;
  /** Nutri-Score A–E quand disponible. */
  nutriScore?: string;
  /** Disponibilité dans le magasin sélectionné. */
  available: boolean;
  /** URL vignette quand disponible. */
  imageUrl?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
  /** quantity * prix unitaire, en euros. */
  lineTotal: number;
}

export interface Cart {
  items: CartItem[];
  /** Nombre de lignes distinctes. */
  itemCount: number;
  /** Somme des totaux de ligne, en euros. */
  total: number;
  storeId: string;
}

/** Origine d'un productId : seule celle issue de la recherche Leclerc est fiable. */
export type ProductIdSource = "leclerc_search" | "model_hallucination";