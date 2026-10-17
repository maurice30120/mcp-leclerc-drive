/**
 * Vocabulaire de commandes Leclerc + types MCP internes à l'app.
 *
 * Port isolé de mcp-leclerc-drive (src/orchestrator/messages.ts +
 * dispatcher.ts). Les noms d'outils sont stables ; les schémas en JSON-Schema
 * simplifié pour la validation interne.
 */

export const READ_COMMANDS = ['search_products', 'get_cart', 'get_store'] as const;
export const MUTATION_COMMANDS = ['add_to_cart', 'update_quantity', 'remove_from_cart'] as const;

export type ReadCommand = (typeof READ_COMMANDS)[number];
export type MutationCommand = (typeof MUTATION_COMMANDS)[number];
export type LeclercCommandName = ReadCommand | MutationCommand;

export function isReadCommand(name: string): name is ReadCommand {
  return (READ_COMMANDS as readonly string[]).includes(name);
}
export function isMutationCommand(name: string): name is MutationCommand {
  return (MUTATION_COMMANDS as readonly string[]).includes(name);
}
export function isLeclercCommand(name: string): name is LeclercCommandName {
  return isReadCommand(name) || isMutationCommand(name);
}

export type Permission = 'read' | 'mutation';

/** Appel validé prêt à exécuter par le connecteur. */
export type ReadCall =
  | { command: 'search_products'; query: string }
  | { command: 'get_cart' }
  | { command: 'get_store' };

export type MutationCall =
  | { command: 'add_to_cart'; productId: string; quantity: number }
  | { command: 'update_quantity'; productId: string; quantity: number }
  | { command: 'remove_from_cart'; productId: string };

export type DispatchCall = ReadCall | MutationCall;

export interface ToolSchema {
  name: string;
  description: string;
  permission: Permission;
  /** Schéma simplifié des paramètres attendus. */
  inputSchema: { required: string[]; properties: Record<string, { type: string }> };
}

export interface CallToolResult {
  isError?: boolean;
  data?: unknown;
  text: string;
}