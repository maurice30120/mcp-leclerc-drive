/**
 * Mistral BYOK provider (spec issue #48).
 *
 * Talks to the Mistral chat-completions API with a user-provided API key
 * (bring your own key). The provider id is "mistral-byok".
 *
 * Selection is EXPLICIT ONLY: this module exports a factory and nothing else.
 * No code path constructs or calls the provider implicitly, and a failure here
 * never triggers a fallback to another provider — the orchestrator decides.
 *
 * Key hygiene: the API key is kept in a closure, never logged, and redacted
 * from every error text this provider produces (401, 429, network failure,
 * unexpected status, unreadable payloads).
 *
 * The injected `fetchImpl` keeps the module pure and tests fully offline.
 */

import type {
  GenerateRequest,
  GenerateResponse,
  GenerateUsage,
  ModelCapabilities,
  ModelProvider,
  ProviderMessage,
  ProviderToolSpec,
  ToolCallRequest,
} from "../provider.js";

/** Minimal structural response expected from `fetchImpl` (no DOM dependency). */
export interface MistralFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface MistralFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** Injectable fetch — the real `fetch` is wired by the caller (Chrome or Node). */
export type MistralFetch = (url: string, init: MistralFetchInit) => Promise<MistralFetchResponse>;

export interface MistralByokProviderOptions {
  /** User-provided API key — never logged, never in error messages. */
  apiKey: string;
  /** Mistral model id, e.g. "mistral-small-latest". */
  model: string;
  /** Network seam, injected — no global fetch reference at module scope. */
  fetchImpl: MistralFetch;
  /** Optional base URL override (default https://api.mistral.ai). */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.mistral.ai";

/** Placeholder substituted for the API key in any redacted text. */
const REDACTED = "[clé masquée]";

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MistralToolCallPayload {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface MistralChoicePayload {
  message?: {
    content?: string | null;
    tool_calls?: MistralToolCallPayload[];
  };
  finish_reason?: string;
}

interface MistralResponsePayload {
  choices?: MistralChoicePayload[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class MistralByokProvider implements ModelProvider {
  readonly id = "mistral-byok";
  readonly modelVersion: string;
  readonly capabilities: ModelCapabilities = { toolCalling: true, streaming: false };

  /** Number of generate() calls served — asserted by safety scenarios. */
  calls = 0;

  constructor(private readonly options: MistralByokProviderOptions) {
    this.modelVersion = options.model;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    if (request.signal?.aborted) {
      return { finishReason: "cancelled" };
    }
    this.calls++;

    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/chat/completions`;
    const requestBody = JSON.stringify(this.buildRequestBody(request));
    let response: MistralFetchResponse;
    try {
      response = await this.options.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      return this.failure(`Échec réseau lors de l'appel à Mistral : ${describeError(error)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return this.failure(`Réponse Mistral illisible : ${describeError(error)}`);
    }
    if (!response.ok) {
      return this.httpFailure(response.status, body);
    }
    return this.parseSuccess(body);
  }

  private buildRequestBody(request: GenerateRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: request.messages.map((message) => this.mapMessage(message)),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool: ProviderToolSpec) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.seed !== undefined) body.random_seed = request.seed;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    return body;
  }

  private mapMessage(message: ProviderMessage): Record<string, unknown> {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call: ToolCallRequest) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      };
    }
    return { role: message.role, content: message.content };
  }

  private httpFailure(status: number, body: unknown): GenerateResponse {
    const detail = body === undefined ? "" : ` ${redact(JSON.stringify(body), this.options.apiKey)}`;
    if (status === 401) {
      return this.failure(
        `Mistral a refusé la clé API (HTTP 401) : clé absente, invalide ou expirée.${detail}`,
      );
    }
    if (status === 429) {
      return this.failure(`Quota ou limite de débit Mistral dépassé (HTTP 429).${detail}`);
    }
    return this.failure(`Erreur HTTP ${status} lors de l'appel à Mistral.${detail}`);
  }

  private parseSuccess(body: unknown): GenerateResponse {
    const payload = (body ?? {}) as MistralResponsePayload;
    const choice = payload.choices?.[0];
    const message = choice?.message;
    const toolCalls = this.parseToolCalls(message?.tool_calls);
    if (toolCalls === undefined) {
      return this.failure("Tool calls Mistral illisibles : arguments invalides.");
    }
    const usage: GenerateUsage | undefined = payload.usage
      ? {
          ...(payload.usage.prompt_tokens !== undefined
            ? { promptTokens: payload.usage.prompt_tokens }
            : {}),
          ...(payload.usage.completion_tokens !== undefined
            ? { completionTokens: payload.usage.completion_tokens }
            : {}),
        }
      : undefined;
    const text = typeof message?.content === "string" ? message.content : undefined;
    const finishReason =
      toolCalls.length > 0
        ? "tool_calls"
        : choice?.finish_reason === "length"
          ? "length"
          : "stop";
    return {
      ...(text !== undefined ? { text } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason,
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /** Returns parsed tool calls, or undefined when a payload is unreadable. */
  private parseToolCalls(payloads: MistralToolCallPayload[] | undefined): ToolCallRequest[] | undefined {
    if (!payloads || payloads.length === 0) {
      return [];
    }
    const calls: ToolCallRequest[] = [];
    for (const payload of payloads) {
      if (!payload.id || !payload.function?.name) {
        return undefined;
      }
      try {
        calls.push({
          id: payload.id,
          name: payload.function.name,
          input: JSON.parse(payload.function.arguments ?? "null"),
        });
      } catch {
        return undefined;
      }
    }
    return calls;
  }

  /** Error response with the API key redacted from the message. */
  private failure(message: string): GenerateResponse {
    return { finishReason: "error", text: redact(message, this.options.apiKey) };
  }
}

export function createMistralByokProvider(options: MistralByokProviderOptions): ModelProvider {
  return new MistralByokProvider(options);
}
