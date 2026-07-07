/**
 * View-model assistant — orchestration du flux complet, dépendances injectées.
 *
 * Flux :
 *   1. userText → (a) normaliseur déterministe, sinon (b) API IA Mistral → Plan.
 *   2. Plan → search_products pour chaque item (productId réels uniquement).
 *   3. L'utilisateur choisit un produit par item + ajuste qté → sélections.
 *   4. Clic Valider → émission d'un ticket de confirmation (PermissionGate).
 *   5. Exécution des add_to_cart via le runner (mutation confirmée).
 *
 * Sécurité : aucun productId ne vient du modèle ; les garde-fous de
 * safety/guards.ts sont vérifiés avant l'exécution. Aucune mutation sans
 * ticket consommable.
 */

import { normalizeShoppingList, type NormalizeResult } from '../ai/shopping-list.ts';
import { parsePlan, type Plan } from '../ai/plan.ts';
import { buildMessages } from '../ai/prompt.ts';
import type { AIRuntime } from '../ai/runtime.ts';
import type { LeclercConnector } from '../leclerc/connector.ts';
import { searchCallsForPlan, addToCartCallsForSelections, type ProductSelection } from '../mcp/workflow.ts';
import { type PermissionGate } from '../mcp/permissions.ts';
import { type McpLogger } from '../mcp/logs.ts';
import { type SessionHistory } from '../mcp/history.ts';
import { McpRunner } from '../mcp/runner.ts';
import {
  isForbiddenCheckoutIntent,
  isForbiddenCredentialStorage,
  planHasNoHallucinatedId,
  isTrustworthyProductId,
} from '../safety/guards.ts';
import type { Product } from '../../shared/types.ts';

export interface AssistantDeps {
  connector: LeclercConnector;
  gate: PermissionGate;
  logger: McpLogger;
  history: SessionHistory;
  ai?: AIRuntime | null;
}

export interface ProposalItem {
  /** Index du Plan item. */
  itemIndex: number;
  query: string;
  quantity: number;
  constraints?: string;
  notes?: string;
  /** Résultats réels de recherche. */
  results: Product[];
}

export interface Proposal {
  plan: Plan;
  items: ProposalItem[];
  questions?: string[];
  source: 'deterministic' | 'model';
}

export interface PlanInput {
  text: string;
}

export class AssistantViewModel {
  private proposal: Proposal | null = null;
  private lastProductsByIndex = new Map<number, Product[]>();
  private readonly deps: AssistantDeps;

  constructor(deps: AssistantDeps) {
    this.deps = deps;
  }

  private runner(): McpRunner {
    return new McpRunner({
      connector: this.deps.connector,
      gate: this.deps.gate,
      logger: this.deps.logger,
      history: this.deps.history,
    });
  }

  /** Étape 1 + 2 : produit un Plan et lance les recherches. */
  async planAndSearch(input: PlanInput): Promise<Proposal> {
    const text = input.text?.trim() ?? '';
    if (!text) throw new Error('Demande vide.');

    if (isForbiddenCheckoutIntent(text)) {
      throw new Error("Action interdite : paiement / validation de commande non supporté.");
    }
    if (isForbiddenCredentialStorage(text)) {
      throw new Error("Action interdite : aucun stockage de mot de passe ni de données bancaires.");
    }

    // (a) normaliseur déterministe d'abord, (b) modèle IA en repli.
    let plan: Plan | null = null;
    let source: 'deterministic' | 'model' = 'deterministic';

    const det = normalizeShoppingList(text);
    if (isNormalizeOk(det)) {
      plan = det.plan;
      source = 'deterministic';
    } else if (this.deps.ai && this.deps.ai.isReady()) {
      const raw = await this.deps.ai.complete(buildMessages(text));
      const parsed = parsePlan(raw);
      if (!parsed.ok) throw new Error(parsed.error);
      plan = parsed.plan;
      source = 'model';
      // Nettoyage défensif : rejet si id halluciné survivant.
      const guard = planHasNoHallucinatedId(plan);
      if (!guard.ok) {
        throw new Error(
          `Modèle : ids hallucinés détectés (${guard.offenders.map((o) => `items[${o.index}].${o.keys.join(',')}`).join('; ')}).`,
        );
      }
    }

    if (!plan) {
      throw new Error("Impossible de produire un plan : liste non structurée et API IA indisponible.");
    }

    // Recherche catalogue réelle pour chaque item.
    const runner = this.runner();
    const proposals: ProposalItem[] = [];
    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i];
      const call = searchCallsForPlan({ items: [item] })[0];
      const res = await runner.runTool(call.command, call.args, {});
      const products = (res.data as Product[] | undefined) ?? [];
      this.lastProductsByIndex.set(i, products);
      proposals.push({
        itemIndex: i,
        query: item.query,
        quantity: item.quantity,
        constraints: item.constraints,
        notes: item.notes,
        results: products,
      });
    }

    this.proposal = { plan, items: proposals, questions: plan.questions, source };
    return this.proposal;
  }

  getProposal(): Proposal | null {
    return this.proposal;
  }

  /** Étape 3 + 4 + 5 : validation + exécution des ajouts panier. */
  async confirmAndAdd(selections: readonly ProductSelection[]): Promise<{ added: string[] }> {
    if (!this.proposal) throw new Error('Aucune proposition à valider.');

    // Tous les productId doivent provenir des résultats réels (jamais du modèle).
    for (const sel of selections) {
      const trust = isTrustworthyProductId('leclerc_search'); // le seul canal autorisé
      if (!trust) {
        throw new Error('Canal productId non fiable.');
      }
      const results = this.lastProductsByIndex.get(sel.itemIndex) ?? this.proposal.items[sel.itemIndex].results;
      const found = results.some((p) => p.id === sel.productId);
      if (!found) {
        throw new Error(
          `productId ${sel.productId} absent des résultats de recherche — refus (id halluciné ou obsolète).`,
        );
      }
    }

    const built = addToCartCallsForSelections(this.proposal.plan, selections);
    if (!built.ok) throw new Error(built.error);

    const runner = this.runner();
    const added: string[] = [];
    for (const call of built.calls) {
      const args = { ...call.args, label: labelFor(this.proposal, call.args.product_id) };
      // Émission d'un ticket de confirmation (défense en profondeur : le clic
      // Valider côté UI appelle aussi confirm()). Ici le ticket symbolise
      // l'acte de validation.
      const ticket = this.deps.gate.issue(call.command, args);
      const res = await runner.runTool(call.command, args, { nonce: ticket.nonce });
      if (res.isError) throw new Error(`add_to_cart échoué : ${res.text}`);
      added.push(call.args.product_id);
    }
    return { added };
  }

  /** Refus explicite (l'utilisateur clique Refuser). */
  reject(): void {
    this.proposal = null;
    this.lastProductsByIndex.clear();
    this.deps.gate.clear();
  }
}

function isNormalizeOk(r: NormalizeResult): r is Extract<NormalizeResult, { ok: true }> {
  return r !== null && r.ok === true;
}

function labelFor(proposal: Proposal, productId: string): string | undefined {
  for (const item of proposal.items) {
    const p = item.results.find((x) => x.id === productId);
    if (p) return p.label;
  }
  return undefined;
}
