/**
 * Injectable tool-level fault plan (issue #42).
 *
 * A fault plan is an ordered list of rules; the mock dispatcher evaluates it
 * BEFORE executing a capability, after the registry's input validation. The
 * first matching rule fires and the capability is never executed, so mock
 * state stays untouched. Seven fault families are supported — the same codes
 * the real Leclerc adapter can produce.
 */

import {
  FAULT_CODES,
  getCapability,
  toolError,
  type FaultCode,
  type ToolError,
} from "@leclerc/contracts";

/**
 * One injectable fault. Predicates are combined with AND; all optional
 * predicates must match for the rule to satisfy a call.
 */
export interface FaultRule {
  /** Normalized fault family to produce. */
  code: FaultCode;
  /** Restrict to one capability (registry name). Default: any capability. */
  capability?: string;
  /** Restrict to calls whose validated input references this product id. */
  productId?: string;
  /** Fire only on the nth call satisfying the other predicates (1-based). */
  nth?: number;
  /** Override the default French message. */
  message?: string;
  /** Extra structured details surfaced on the ToolError. */
  details?: Record<string, unknown>;
}

export type FaultPlan = readonly FaultRule[];

/** What the dispatcher knows about the call being evaluated. */
export interface FaultContext {
  capability: string;
  /** Product id referenced by the validated input, when any. */
  productId?: string;
  /** 1-based count of calls made to this capability in this environment. */
  callIndex: number;
}

/** Default French messages for injected faults, one per family. */
export const DEFAULT_FAULT_MESSAGES: Readonly<Record<FaultCode, string>> = {
  PRODUCT_NOT_FOUND: "Produit introuvable dans le catalogue du drive.",
  PRODUCT_UNAVAILABLE: "Produit indisponible dans ce drive.",
  CART_MUTATION_REFUSED: "Mutation du panier refusée par le drive.",
  INVALID_ID: "Identifiant invalide.",
  SESSION_EXPIRED: "Session expirée : reconnexion au drive nécessaire.",
  EMPTY_RESULT: "Aucun résultat.",
  TRANSIENT_ERROR: "Erreur transitoire du drive, réessayez.",
};

/**
 * Reject malformed plans eagerly (unknown family, unknown capability name,
 * non-positive nth) instead of failing silently mid-scenario.
 */
export function validateFaultPlan(plan: FaultPlan): void {
  for (const rule of plan) {
    if (!rule || typeof rule !== "object" || !FAULT_CODES.includes(rule.code)) {
      throw new Error(`Plan de fautes invalide : code inconnu '${String((rule as FaultRule)?.code)}'.`);
    }
    if (rule.capability !== undefined && getCapability(rule.capability) === undefined) {
      throw new Error(`Plan de fautes invalide : capacité inconnue '${rule.capability}'.`);
    }
    if (
      rule.productId !== undefined &&
      (typeof rule.productId !== "string" || rule.productId.trim() === "")
    ) {
      throw new Error("Plan de fautes invalide : productId doit être une chaîne non vide.");
    }
    if (rule.nth !== undefined && (!Number.isInteger(rule.nth) || rule.nth < 1)) {
      throw new Error(`Plan de fautes invalide : nth doit être un entier ≥ 1 (reçu ${String(rule.nth)}).`);
    }
  }
}

/**
 * Evaluate a plan against a call context. `matchCounts` carries the per-rule
 * satisfaction counters of one mock environment (so `nth` is scoped to it and
 * reset together with the environment).
 *
 * Returns the normalized ToolError of the first firing rule, or undefined.
 */
export function evaluateFault(
  plan: FaultPlan,
  context: FaultContext,
  matchCounts: Map<FaultRule, number>,
): ToolError | undefined {
  let firing: FaultRule | undefined;
  for (const rule of plan) {
    if (rule.capability !== undefined && rule.capability !== context.capability) continue;
    if (rule.productId !== undefined && rule.productId !== context.productId) continue;
    const count = (matchCounts.get(rule) ?? 0) + 1;
    matchCounts.set(rule, count);
    if (firing === undefined && (rule.nth === undefined || rule.nth === count)) {
      firing = rule;
    }
  }
  if (!firing) return undefined;
  return toolError(firing.code, firing.message ?? DEFAULT_FAULT_MESSAGES[firing.code], {
    injected: true,
    capability: context.capability,
    callIndex: context.callIndex,
    ...(firing.productId !== undefined ? { productId: firing.productId } : {}),
    ...firing.details,
  });
}
