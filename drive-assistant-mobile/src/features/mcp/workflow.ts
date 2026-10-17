/**
 * Helpers d'orchestration pure : du Plan généré → appels search_products, puis
 * des sélections produit réelles → appels add_to_cart.
 *
 * Port isolé de mcp-leclerc-drive (src/orchestrator/workflow.ts). Garde la
 * frontière unit-testable sans WebView ni runtime IA :
 *   1. search_products pour chaque item du plan (les product_id viennent
 *      ensuite des résultats réels),
 *   2. add_to_cart après sélection utilisateur/catalogue.
 */

import type { Plan } from '../ai/plan.ts';
import { isMutationCommand, isReadCommand, type LeclercCommandName } from './types.ts';

export interface SearchCall {
  command: 'search_products';
  args: { query: string };
}

export interface AddToCartCall {
  command: 'add_to_cart';
  args: { product_id: string; quantity: number };
}

export interface ProductSelection {
  /** Index de l'item du Plan que ce produit résout. */
  itemIndex: number;
  /** productId RÉEL issu de search_products (jamais du modèle). */
  productId: string;
  /** Quantité ajustée par l'utilisateur (défaut = qté du plan). */
  quantity?: number;
}

export interface BuildCallsOk {
  ok: true;
  calls: AddToCartCall[];
}
export interface BuildCallsErr {
  ok: false;
  error: string;
}
export type BuildCallsResult = BuildCallsOk | BuildCallsErr;

export function searchCallsForPlan(plan: Plan): SearchCall[] {
  return plan.items.map((item) => ({
    command: 'search_products',
    args: { query: item.query },
  }));
}

export function addToCartCallsForSelections(
  plan: Plan,
  selections: readonly ProductSelection[],
): BuildCallsResult {
  const byIndex = new Map<number, ProductSelection>();
  for (const selection of selections) {
    if (!Number.isInteger(selection.itemIndex)) {
      return { ok: false, error: 'Sélection invalide : index non entier.' };
    }
    if (selection.itemIndex < 0 || selection.itemIndex >= plan.items.length) {
      return { ok: false, error: `Sélection invalide : item ${selection.itemIndex} inconnu.` };
    }
    const productId = selection.productId.trim();
    if (!productId) {
      return {
        ok: false,
        error: `Sélection invalide : product_id manquant pour item ${selection.itemIndex}.`,
      };
    }
    byIndex.set(selection.itemIndex, { ...selection, productId });
  }

  if (byIndex.size !== plan.items.length) {
    return { ok: false, error: 'Tous les items du plan doivent avoir un produit sélectionné.' };
  }

  const calls: AddToCartCall[] = [];
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const selection = byIndex.get(i);
    if (!selection) {
      return { ok: false, error: `Produit non sélectionné pour item ${i}.` };
    }
    const quantity = normalizeQuantity(selection.quantity ?? item.quantity);
    if (quantity === null) {
      return { ok: false, error: `Quantité invalide pour item ${i}.` };
    }
    calls.push({
      command: 'add_to_cart',
      args: { product_id: selection.productId, quantity },
    });
  }

  return { ok: true, calls };
}

function normalizeQuantity(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  const n = Math.trunc(raw);
  if (n < 1 || n > 99) return null;
  return n;
}

/** Prédicats utilitaires réexportés pour les écrans/vues. */
export { isReadCommand, isMutationCommand };
export type { LeclercCommandName };
