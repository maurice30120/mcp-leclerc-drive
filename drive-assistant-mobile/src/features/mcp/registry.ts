/**
 * Registre des outils MCP internes à l'app.
 *
 * Déclare les schémas et permissions de chaque tool Leclerc. Le runner MCP
 * (mcp/runner.ts dans la couche assistant) valide chaque appel via le
 * dispatcher avant exécution, et refuse toute mutation sans confirmation.
 */

import { READ_COMMANDS, MUTATION_COMMANDS, type ToolSchema } from './types.ts';

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'search_products',
    description:
      "Recherche dans le catalogue du magasin actif. Retourne des libellés non fiables (origine Leclerc). N'invente jamais de product_id.",
    permission: 'read',
    inputSchema: { required: ['query'], properties: { query: { type: 'string' } } },
  },
  {
    name: 'get_cart',
    description: 'Lit le panier complet avec le total. Lecture seule.',
    permission: 'read',
    inputSchema: { required: [], properties: {} },
  },
  {
    name: 'get_store',
    description: 'Affiche le magasin actuellement sélectionné. Lecture seule.',
    permission: 'read',
    inputSchema: { required: [], properties: {} },
  },
  {
    name: 'add_to_cart',
    description:
      'Ajoute un produit au panier. product_id DOIT venir de search_products (jamais du modèle). Mutation : confirmation utilisateur obligatoire.',
    permission: 'mutation',
    inputSchema: {
      required: ['product_id', 'quantity'],
      properties: { product_id: { type: 'string' }, quantity: { type: 'integer' } },
    },
  },
  {
    name: 'update_quantity',
    description:
      'Définit la quantité absolue d\'une ligne (0 = retire). Mutation : confirmation obligatoire.',
    permission: 'mutation',
    inputSchema: {
      required: ['product_id', 'quantity'],
      properties: { product_id: { type: 'string' }, quantity: { type: 'integer' } },
    },
  },
  {
    name: 'remove_from_cart',
    description: 'Retire une ligne du panier. Mutation : confirmation obligatoire.',
    permission: 'mutation',
    inputSchema: { required: ['product_id'], properties: { product_id: { type: 'string' } } },
  },
];

export const READ_TOOL_NAMES = new Set(READ_COMMANDS);
export const MUTATION_TOOL_NAMES = new Set(MUTATION_COMMANDS);

export function findTool(name: string): ToolSchema | undefined {
  return TOOL_SCHEMAS.find((t) => t.name === name);
}

/** Valide les args contre le schéma simplifié (présence + types de base). */
export function validateAgainstSchema(
  name: string,
  args: Record<string, unknown> | null | undefined,
): { ok: true } | { ok: false; error: string } {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `Outil inconnu : ${name}` };
  const a = args ?? {};
  for (const req of tool.inputSchema.required) {
    if (a[req] === undefined || a[req] === null || a[req] === '') {
      return { ok: false, error: `${name}: '${req}' requis.` };
    }
  }
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    const v = a[key];
    if (v === undefined) continue;
    if (schema.type === 'string' && typeof v !== 'string')
      return { ok: false, error: `${name}: '${key}' doit être une chaîne.` };
    if (schema.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v)))
      return { ok: false, error: `${name}: '${key}' doit être un entier.` };
  }
  return { ok: true };
}
