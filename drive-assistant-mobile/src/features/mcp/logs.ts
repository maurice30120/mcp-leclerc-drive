/**
 * Journal des actions MCP internes (logs structurés). Source de l'écran
 * Historique. Append-only, borné (ring buffer) pour rester léger sur mobile.
 */

import type { LeclercCommandName, Permission } from './types';

export interface McpLogEntry {
  id: string;
  at: number;
  command: LeclercCommandName | string;
  permission: Permission;
  status: 'ok' | 'error' | 'blocked' | 'pending';
  args?: Record<string, unknown>;
  text?: string;
  error?: string;
  /** Nonce du ticket de confirmation pour les mutations. */
  nonce?: string;
}

export class McpLogger {
  private readonly entries: McpLogEntry[] = [];
  private cursor = 0;
  private seq = 0;
  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  log(entry: Omit<McpLogEntry, 'id'>): McpLogEntry {
    const id = `mcp-${this.seq++}`;
    const full: McpLogEntry = { id, ...entry };
    if (this.entries.length < this.capacity) {
      this.entries.push(full);
    } else {
      this.entries[this.cursor] = full;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    return full;
  }

  update(id: string, patch: Partial<McpLogEntry>): McpLogEntry | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    return e;
  }

  all(): McpLogEntry[] {
    // Renvoie dans l'ordre chronologique (ring buffer).
    if (this.entries.length < this.capacity) return [...this.entries].reverse();
    return [...this.entries.slice(this.cursor), ...this.entries.slice(0, this.cursor)].reverse();
  }

  mutations(): McpLogEntry[] {
    return this.all().filter((e) => e.permission === 'mutation');
  }

  clear(): void {
    this.entries.length = 0;
    this.cursor = 0;
    this.seq = 0;
  }
}
