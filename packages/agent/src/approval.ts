/**
 * Mutation authorization gate. The progressive preparation path permits only
 * an exact catalogue reference and absolute quantity from its durable intent.
 * Historical deterministic scenarios retain their explicit global decision.
 * Models cannot grant either authorization through tool output.
 */

import type { Cart, Product } from "@leclerc/contracts";

/** One planned cart line in the preview shown for approval. */
export interface CartPreviewLine {
  /** Catalogue product id — comes only from a search/list tool result. */
  productId: string;
  /** Catalogue label (untrusted display text). */
  label: string;
  /** Ingredient of the generated recipe this line matches. */
  ingredient: string;
  /** Purchase quantity: number of packaging units (packaging ceil rule). */
  quantity: number;
  /** Unit price in euros. */
  unitPrice: number;
  /** quantity * unitPrice, in euros. */
  lineTotal: number;
  /** Sales packaging as displayed by the catalogue, e.g. "600 g". */
  packaging?: string;
  /** Token-score of the deterministic match (auditability). */
  matchScore: number;
  /** Optional note, e.g. why a default quantity was applied. */
  note?: string;
}

/** The complete, readable cart proposal submitted to global approval. */
export interface CartPreview {
  /** Recipe title the lines were computed from. */
  recipeTitle: string;
  /** Servings the quantities were computed for. */
  servings: number;
  lines: CartPreviewLine[];
  /** Sum of line totals, in euros. */
  total: number;
}

/** What is submitted to the user for a global approval decision. */
export interface ApprovalRequest {
  kind: "global_cart_mutation";
  /** Human-readable French summary. */
  summary: string;
  /** The complete preview of planned mutations. */
  preview: CartPreview;
  /** Cart state at the moment of the request, when already readable. */
  cart?: Cart;
}

/** The decision injected as a scenario event — approved, or refused. */
export type ApprovalDecision =
  | { approved: true }
  | { approved: false; reason?: string };

/** Handler injected by the caller (scenario event callback, UI callback). */
export type ApprovalDecisionHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision> | ApprovalDecision;

/**
 * Global approval state for one shopping flow run. A fresh gate starts
 * unapproved; requestApproval delegates the decision to the injected handler
 * and remembers it. A resume run uses a NEW gate, so a new approval is
 * always required before any further mutation.
 */
export class ApprovalGate {
  private decision: ApprovalDecision | undefined;
  private prepared: { productId: string; quantity: number } | undefined;

  constructor(private readonly handler: ApprovalDecisionHandler) {}

  /** True only after the handler approved the submitted request. */
  isApproved(): boolean {
    return this.decision?.approved === true;
  }

  /** A preparation request authorizes only this verified, absolute mutation. */
  permitPreparedQuantity(productId: string, quantity: number): void {
    if (!productId || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999) throw new Error("Quantité préparée invalide.");
    this.prepared = { productId, quantity };
  }

  clearPreparedQuantity(): void { this.prepared = undefined; }

  permits(name: string, input: unknown): boolean {
    if (this.isApproved()) return true;
    if (name !== "update_quantity" || !input || typeof input !== "object") return false;
    const value = input as { productId?: unknown; quantity?: unknown };
    return this.prepared !== undefined && value.productId === this.prepared.productId && value.quantity === this.prepared.quantity;
  }

  /** The decision that was taken, when one was requested. */
  getDecision(): ApprovalDecision | undefined {
    return this.decision;
  }

  /**
   * Ask the injected handler for the global decision and store it.
   * Calling this again (e.g. on resume) starts a fresh decision round.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = await this.handler(request);
    this.decision = decision;
    return decision;
  }
}

/** A candidate product presented in a clarification question (ambiguous match). */
export interface ClarificationCandidate {
  productId: string;
  label: string;
  price: number;
  packaging?: string;
}

/** Question asked when the deterministic matching rule cannot decide alone. */
export interface ClarificationQuestion {
  kind: "ambiguous_match";
  /** Ingredient the ambiguity is about. */
  ingredient: string;
  /** Candidates in deterministic tie order. */
  candidates: ClarificationCandidate[];
  /** Human-readable French question. */
  message: string;
}

/** Answer injected as a scenario event by the clarification handler. */
export type ClarificationAnswer =
  | { productId: string }
  | { skip: true };

/** Handler injected by the caller; absent handler means the item is skipped. */
export type ClarificationHandler = (
  question: ClarificationQuestion,
) => Promise<ClarificationAnswer> | ClarificationAnswer;
