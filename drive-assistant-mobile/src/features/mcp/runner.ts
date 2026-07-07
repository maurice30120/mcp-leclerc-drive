/**
 * Runner MCP interne : exécute un appel validé contre le connecteur Leclerc,
 * derrière le gate de permissions (confirmation obligatoire pour les
 * mutations) et le journal MCP.
 *
 * Dépendances injectées pour rester testable sans RN. Les mutations ne partent
 * qu'après `verify` d'un ticket de confirmation émis par l'utilisateur.
 */

import type { LeclercConnector, ConnectorLogEntry } from '../leclerc/connector.ts';
import { formatCart, formatProduct, scrubUntrusted } from '../leclerc/connector.ts';
import { isMutationCall, validateCommand, type DispatchCall } from './dispatcher.ts';
import { validateAgainstSchema } from './registry.ts';
import { type PermissionGate } from './permissions.ts';
import { type McpLogger } from './logs.ts';
import { type SessionHistory } from './history.ts';
import type { CallToolResult, LeclercCommandName } from './types.ts';

export interface RunnerDeps {
  connector: LeclercConnector;
  gate: PermissionGate;
  logger: McpLogger;
  history: SessionHistory;
}

export interface RunOptions {
  /** Nonce du ticket confirmé — requis pour toute mutation. */
  nonce?: string;
  /** Hôte Leclerc (re-vérifié côté mutations). */
  host?: string;
}

export class McpRunner {
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /** Exécute un tool brut (nom + args). */
  async runTool(
    name: string,
    args: Record<string, unknown>,
    opts: RunOptions = {},
  ): Promise<CallToolResult> {
    const schemaCheck = validateAgainstSchema(name, args);
    if (!schemaCheck.ok) {
      this.deps.logger.log({
        at: Date.now(),
        command: name,
        permission: isMutationName(name) ? 'mutation' : 'read',
        status: 'blocked',
        error: schemaCheck.error,
      });
      return { isError: true, text: schemaCheck.error };
    }

    const validated = validateCommand(name, args, opts.host);
    if (!validated.ok) {
      this.deps.logger.log({
        at: Date.now(),
        command: name,
        permission: isMutationName(name) ? 'mutation' : 'read',
        status: 'blocked',
        error: validated.error,
        args,
      });
      return { isError: true, text: validated.error };
    }
    return this.run(validated.call, args, opts);
  }

  /** Exécute un appel déjà validé. */
  async runValidated(call: DispatchCall, opts: RunOptions = {}): Promise<CallToolResult> {
    return this.run(call, callArgs(call), opts);
  }

  private async run(
    call: DispatchCall,
    rawArgs: Record<string, unknown>,
    opts: RunOptions,
  ): Promise<CallToolResult> {
    const isMut = isMutationCall(call);
    const permission = isMut ? 'mutation' : 'read';

    // Confirmation obligatoire pour toute mutation.
    if (isMut) {
      if (!opts.nonce || !this.deps.gate.verify(opts.nonce, call.command, rawArgs)) {
        this.deps.logger.log({
          at: Date.now(),
          command: call.command,
          permission,
          status: 'blocked',
          args: rawArgs,
          error: 'Mutation refusée sans confirmation utilisateur.',
        });
        return {
          isError: true,
          text: 'Mutation refusée : confirmation utilisateur requise (clic Valider).',
        };
      }
    }

    const logEntry = this.deps.logger.log({
      at: Date.now(),
      command: call.command,
      permission,
      status: 'pending',
      args: rawArgs,
      nonce: opts.nonce,
    });

    try {
      switch (call.command) {
        case 'search_products': {
          const products = await this.deps.connector.searchProducts(call.query);
          const text = products.map((p) => formatProduct(p)).join('\n');
          this.deps.logger.update(logEntry.id, { status: 'ok', text });
          return { data: products, text: text || 'Aucun produit trouvé.' };
        }
        case 'get_cart': {
          const cart = await this.deps.connector.getCart();
          this.deps.logger.update(logEntry.id, { status: 'ok', text: formatCart(cart) });
          return { data: cart, text: formatCart(cart) };
        }
        case 'get_store': {
          const text = `magasin ${this.deps.connector.storeId} @ ${this.deps.connector.host}`;
          this.deps.logger.update(logEntry.id, { status: 'ok', text });
          return { data: { storeId: this.deps.connector.storeId, host: this.deps.connector.host }, text };
        }
        case 'add_to_cart': {
          const cart = await this.deps.connector.addToCart(call.productId, call.quantity);
          const label = String(rawArgs.label ?? '');
          this.deps.history.add({
            at: Date.now(),
            command: call.command,
            productId: call.productId,
            quantity: call.quantity,
            label: label ? scrubUntrusted(label) : undefined,
            confirmed: true,
          });
          this.deps.logger.update(logEntry.id, { status: 'ok', text: formatCart(cart) });
          return { data: cart, text: formatCart(cart) };
        }
        case 'update_quantity': {
          const cart = await this.deps.connector.updateQuantity(call.productId, call.quantity);
          this.deps.history.add({
            at: Date.now(),
            command: call.command,
            productId: call.productId,
            quantity: call.quantity,
            confirmed: true,
          });
          this.deps.logger.update(logEntry.id, { status: 'ok', text: formatCart(cart) });
          return { data: cart, text: formatCart(cart) };
        }
        case 'remove_from_cart': {
          const cart = await this.deps.connector.removeFromCart(call.productId);
          this.deps.history.add({
            at: Date.now(),
            command: call.command,
            productId: call.productId,
            quantity: 0,
            confirmed: true,
          });
          this.deps.logger.update(logEntry.id, { status: 'ok', text: formatCart(cart) });
          return { data: cart, text: formatCart(cart) };
        }
      }
      const exhaust: never = call;
      void exhaust;
      return { isError: true, text: 'Non géré' };
    } catch (e) {
      this.deps.logger.update(logEntry.id, { status: 'error', error: (e as Error).message });
      return { isError: true, text: (e as Error).message };
    }
  }
}

function callArgs(call: DispatchCall): Record<string, unknown> {
  switch (call.command) {
    case 'search_products':
      return { query: call.query };
    case 'get_cart':
    case 'get_store':
      return {};
    case 'add_to_cart':
    case 'update_quantity':
      return { product_id: call.productId, quantity: call.quantity };
    case 'remove_from_cart':
      return { product_id: call.productId };
  }
}

function isMutationName(name: string): name is LeclercCommandName {
  return (
    name === 'add_to_cart' ||
    name === 'update_quantity' ||
    name === 'remove_from_cart'
  );
}

/** Repompe des logs du connecteur vers le journal MCP. */
export function bridgeConnectorLog(logger: McpLogger) {
  return (e: ConnectorLogEntry) => {
    logger.log({
      at: e.at,
      command: e.command,
      permission:
        e.command === 'add_to_cart' || e.command === 'update_quantity' || e.command === 'remove_from_cart'
          ? 'mutation'
          : 'read',
      status: e.ok ? 'ok' : 'error',
      error: e.error,
      args: e.productId ? { product_id: e.productId, quantity: e.quantity } : undefined,
    });
  };
}
