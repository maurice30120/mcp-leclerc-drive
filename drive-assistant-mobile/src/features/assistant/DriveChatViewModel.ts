/**
 * Chat assistant outillé : le modèle discute, appelle les outils Drive en
 * lecture, et les mutations restent suspendues jusqu'à confirmation UI.
 */

import type { AIRuntime } from '../ai/runtime.ts';
import type {
  MistralConversationMessage,
  MistralToolCall,
  MistralToolDefinition,
} from '../ai/mistral-client.ts';
import type { LeclercConnector } from '../leclerc/connector.ts';
import { McpRunner } from '../mcp/runner.ts';
import { TOOL_SCHEMAS } from '../mcp/registry.ts';
import { isMutationCommand, type LeclercCommandName } from '../mcp/types.ts';
import type { PermissionGate } from '../mcp/permissions.ts';
import type { McpLogger } from '../mcp/logs.ts';
import type { SessionHistory } from '../mcp/history.ts';
import { isForbiddenCheckoutIntent, isForbiddenCredentialStorage } from '../safety/guards.ts';
import type { Cart, Product } from '../../shared/types.ts';

export interface DriveChatDeps {
  connector: LeclercConnector;
  gate: PermissionGate;
  logger: McpLogger;
  history: SessionHistory;
  ai?: Pick<AIRuntime, 'isReady' | 'completeChat'> | null;
}

export interface ChatLine {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface PendingToolConfirmation {
  id: string;
  command: LeclercCommandName;
  args: Record<string, unknown>;
  label: string;
  toolCallId: string;
}

export interface SendResult {
  lines: ChatLine[];
  pending: PendingToolConfirmation[];
  rawModel: string | null;
}

const CHAT_SYSTEM_PROMPT = [
  'Tu es un assistant courses pour Leclerc Drive.',
  'Réponds en français, simplement, comme dans un chat.',
  'Tu peux appeler les outils Drive disponibles pour chercher des produits, lire le panier ou connaître le magasin.',
  'Avant toute modification du panier, appelle l outil adapté : l application demandera ensuite confirmation à l utilisateur.',
  'N invente jamais de product_id. Pour add_to_cart, utilise seulement un product_id vu dans search_products.',
  'Pour update_quantity ou remove_from_cart, utilise seulement un product_id vu dans search_products ou get_cart.',
  'Tu ne peux pas payer, valider une commande, stocker un mot de passe ou gérer une carte bancaire.',
].join('\n');

const MAX_TOOL_ROUNDS = 5;

export class DriveChatViewModel {
  private readonly deps: DriveChatDeps;
  private readonly runner: McpRunner;
  private readonly modelMessages: MistralConversationMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
  ];
  private readonly lines: ChatLine[] = [];
  private readonly pending = new Map<string, PendingToolConfirmation>();
  private readonly searchProductIds = new Set<string>();
  private readonly cartProductIds = new Set<string>();
  private readonly productLabels = new Map<string, string>();
  private lastRawModel: string | null = null;
  private seq = 0;

  constructor(deps: DriveChatDeps) {
    this.deps = deps;
    this.runner = new McpRunner({
      connector: deps.connector,
      gate: deps.gate,
      logger: deps.logger,
      history: deps.history,
    });
  }

  getLines(): ChatLine[] {
    return [...this.lines];
  }

  getPending(): PendingToolConfirmation[] {
    return [...this.pending.values()];
  }

  getLastRawModel(): string | null {
    return this.lastRawModel;
  }

  async sendUserMessage(textInput: string): Promise<SendResult> {
    const text = textInput.trim();
    if (!text) throw new Error('Message vide.');
    if (!this.deps.ai?.isReady()) {
      throw new Error('API Mistral non prête. Vérifie la clé dans Réglages.');
    }
    if (isForbiddenCheckoutIntent(text)) {
      throw new Error('Action interdite : paiement / validation de commande non supporté.');
    }
    if (isForbiddenCredentialStorage(text)) {
      throw new Error('Action interdite : aucun stockage de mot de passe ni de données bancaires.');
    }

    this.addLine('user', text);
    this.modelMessages.push({ role: 'user', content: text });
    await this.runModelLoop();
    return this.snapshot();
  }

  async confirmTool(id: string): Promise<SendResult> {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('Confirmation expirée.');
    this.pending.delete(id);

    const args = argsWithLabel(pending.args, pending.label);
    const ticket = this.deps.gate.issue(pending.command, args);
    const result = await this.runner.runTool(pending.command, args, {
      nonce: ticket.nonce,
      host: this.deps.connector.host,
    });
    this.rememberToolData(pending.command, result.data);
    const content = result.isError ? `Erreur outil ${pending.command}: ${result.text}` : result.text;
    this.modelMessages.push({
      role: 'tool',
      name: pending.command,
      toolCallId: pending.toolCallId,
      content,
    });
    this.addLine('tool', `${pending.command} confirmé\n${content}`);

    if (this.deps.ai?.isReady()) {
      await this.runModelLoop();
    }
    return this.snapshot();
  }

  rejectTool(id: string): SendResult {
    const pending = this.pending.get(id);
    if (!pending) throw new Error('Confirmation expirée.');
    this.pending.delete(id);
    this.modelMessages.push({
      role: 'tool',
      name: pending.command,
      toolCallId: pending.toolCallId,
      content: `Mutation ${pending.command} refusée par l utilisateur.`,
    });
    this.addLine('assistant', `${pending.command} refusé.`);
    return this.snapshot();
  }

