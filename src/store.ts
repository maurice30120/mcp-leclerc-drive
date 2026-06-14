/**
 * Active store selection, with cross-session persistence.
 *
 * The store the tools operate on can be chosen at runtime (set_store) instead of
 * being fixed by env vars. The choice is persisted to
 * `~/.mcp-leclerc-drive/config.json` so it survives restarts. Resolution order:
 * persisted file → env/defaults (LeclercConfig).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { LeclercConfig } from "./config.js";

export interface StoreSelection {
  /** Canonical store number (noPL), e.g. "053701". Used in URLs and payloads. */
  storeId: string;
  /** Retrieval point (noPR); equals storeId for drives, differs for piéton relays. */
  noPR: string;
  /** Backend host, e.g. "fd9-courses.leclercdrive.fr" (the fdN prefix varies). */
  host: string;
  /** Human-readable name, e.g. "Rezé Atout Sud" (optional, for display). */
  name?: string;
}

const CONFIG_DIR = join(homedir(), ".mcp-leclerc-drive");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export class StoreState {
  private selection: StoreSelection;

  constructor(config: LeclercConfig) {
    const fallback: StoreSelection = {
      storeId: config.storeId,
      noPR: config.storeId,
      host: config.host,
    };
    this.selection = readPersisted() ?? fallback;
  }

  current(): StoreSelection {
    return this.selection;
  }

  set(selection: StoreSelection): void {
    this.selection = selection;
    writePersisted(selection);
  }

  /** Path of the persisted config file, for user-facing messages. */
  get configPath(): string {
    return CONFIG_FILE;
  }
}

function readPersisted(): StoreSelection | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    const o = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (o && typeof o.storeId === "string" && typeof o.host === "string") {
      return {
        storeId: o.storeId,
        noPR: typeof o.noPR === "string" ? o.noPR : o.storeId,
        host: o.host,
        name: typeof o.name === "string" ? o.name : undefined,
      };
    }
  } catch {
    /* ignore corrupt/unreadable config — fall back to defaults */
  }
  return null;
}

function writePersisted(selection: StoreSelection): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(selection, null, 2) + "\n", "utf8");
}
