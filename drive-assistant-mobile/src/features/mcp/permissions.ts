/**
 * Permissions read/mutation du runtime MCP interne.
 *
 * Politique : aucune mutation n'est exécutée sans confirmation utilisateur
 * explicite (`confirm`). Les reads passent sans confirmation mais restent
 * journalisés. La confirmation est un jeton à usage unique (nonce) pour
 * éviter qu'une mutation différée/ne réutilisée sans nouveau clic.
 */

export interface MutationTicket {
  nonce: string;
  command: string;
  /** Empreinte générique de l'appel validé (args canoniques). */
  fingerprint: string;
  issuedAt: number;
  /** Consommé une fois exécuté (anti-rejeu). */
  consumed: boolean;
}

export interface PermissionGate {
  /** Émet un ticket pour une mutation validée (clic Valider). */
  issue(command: string, args: Record<string, unknown>): MutationTicket;
  /** Vérifie + consomme le ticket pour une mutation. */
  verify(nonce: string, command: string, args: Record<string, unknown>): boolean;
  hasPending(command: string): boolean;
  clear(): void;
}

function fingerprint(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join('|');
}

export class InMemoryPermissionGate implements PermissionGate {
  private readonly tickets = new Map<string, MutationTicket>();

  issue(command: string, args: Record<string, unknown>): MutationTicket {
    const nonce = `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ticket: MutationTicket = {
      nonce,
      command,
      fingerprint: fingerprint(args),
      issuedAt: Date.now(),
      consumed: false,
    };
    this.tickets.set(nonce, ticket);
    return ticket;
  }

  verify(nonce: string, command: string, args: Record<string, unknown>): boolean {
    const t = this.tickets.get(nonce);
    if (!t) return false;
    if (t.consumed) return false;
    if (t.command !== command) return false;
    if (t.fingerprint !== fingerprint(args)) return false;
    t.consumed = true;
    return true;
  }

  hasPending(command: string): boolean {
    for (const t of this.tickets.values()) {
      if (t.command === command && !t.consumed) return true;
    }
    return false;
  }

  clear(): void {
    this.tickets.clear();
  }
}