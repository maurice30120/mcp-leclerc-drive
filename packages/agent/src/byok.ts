/**
 * BYOK secret storage (spec issue #48).
 *
 * Bring-your-own-key secrets (the Mistral API key) never live in Git, snapshots
 * or reports. They are stored behind this minimal seam so the rest of the
 * agent stays storage-agnostic.
 *
 * Chrome wiring (persisting the key in `chrome.storage.local` — never
 * `chrome.storage.sync`, never synced to the user's account) belongs to
 * ticket #51: this module must stay environment-free so the agent package
 * keeps running unchanged in Chrome and Node.
 */

/** Minimal secret storage seam — get/set/delete by stable key name. */
export interface SecretStore {
  /** Returns the secret stored under `key`, or undefined if absent. */
  get(key: string): Promise<string | undefined>;
  /** Stores (or overwrites) the secret stored under `key`. */
  set(key: string, value: string): Promise<void>;
  /** Removes the secret stored under `key`; no-op if absent. */
  delete(key: string): Promise<void>;
}

/** In-memory SecretStore — tests, Node harness, and the default for #51 wiring. */
export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.secrets.delete(key);
  }
}
