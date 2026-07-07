import { Mistral } from '@mistralai/mistralai';
import { SDKHooks } from '@mistralai/mistralai/hooks/hooks';
import { ensureMistralReactNativeCompatibility } from './react-native-polyfills.ts';
import type { ChatMessage } from './prompt';

export interface MistralClientConfig {
  apiKey: string;
  model: string;
  serverURL?: string;
  maxTokens?: number;
  temperature?: number;
  sdk?: MistralSdk;
  sdkFactory?: MistralSdkFactory;
}

interface MistralSdkOptions {
  apiKey: string;
  serverURL?: string;
  hooks?: SDKHooks;
}

export type MistralRole = 'system' | 'user' | 'assistant' | 'tool';

export type MistralConversationMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string | null; toolCalls?: MistralToolCall[] | null }
  | { role: 'tool'; content: string; name?: string | null; toolCallId?: string | null };

export interface MistralToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface MistralToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
  index?: number;
}

export interface MistralChatRequest {
  messages: MistralConversationMessage[];
  responseFormat?: 'json_object' | 'text';
  tools?: MistralToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'any' | 'required';
}

export interface MistralChatTurn {
  text: string;
  raw: string;
  message: {
    content?: unknown;
    toolCalls?: MistralToolCall[] | null;
  };
  toolCalls: MistralToolCall[];
}

interface MistralMessage {
  content?: unknown;
  toolCalls?: MistralToolCall[] | null;
}

interface MistralChatCompletion {
  choices?: Array<{
    message?: MistralMessage;
  }>;
}

export class MistralChatClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly serverURL?: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sdk: MistralSdk;

  constructor(config: MistralClientConfig) {
    ensureMistralReactNativeCompatibility();
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.serverURL = config.serverURL;
    this.maxTokens = config.maxTokens ?? 192;
    this.temperature = config.temperature ?? 0;
    this.sdk =
      config.sdk ??
      (config.sdkFactory ?? defaultMistralSdkFactory)({
        apiKey: this.apiKey,
        serverURL: this.serverURL,
        hooks: createReactNativeRequestHooks(),
      });
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const turn = await this.completeChat({
      messages,
      responseFormat: 'json_object',
    });
    return turn.text;
  }

  async completeChat(request: MistralChatRequest): Promise<MistralChatTurn> {
    if (!this.apiKey.trim()) {
      throw new Error('Mistral API : clé manquante.');
    }

    try {
      const result = await this.sdk.chat.complete({
        model: this.model,
        messages: request.messages,
        maxTokens: this.maxTokens,
        temperature: this.temperature,
        ...(request.responseFormat === 'json_object' ? { responseFormat: { type: 'json_object' } as const } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
        stream: false,
      });
      const message = result.choices?.[0]?.message ?? {};
      const text = extractMistralContent(result, { allowEmpty: (message.toolCalls?.length ?? 0) > 0 });
      return {
        text,
        raw: safeRawJson(result),
        message,
        toolCalls: message.toolCalls ?? [],
      };
    } catch (e) {
      const message = (e as Error).message || 'erreur inconnue';
      throw new Error(message.startsWith('Mistral API :') ? message : `Mistral API : ${message}`);
    }
  }
}

export interface MistralSdk {
  chat: {
    complete(request: {
      model: string;
      messages: MistralConversationMessage[];
      maxTokens: number;
      temperature: number;
      responseFormat?: { type: 'json_object' };
      tools?: MistralToolDefinition[];
      toolChoice?: 'auto' | 'none' | 'any' | 'required';
      stream: false;
    }): Promise<MistralChatCompletion>;
  };
}

export type MistralSdkFactory = (config: {
  apiKey: string;
  serverURL?: string;
  hooks?: SDKHooks;
}) => MistralSdk;

function defaultMistralSdkFactory(config: MistralSdkOptions): MistralSdk {
  return new Mistral({
    apiKey: config.apiKey,
    ...(config.serverURL ? { serverURL: config.serverURL } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
  } as unknown as ConstructorParameters<typeof Mistral>[0]) as MistralSdk;
}

function createReactNativeRequestHooks(): SDKHooks {
  const hooks = new SDKHooks();
  hooks.registerSDKInitHook({
    sdkInit: (opts) => ({
      ...opts,
      // React Native's URL polyfill expects the first constructor argument to
      // already be a string. The SDK stores this value and later calls
      // `new URL(baseURL)`, so keeping a URL object here triggers
      // `this._url.includes is not a function`.
      baseURL: opts.baseURL?.toString() as unknown as URL,
    }),
  });
  hooks.registerBeforeCreateRequestHook({
    beforeCreateRequest: (_ctx, input) => ({
      ...input,
      // React Native's Request polyfill expects a string URL and calls
      // `.includes` on it. The SDK passes a URL object by default.
      url: input.url.toString() as unknown as URL,
    }),
  });
  return hooks;
}

function extractMistralContent(
  result: MistralChatCompletion,
  options: { allowEmpty?: boolean } = {},
): string {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
    if (text) return text;
  }
  if (options.allowEmpty) return '';
  throw new Error('Mistral API : contenu de réponse vide.');
}

function safeRawJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
