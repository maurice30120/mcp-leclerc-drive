/**
 * Bring Your Own Key (BYOK) — remote inference providers for the shopping-list
 * orchestrator.
 *
 * Instead of downloading the local Transformers.js model (~0.6–1 GB), the user
 * can plug an OpenAI-compatible chat-completions API:
 *   - **openai** — their own OpenAI key;
 *   - **vibe** — their Mistral API key (La Plateforme), included in their
 *     Vibe subscription.
 *
 * Both speak the same wire format (`POST {base}/chat/completions`, Bearer
 * auth), so a single request builder covers them. This module stays pure and
 * fetch-free — like the rest of the orchestrator seam, the HTTP call lives in
 * the extension background worker and this code is unit-testable in Node.
 *
 * SECURITY: the API key must never appear in logs, debug payloads or error
 * messages. `scrubApiKey` exists for exactly that; every error path in the
 * caller must pass user-visible text through it.
 */

import type { ChatMessage } from "./prompt.js";

export type ByokProviderId = "openai" | "vibe";

export interface ByokProvider {
  /** Stable storage/config id. */
  id: ByokProviderId;
  /** Short label for the picker. */
  label: string;
  /** OpenAI-compatible API base, without trailing slash. */
  baseUrl: string;
  /** Model used when the user leaves the model field empty. */
  defaultModel: string;
  /** Model suggested in the UI placeholder. */
  modelHint: string;
  /** Where the user finds the key (help text). */
  keyHelp: string;
}

/** Ordered as displayed in the picker (local model is handled separately). */
export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  {
    id: "openai",
    label: "OpenAI (clé perso)",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    modelHint: "gpt-4o-mini",
    keyHelp: "Clé sk-… depuis platform.openai.com/api-keys",
  },
  {
    id: "vibe",
    label: "Vibe / Mistral (inclus dans le forfait)",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    modelHint: "mistral-small-latest",
    keyHelp: "Clé La Plateforme incluse dans ton forfait Vibe",
  },
] as const;

export const BYOK_MAX_TOKENS = 512;

/** A ready-to-run BYOK configuration resolved from storage. */
export interface ByokConfig {
  provider: ByokProvider;
  /** Trimmed, non-empty API key. Never logged. */
  apiKey: string;
  /** Concrete model id (default applied). */
  model: string;
}

export interface ByokRequest {
  /** Absolute chat-completions endpoint. */
  url: string;
  /** Headers including the Bearer authorization. */
  headers: Record<string, string>;
  /** Serialized JSON body. The API key is NEVER in the body. */
  body: string;
}

export function findByokProvider(
  id: string | undefined | null,
): ByokProvider | null {
  if (!id) return null;
  return BYOK_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Resolve a validated {@link ByokConfig} from raw storage values.
 * Returns an error string (never throws) when the combination is unusable,
 * so the caller can surface it in the UI instead of silently falling back.
 */
export function resolveByokConfig(
  providerId: string | undefined | null,
  apiKey: string | undefined | null,
  model: string | undefined | null,
): { ok: true; config: ByokConfig } | { ok: false; error: string } {
  const provider = findByokProvider(providerId);
  if (!provider) {
    return { ok: false, error: `Fournisseur BYOK inconnu : ${providerId}` };
  }
  const key = (apiKey ?? "").trim();
  if (!key) {
    return { ok: false, error: `Clé API manquante pour ${provider.label}.` };
  }
  const resolvedModel = (model ?? "").trim() || provider.defaultModel;
  return { ok: true, config: { provider, apiKey: key, model: resolvedModel } };
}

/**
 * Build the OpenAI-compatible chat-completions request for a provider.
 * The key travels only in the Authorization header — never in the body, which
 * is the part most likely to end up in a debug dump.
 */
export function buildChatCompletionRequest(
  config: ByokConfig,
  messages: readonly ChatMessage[],
): ByokRequest {
  return {
    url: `${config.provider.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: BYOK_MAX_TOKENS,
    }),
  };
}

/**
 * Extract the assistant text from an OpenAI-compatible chat-completions
 * response. Tolerates tool-call/message variants by always reading
 * `choices[0].message.content`.
 */
export function extractAssistantText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/**
 * Extract a human-readable error message from a chat-completions error body
 * (`{ error: { message } }` on OpenAI/Mistral), falling back to a generic text.
 */
export function extractApiErrorMessage(
  json: unknown,
  status: number,
): string {
  if (typeof json === "object" && json !== null) {
    const err = (json as { error?: unknown }).error;
    if (typeof err === "object" && err !== null) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof err === "string" && err.trim()) return err;
  }
  return `Erreur HTTP ${status} de l'API du fournisseur.`;
}

/**
 * Remove any occurrence of the API key from a text (error messages, debug
 * payloads) before it is shown or logged. Also masks Bearer tokens wholesale
 * in case the key was echoed back in a URL or header dump.
 */
export function scrubApiKey(text: string, apiKey: string): string {
  const key = apiKey.trim();
  let out = text;
  if (key) out = out.split(key).join("«clé masquée»");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer «clé masquée»");
}
