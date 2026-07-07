/**
 * Garde-fous de sécurité du Drive Assistant Mobile.
 *
 * Invariants énoncés dans le plan, défendus par des prédicats + un gate de
 * mutation. Ces fonctions sont pures et testées (tests/safety.test.ts) ;
 * elles sont branchées par le view-model assistant et le runner MCP.
 */

import type { Product, ProductIdSource } from '../../shared/types.ts';
import type { Plan, PlanItem } from '../ai/plan.ts';
import { isLeclercHost } from '../leclerc/api.ts';

/**
 * Accepte un produit comme candidat d'ajout panier seulement si son id provient
 * d'une recherche Leclerc réelle (jamais du modèle).
 */
export function isTrustworthyProductId(source: ProductIdSource): boolean {
  return source === 'leclerc_search';
}

/**
 * Vérifie qu'un productId est référencé dans les résultats de recherche réels
 * fournis au pipeline. Le modèle ne fournit jamais d'id valide ici.
 */
export function productIdExistsInResults(
  productId: string,
  searchResults: readonly Product[],
): boolean {
  return searchResults.some((p) => p.id === productId);
}

/** Vrai ssi le plan est nettoyé de tout id halluciné. */
export function planHasNoHallucinatedId(plan: Plan): {
  ok: boolean;
  offenders: { index: number; keys: string[] }[];
} {
  const offenders: { index: number; keys: string[] }[] = [];
  const forbidden = ['product_id', 'id', 'productId', 'iIdProduit'];
  plan.items.forEach((it: PlanItem, index: number) => {
    const record = it as unknown as Record<string, unknown>;
    const keys = forbidden.filter((k) => record[k] !== undefined);
    if (keys.length > 0) offenders.push({ index, keys });
  });
  return { ok: offenders.length === 0, offenders };
}

/** Vrai ssi la mutation est sur un host Leclerc (porte SSRF). */
export function hostIsLeclerc(host: string | undefined): boolean {
  return !!host && isLeclercHost(host);
}

/** Vrai ssi une action demandée ne paie/ne valide pas de commande. */
export function isForbiddenCheckoutIntent(text: string): boolean {
  const t = text.toLocaleLowerCase('fr-FR');
  return /\b(payer|paiement|checkout|valider (ma )?commande|commander)\b/.test(t);
}

/** Vrai ssi l'intention mentionne un stockage interdit de mot de passe / CB. */
export function isForbiddenCredentialStorage(text: string): boolean {
  const t = text.toLocaleLowerCase('fr-FR');
  return /\b(enregistr(?:e|er)|stock(?:e|er)|mémoris(?:e|er)|sauvegard(?:e|er)).{0,20}(mot de passe|carte bancaire|cb|cryptogramme|cvv)\b/.test(t);
}

/**
 * Politique de mutation : refus par défaut ; seul un jeton de confirmation
 * utilisateur vivant (non consommé) autorise. Le runner MCP vérifie via
 * PermissionGate avant d'appeler le connecteur.
 */
export class MutationGuard {
  private readonly confirmed = new Map<string, true>();

  /** Enregistre une confirmation utilisateur pour un nonce donné. */
  confirm(nonce: string): void {
    this.confirmed.set(nonce, true);
  }

  /** Vérifie + consomme. */
  canMutate(nonce: string): boolean {
    const ok = this.confirmed.has(nonce);
    if (ok) this.confirmed.delete(nonce);
    return ok;
  }

  /** A-t-on une confirmation en attente (avant clic Valider présentable ?). */
  hasPending(): boolean {
    return this.confirmed.size > 0;
  }
}