  clear(): SendResult {
    this.lines.length = 0;
    this.modelMessages.length = 1;
    this.pending.clear();
    this.searchProductIds.clear();
    this.cartProductIds.clear();
    this.productLabels.clear();
    this.lastRawModel = null;
    this.deps.gate.clear();
    return this.snapshot();
  }

  private async runModelLoop(): Promise<void> {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await this.deps.ai!.completeChat({
        messages: this.modelMessages,
        tools: driveTools(),
        toolChoice: 'auto',
        responseFormat: 'text',
      });
      this.lastRawModel = turn.raw;

      const toolCalls = normalizeToolCalls(turn.toolCalls);
      this.modelMessages.push({
        role: 'assistant',
        content: turn.text || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
      });

      if (toolCalls.length === 0) {
        this.addLine('assistant', turn.text || 'Je n ai pas de réponse exploitable.');
        return;
      }

      if (turn.text.trim()) {
        this.addLine('assistant', turn.text.trim());
      }

      let readToolExecuted = false;
      for (const call of toolCalls) {
        const result = await this.handleToolCall(call);
        if (result === 'pending_mutation') return;
        if (result === 'read_executed') readToolExecuted = true;
      }

      if (!readToolExecuted) return;
    }
    this.addLine('assistant', 'J ai arrêté les appels outils pour éviter une boucle.');
  }

  private async handleToolCall(call: MistralToolCall): Promise<'read_executed' | 'pending_mutation'> {
    const name = call.function.name;
    const args = parseToolArgs(call.function.arguments);
    const toolCallId = call.id || `tool-${++this.seq}`;

    if (!isKnownCommand(name)) {
      this.pushToolResult(name, toolCallId, `Outil inconnu : ${name}`);
      return 'read_executed';
    }

    if (isMutationCommand(name)) {
      const validation = this.validateMutation(name, args);
      if (!validation.ok) {
        this.pushToolResult(name, toolCallId, validation.error);
        return 'read_executed';
      }
      const pending: PendingToolConfirmation = {
        id: `pending-${++this.seq}`,
        command: name,
        args,
        label: labelForArgs(args, this.productLabels),
        toolCallId,
      };
      this.pending.set(pending.id, pending);
      this.addLine('assistant', `Confirmation requise : ${pending.label}`);
      return 'pending_mutation';
    }

    const result = await this.runner.runTool(name, args, { host: this.deps.connector.host });
    this.rememberToolData(name, result.data);
    const content = result.isError ? `Erreur outil ${name}: ${result.text}` : result.text;
    this.pushToolResult(name, toolCallId, content);
    this.addLine('tool', `${name}\n${content}`);
    return 'read_executed';
  }

  private pushToolResult(name: string, toolCallId: string, content: string): void {
    this.modelMessages.push({
      role: 'tool',
      name,
      toolCallId,
      content,
    });
  }

  private validateMutation(
    command: LeclercCommandName,
    args: Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string } {
    const productId = typeof args.product_id === 'string' ? args.product_id.trim() : '';
    if (!productId) return { ok: false, error: `${command}: product_id requis.` };
    if (command === 'add_to_cart' && !this.searchProductIds.has(productId)) {
      return {
        ok: false,
        error: 'add_to_cart refusé : product_id absent des résultats search_products de cette conversation.',
      };
    }
    if (
      (command === 'update_quantity' || command === 'remove_from_cart') &&
      !this.searchProductIds.has(productId) &&
      !this.cartProductIds.has(productId)
    ) {
      return {
        ok: false,
        error: `${command} refusé : product_id absent des résultats search_products/get_cart de cette conversation.`,
      };
    }
    return { ok: true };
  }

  private rememberToolData(command: string, data: unknown): void {
    if (command === 'search_products' && Array.isArray(data)) {
      for (const product of data as Product[]) {
        this.searchProductIds.add(product.id);
        this.productLabels.set(product.id, product.label);
      }
      return;
    }
    if (command === 'get_cart' && data && typeof data === 'object') {
      for (const item of ((data as Cart).items ?? [])) {
        this.cartProductIds.add(item.product.id);
        this.productLabels.set(item.product.id, item.product.label);
      }
    }
  }

  private addLine(role: ChatLine['role'], text: string): void {
    this.lines.push({ id: `line-${++this.seq}`, role, text });
  }

  private snapshot(): SendResult {
    return {
      lines: this.getLines(),
      pending: this.getPending(),
      rawModel: this.lastRawModel,
    };
  }
}

export function driveTools(): MistralToolDefinition[] {
  return TOOL_SCHEMAS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        required: tool.inputSchema.required,
        properties: tool.inputSchema.properties,
      },
    },
  }));
}

function normalizeToolCalls(calls: MistralToolCall[]): MistralToolCall[] {
  return calls.map((call, index) => ({
    ...call,
    id: call.id || `call-${index}`,
    type: 'function',
  }));
}

function parseToolArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isKnownCommand(name: string): name is LeclercCommandName {
  return TOOL_SCHEMAS.some((tool) => tool.name === name);
}

function labelForArgs(args: Record<string, unknown>, labels: Map<string, string>): string {
  const productId = typeof args.product_id === 'string' ? args.product_id : '';
  const label = productId ? labels.get(productId) : undefined;
  const quantity = typeof args.quantity === 'number' ? ` x${args.quantity}` : '';
  return [label ?? productId, quantity].filter(Boolean).join('');
}

function argsWithLabel(args: Record<string, unknown>, label: string): Record<string, unknown> {
  return label ? { ...args, label } : args;
}
