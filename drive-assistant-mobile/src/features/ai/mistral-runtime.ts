import {
  MISTRAL_API_BASE_URL,
  MISTRAL_MODEL,
} from './env.generated';
import { bootstrapMistralApiKeyFromEnv } from './api-key-storage';
import { MistralChatClient } from './mistral-client';
import { AIRuntime, type RuntimeState } from './runtime';

export async function createMistralRuntime(
  setState: (s: RuntimeState) => void,
): Promise<AIRuntime> {
  setState({ status: 'loading', provider: 'mistral', modelId: MISTRAL_MODEL });
  const apiKey = await bootstrapMistralApiKeyFromEnv();
  if (!apiKey) {
    throw new Error('Mistral API : clé manquante. Ajoute-la dans Réglages.');
  }

  const runtime = new AIRuntime(
    new MistralChatClient({
      apiKey,
      model: MISTRAL_MODEL,
      serverURL: MISTRAL_API_BASE_URL,
      maxTokens: 192,
      temperature: 0,
    }),
    {
      provider: 'mistral',
      modelId: MISTRAL_MODEL,
    },
  );

  await runtime.load();
  setState(runtime.getState());
  return runtime;
}
