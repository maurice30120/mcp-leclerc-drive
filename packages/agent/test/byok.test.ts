import { describe, expect, it } from "vitest";
import { InMemorySecretStore, type SecretStore } from "../src/index.js";

describe("BYOK secret store", () => {
  it("stores, reads and deletes an API key by stable name", async () => {
    const store: SecretStore = new InMemorySecretStore();
    await store.set("mistral-api-key", "sk-SECRET-123");
    expect(await store.get("mistral-api-key")).toBe("sk-SECRET-123");
    await store.delete("mistral-api-key");
    expect(await store.get("mistral-api-key")).toBeUndefined();
  });

  it("returns undefined for an unknown key without throwing", async () => {
    const store = new InMemorySecretStore();
    await expect(store.get("inconnu")).resolves.toBeUndefined();
  });

  it("tolerates deleting a key that does not exist", async () => {
    const store = new InMemorySecretStore();
    await expect(store.delete("inconnu")).resolves.toBeUndefined();
    expect(await store.get("inconnu")).toBeUndefined();
  });

  it("keeps keys isolated per store instance (never a shared global)", async () => {
    const a = new InMemorySecretStore();
    const b = new InMemorySecretStore();
    await a.set("mistral-api-key", "sk-A");
    expect(await b.get("mistral-api-key")).toBeUndefined();
  });
});
