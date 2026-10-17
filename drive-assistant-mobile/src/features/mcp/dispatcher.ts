/**
 * Dispatcher de commandes — validation + coercition du vocabulaire Leclerc.
 *
 * Port isolé de mcp-leclerc-drive (src/orchestrator/dispatcher.ts).
 * Rejette : commande inconnue, mutation sur host non-Leclerc, args invalides.
 * Classe lecture vs mutation en première classe pour que le runtime MCP puisse
 * refuser toute mutation sans confirmation utilisateur explicite.
 */

import { isLeclercHost } from '../leclerc/api.ts';
import {
  isMutationCommand,
  isReadCommand,
  type DispatchCall,
  type MutationCall,
  type ReadCall,
} from './types.ts';

export interface ValidateOk {
  ok: true;
  call: DispatchCall;
}
export interface ValidateErr {
  ok: false;
  error: string;
}
export type ValidateResult = ValidateOk | ValidateErr;

export function isMutationCall(call: DispatchCall): boolean {
  return (
    call.command === 'add_to_cart' ||
    call.command === 'update_quantity' ||
    call.command === 'remove_from_cart'
  );
}
export function isReadCall(call: DispatchCall): boolean {
  return !isMutationCall(call);
}

export function validateCommand(
  command: string,
  args: Record<string, unknown> | null | undefined,
  host?: string,
): ValidateResult {
  if (!isReadCommand(command) && !isMutationCommand(command)) {
    return { ok: false, error: `Commande inconnue : ${command}` };
  }
  const a = args ?? {};

  if (command === 'search_products') {
    const query = strField(a, 'query');
    if (query === null) return { ok: false, error: "search_products: 'query' requis (chaîne)." };
    const trimmed = query.trim();
    if (!trimmed) return { ok: false, error: "search_products: 'query' vide." };
    return { ok: true, call: { command: 'search_products', query: trimmed } };
  }
  if (command === 'get_cart') return { ok: true, call: { command: 'get_cart' } };
  if (command === 'get_store') return { ok: true, call: { command: 'get_store' } };

  if (isMutationCommand(command)) {
    if (host !== undefined && !isLeclercHost(host)) {
      return { ok: false, error: `Host refusé (non-Leclerc) : ${host}` };
    }
    const productId = strictStr(a, 'product_id');
    if (productId === null) {
      return { ok: false, error: `${command}: 'product_id' requis (chaîne).` };
    }
    if (command === 'remove_from_cart') {
      return { ok: true, call: { command: 'remove_from_cart', productId } };
    }
    const qty = intField(a, 'quantity');
    if (qty === null) {
      return { ok: false, error: `${command}: 'quantity' requis (entier).` };
    }
    if (command === 'add_to_cart') {
      if (qty < 1) return { ok: false, error: "add_to_cart: 'quantity' doit être ≥ 1." };
      return { ok: true, call: { command: 'add_to_cart', productId, quantity: qty } };
    }
    if (qty < 0) return { ok: false, error: "update_quantity: 'quantity' doit être ≥ 0." };
    return { ok: true, call: { command: 'update_quantity', productId, quantity: qty } };
  }

  return { ok: false, error: `Commande non gérée : ${command}` };
}

export function callName(call: DispatchCall): string {
  return call.command;
}

function strField(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
function strictStr(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  if (typeof v === 'string') return v.trim() ? v : null;
  return null;
}
function intField(a: Record<string, unknown>, key: string): number | null {
  const v = a[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    if (Number.isInteger(n)) return n;
  }
  return null;
}

export type { DispatchCall, MutationCall, ReadCall };
