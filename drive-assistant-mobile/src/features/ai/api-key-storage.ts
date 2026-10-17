import { MISTRAL_API_KEY } from './env.generated.ts';

export const MISTRAL_API_KEY_STORAGE_KEY = 'mistral.apiKey';

export interface SecureKeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  isAvailableAsync?(): Promise<boolean>;
}

export function normalizeMistralApiKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key ? key : null;
}

export function envMistralApiKey(): string | null {
  return normalizeMistralApiKey(MISTRAL_API_KEY);
}

export async function getStoredMistralApiKey(store = loadSecureStore): Promise<string | null> {
  const secureStore = await store();
  const available = await secureStore.isAvailableAsync?.();
  if (available === false) {
    throw new Error('SecureStore indisponible sur cet appareil.');
  }
  return normalizeMistralApiKey(await secureStore.getItemAsync(MISTRAL_API_KEY_STORAGE_KEY));
}

export async function saveMistralApiKey(
  apiKey: string,
  store = loadSecureStore,
): Promise<string> {
  const normalized = normalizeMistralApiKey(apiKey);
  if (!normalized) throw new Error('Clé Mistral vide.');
  const secureStore = await store();
  const available = await secureStore.isAvailableAsync?.();
  if (available === false) {
    throw new Error('SecureStore indisponible sur cet appareil.');
  }
  await secureStore.setItemAsync(MISTRAL_API_KEY_STORAGE_KEY, normalized);
  return normalized;
}

export async function deleteMistralApiKey(store = loadSecureStore): Promise<void> {
  const secureStore = await store();
  await secureStore.deleteItemAsync(MISTRAL_API_KEY_STORAGE_KEY);
}

export async function getConfiguredMistralApiKey(store = loadSecureStore): Promise<string | null> {
  const stored = await getStoredMistralApiKey(store);
  if (stored) return stored;
  return envMistralApiKey();
}

export async function bootstrapMistralApiKeyFromEnv(store = loadSecureStore): Promise<string | null> {
  const stored = await getStoredMistralApiKey(store);
  if (stored) return stored;
  const fromEnv = envMistralApiKey();
  if (!fromEnv) return null;
  await saveMistralApiKey(fromEnv, store);
  return fromEnv;
}

async function loadSecureStore(): Promise<SecureKeyValueStore> {
  const Keychain = await import('react-native-keychain');
  return {
    async getItemAsync(key: string): Promise<string | null> {
      const credentials = await Keychain.getGenericPassword({ service: key });
      return credentials ? credentials.password : null;
    },
    async setItemAsync(key: string, value: string): Promise<void> {
      const result = await Keychain.setGenericPassword('mistral', value, { service: key });
      if (!result) throw new Error('Stockage sécurisé indisponible sur cet appareil.');
    },
    async deleteItemAsync(key: string): Promise<void> {
      await Keychain.resetGenericPassword({ service: key });
    },
  };
}
