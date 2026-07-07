/**
 * Historique des produits ajoutés en session (pour annulation).
 *
 * Garde la trace des productId ajoutés via mutation confirmée afin de
 * proposer un rollback (remove_from_cart) si la session le permet. Purement
 * in-memory pour le MVP — aucune persistance inter-sessions.
 */

import type { LeclercCommandName } from './types';

export interface HistoryEntry {
  id: string;
  at: number;
  command: LeclercCommandName;
  productId: string;
  quantity: number;
  label?: string;
  confirmed: boolean;
  /** Annulé (rollback effectué) ? */
  reverted?: boolean;
}

export class SessionHistory {
  private readonly entries: HistoryEntry[] = [];
  private seq = 0;

  add(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const full: HistoryEntry = { id: `hist-${this.seq++}`, ...entry };
    this.entries.push(full);
    return full;
  }

  markReverted(id: string): boolean {
    const e = this.entries.find((x) => x.id === id);
    if (e) e.reverted = true;
    return !!e;
  }

  /** Produits ajoutés non annulés, pour l'écran Historique. */
  activeAdds(): HistoryEntry[] {
    return this.entries.filter(
      (e) => e.command === 'add_to_cart' && e.confirmed && !e.reverted,
    );
  }

  all(): HistoryEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries.length = 0;
    this.seq = 0;
  }
}