/**
 * Approval gate (ticket #44): the ONLY door to cart mutation tools.
 *
 * The gate holds one global decision for a whole shopping flow. The decision
 * is never automatic: the flow injects a handler (a scenario event in the
 * harness, a UI callback in the extension) which the gate calls when an
 * approval is requested. The engine's tool executor consults the gate BEFORE
 * any mutation call — an unapproved mutation is never executed.
 *
 * The payload of an approval request is the cart preview: the single,
 * complete list of planned mutations the user approves (or refuses) as a
 * whole. That is why the preview types live here.
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

  constructor(private readonly handler: ApprovalDecisionHandler) {}

  /** True only after the handler approved the submitted request. */
  isApproved(): boolean {
    return this.decision?.approved === true;
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
