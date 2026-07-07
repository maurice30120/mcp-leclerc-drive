/**
 * Runtime IA distant via API Mistral.
 *
 * Le runtime renvoie toujours le texte brut du modèle. La sécurité reste dans
 * plan.ts et AssistantViewModel : aucun product_id ne vient du modèle, et la
 * WebView Leclerc n'est jamais accessible depuis cette couche.
 */

import type { ChatMessage } from './prompt';
import type { MistralChatRequest, MistralChatTurn } from './mistral-client';

export interface CompletionClient {
  complete(messages: ChatMessage[]): Promise<string>;
  completeChat?(request: MistralChatRequest): Promise<MistralChatTurn>;
  release?(): Promise<void>;
}

export type RuntimeStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RuntimeState {
  status: RuntimeStatus;
  provider?: 'mistral';
  modelId?: string;
  error?: string;
}

export interface RuntimeIdentity {
  provider: 'mistral';
  modelId: string;
}

export class AIRuntime {
  private state: RuntimeState = { status: 'idle' };
  private ready = false;
  private readonly client: CompletionClient;
  private readonly identity: RuntimeIdentity;

  constructor(client: CompletionClient, identity: RuntimeIdentity) {
    this.client = client;
    this.identity = identity;
  }

  getState(): RuntimeState {
    return { ...this.state };
  }

  async load(): Promise<void> {
    this.state = { status: 'loading', provider: this.identity.provider, modelId: this.identity.modelId };
    try {
      this.ready = true;
      this.state = { status: 'ready', provider: this.identity.provider, modelId: this.identity.modelId };
    } catch (e) {
      this.ready = false;
      this.state = {
        status: 'error',
        provider: this.identity.provider,
        modelId: this.identity.modelId,
        error: (e as Error).message,
      };
      throw e;
    }
  }

  isReady(): boolean {
    return this.state.status === 'ready' && this.ready;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    if (!this.isReady()) throw new Error('Runtime IA : API Mistral non initialisée.');
    return this.client.complete(messages);
  }

  async completeChat(request: MistralChatRequest): Promise<MistralChatTurn> {
    if (!this.isReady()) throw new Error('Runtime IA : API Mistral non initialisée.');
    if (!this.client.completeChat) {
      throw new Error('Runtime IA : le client ne supporte pas les appels outils.');
    }
    return this.client.completeChat(request);
  }

  async release(): Promise<void> {
    await this.client.release?.();
    this.ready = false;
    this.state = { status: 'idle' };
  }
}
