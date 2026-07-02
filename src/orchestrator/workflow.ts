/**
 * Pure orchestration helpers for the popup workflow.
 *
 * The model generates a Plan. From there, the extension must only issue:
 *   1. read-only search_products calls for each planned item;
 *   2. add_to_cart mutations after the user/catalogue selection provides a
 *      real product id.
 *
 * These helpers keep that boundary unit-testable without Chrome, DOM, or the
 * local model runtime.
 */

import type { Plan } from "./plan.js";
import type { LeclercRunMsg } from "./messages.js";

export type SearchProductsCall = LeclercRunMsg & {
  command: "search_products";
  args: { query: string };
};

export type AddToCartCall = LeclercRunMsg & {
  command: "add_to_cart";
  args: { product_id: string; quantity: number };
};

export interface ProductSelection {
  /** Index of the Plan item this selected product resolves. */
  itemIndex: number;
  /** Real Leclerc product id selected from search_products results. */
  productId: string;
  /** Optional user-adjusted quantity. Defaults to the Plan item quantity. */
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

export function searchCallsForPlan(plan: Plan, traceId?: string): SearchProductsCall[] {
  return plan.items.map((item) => ({
    type: "leclerc_run",
    ...(traceId ? { traceId } : {}),
    command: "search_products",
    args: { query: item.query },
  }));
}

export function addToCartCallsForSelections(
  plan: Plan,
  selections: readonly ProductSelection[],
  traceId?: string,
): BuildCallsResult {
  const byIndex = new Map<number, ProductSelection>();
  for (const selection of selections) {
    if (!Number.isInteger(selection.itemIndex)) {
      return { ok: false, error: "Sélection invalide : index non entier." };
    }
    if (selection.itemIndex < 0 || selection.itemIndex >= plan.items.length) {
      return { ok: false, error: `Sélection invalide : item ${selection.itemIndex} inconnu.` };
    }
    const productId = selection.productId.trim();
    if (!productId) {
      return { ok: false, error: `Sélection invalide : product_id manquant pour item ${selection.itemIndex}.` };
    }
    byIndex.set(selection.itemIndex, { ...selection, productId });
  }

  if (byIndex.size !== plan.items.length) {
    return { ok: false, error: "Tous les items du plan doivent avoir un produit sélectionné." };
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
      type: "leclerc_run",
      ...(traceId ? { traceId } : {}),
      command: "add_to_cart",
      args: {
        product_id: selection.productId,
        quantity,
      },
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
