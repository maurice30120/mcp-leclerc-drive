import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BYOK_MAX_TOKENS,
  BYOK_PROVIDERS,
  buildChatCompletionRequest,
  extractApiErrorMessage,
  extractAssistantText,
  findByokProvider,
  resolveByokConfig,
  scrubApiKey,
} from "../src/orchestrator/byok.ts";
import { buildMessages } from "../src/orchestrator/prompt.ts";

const OPENAI = findByokProvider("openai");
const VIBE = findByokProvider("vibe");

test("byok catalogue exposes openai and vibe (mistral) endpoints", () => {
  assert.ok(OPENAI && VIBE);
  assert.equal(OPENAI.baseUrl, "https://api.openai.com/v1");
  assert.equal(VIBE.baseUrl, "https://api.mistral.ai/v1");
  assert.ok(OPENAI.defaultModel.length > 0);
  assert.ok(VIBE.defaultModel.length > 0);
  const ids = new Set(BYOK_PROVIDERS.map((p) => p.id));
  assert.equal(ids.size, BYOK_PROVIDERS.length);
});

test("findByokProvider returns null for unknown or missing ids", () => {
  assert.equal(findByokProvider(null), null);
  assert.equal(findByokProvider("anthropic"), null);
});

test("resolveByokConfig applies defaults and rejects unusable input", () => {
  const r = resolveByokConfig("openai", "  sk-test  ", "  ");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.apiKey, "sk-test");
    assert.equal(r.config.model, OPENAI?.defaultModel);
  }

  assert.equal(resolveByokConfig("openai", "  ", null).ok, false);
  assert.equal(resolveByokConfig("nobody", "sk-test", null).ok, false);
});

test("buildChatCompletionRequest never leaks the key in the body", () => {
  const r = resolveByokConfig("vibe", "sk-secret-key", "mistral-large-latest");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const req = buildChatCompletionRequest(r.config, buildMessages("lait 1L"));
  assert.equal(req.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(req.headers.Authorization, "Bearer sk-secret-key");
  assert.ok(!req.body.includes("sk-secret-key"));
  const body = JSON.parse(req.body) as {
    model: string;
    messages: { role: string; content: string }[];
    temperature: number;
    max_tokens: number;
  };
  assert.equal(body.model, "mistral-large-latest");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, BYOK_MAX_TOKENS);
  // The prompt contract is the same as the local model's.
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages.at(-1)?.content, "lait 1L");
});

test("extractAssistantText reads choices[0].message.content tolerantly", () => {
  assert.equal(
    extractAssistantText({ choices: [{ message: { content: '{"items":[]}' } }] }),
    '{"items":[]}',
  );
  assert.equal(extractAssistantText({ choices: [] }), null);
  assert.equal(extractAssistantText({ choices: [{ message: {} }] }), null);
  assert.equal(extractAssistantText(null), null);
  assert.equal(extractAssistantText("nope"), null);
});

test("extractApiErrorMessage surfaces provider messages or a generic fallback", () => {
  assert.equal(
    extractApiErrorMessage({ error: { message: "Invalid API key" } }, 401),
    "Invalid API key",
  );
  assert.equal(extractApiErrorMessage({ error: "quota exceeded" }, 429), "quota exceeded");
  assert.equal(extractApiErrorMessage({}, 500), "Erreur HTTP 500 de l'API du fournisseur.");
});

test("scrubApiKey masks the key and any bearer token", () => {
  assert.equal(scrubApiKey("erreur avec sk-test dedans", "sk-test"), "erreur avec «clé masquée» dedans");
  assert.equal(
    scrubApiKey("Authorization: Bearer abcdefghijklmno", ""),
    "Authorization: Bearer «clé masquée»",
  );
  assert.equal(scrubApiKey("rien a masquer", "sk-test"), "rien a masquer");
});
