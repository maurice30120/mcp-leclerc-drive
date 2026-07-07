import { test, assert } from './helpers.ts';
import {
  bootstrapMistralApiKeyFromEnv,
  deleteMistralApiKey,
  getStoredMistralApiKey,
  normalizeMistralApiKey,
  saveMistralApiKey,
  type SecureKeyValueStore,
} from '../src/features/ai/api-key-storage.ts';

test('Mistral API key storage : normalise et stocke dans SecureStore', async () => {
  const store = new MemorySecureStore();

  assert.equal(normalizeMistralApiKey('  abc  '), 'abc');
  assert.equal(normalizeMistralApiKey('   '), null);

  await saveMistralApiKey('  test-key  ', () => Promise.resolve(store));
  assert.equal(await getStoredMistralApiKey(() => Promise.resolve(store)), 'test-key');

  await deleteMistralApiKey(() => Promise.resolve(store));
  assert.equal(await getStoredMistralApiKey(() => Promise.resolve(store)), null);
});

test('Mistral API key storage : bootstrap .env vers SecureStore si vide', async () => {
  const store = new MemorySecureStore();

  const key = await bootstrapMistralApiKeyFromEnv(() => Promise.resolve(store));

  assert.ok(key);
  assert.equal(await getStoredMistralApiKey(() => Promise.resolve(store)), key);
});

class MemorySecureStore implements SecureKeyValueStore {
  private readonly values = new Map<string, string>();

  async getItemAsync(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }

  async isAvailableAsync(): Promise<boolean> {
    return true;
  }
}
