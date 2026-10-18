import { describe, expect, it } from "vitest";
import { createMistralByokProvider } from "../src/index.js";

const API_KEY = "sk-TEST-SECRET-NEVER-LOGGED";

interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
}

function okResponse(body: unknown): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return { status: 200, ok: true, json: () => Promise.resolve(body) };
}

function httpError(status: number, body: unknown): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return { status, ok: false, json: () => Promise.resolve(body) };
}

function makeFetch(
  responses: Array<{ status: number; ok: boolean; json: () => Promise<unknown> } | Error>,
): { calls: FetchCall[]; fetch: (url: string, init: FetchCall["init"]) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> } {
  const calls: FetchCall[] = [];
  let next = 0;
  const fetch = (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    const step = responses[next];
    next++;
    if (step instanceof Error) {
      return Promise.reject(step);
    }
    return Promise.resolve(step);
  };
  return { calls, fetch };
}

describe("Mistral BYOK provider — request mapping", () => {
  it("maps messages and tools to the Mistral chat-completions API", async () => {
    const { calls, fetch } = makeFetch([
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-abc",
                  type: "function",
                  function: { name: "search_product", arguments: '{"query":"poulet"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "mistral-small-latest", fetchImpl: fetch });

    const res = await provider.generate({
      messages: [
        { role: "system", content: "Tu es l'assistant courses." },
        { role: "user", content: "Cherche du poulet." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-xyz", name: "get_cart", input: {} }],
        },
        { role: "tool", content: '{"ok":true}', toolCallId: "call-xyz", toolName: "get_cart" },
      ],
      tools: [
        {
          name: "search_product",
          description: "Recherche un produit",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          mutation: false,
        },
      ],
      temperature: 0,
      seed: 0,
      maxTokens: 1024,
    });

    expect(provider.id).toBe("mistral-byok");
    expect(provider.modelVersion).toBe("mistral-small-latest");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(calls[0].init.body);
    expect(body.model).toBe("mistral-small-latest");
    expect(body.messages).toEqual([
      { role: "system", content: "Tu es l'assistant courses." },
      { role: "user", content: "Cherche du poulet." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-xyz", type: "function", function: { name: "get_cart", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-xyz", content: '{"ok":true}' },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_product",
          description: "Recherche un produit",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0);
    expect(body.random_seed).toBe(0);
    expect(body.max_tokens).toBe(1024);

    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      { id: "call-abc", name: "search_product", input: { query: "poulet" } },
    ]);
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
  });

  it("maps a plain text completion with finish_reason stop", async () => {
    const { calls, fetch } = makeFetch([
      okResponse({
        choices: [{ message: { content: "Voici la liste." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 7 },
      }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("stop");
    expect(res.text).toBe("Voici la liste.");
    expect(res.usage).toEqual({ promptTokens: 3, completionTokens: 7 });
    expect(calls[0].init.body).not.toContain(API_KEY);
  });

  it("honours a baseUrl override (explicit option only)", async () => {
    const { calls, fetch } = makeFetch([
      okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    ]);
    const provider = createMistralByokProvider({
      apiKey: API_KEY,
      model: "m",
      fetchImpl: fetch,
      baseUrl: "https://proxy.exemple.internal",
    });
    await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(calls[0].url).toBe("https://proxy.exemple.internal/v1/chat/completions");
  });

  it("maps finish_reason length and ignores absent usage", async () => {
    const { fetch } = makeFetch([
      okResponse({ choices: [{ message: { content: "tronqué" }, finish_reason: "length" }] }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("length");
    expect(res.usage).toBeUndefined();
  });

  it("returns cancelled on a pre-aborted signal without any network call", async () => {
    const { calls, fetch } = makeFetch([
      okResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({
      messages: [{ role: "user", content: "q" }],
      signal: controller.signal,
    });
    expect(res.finishReason).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });
});

describe("Mistral BYOK provider — key sanitisation (never in traces or errors)", () => {
  it("redacts the key on a 401 even when the response body echoes it", async () => {
    const { fetch } = makeFetch([
      httpError(401, { message: `Clé invalide : ${API_KEY}` }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).toBeDefined();
    expect(res.text).not.toContain(API_KEY);
    expect(JSON.stringify(res)).not.toContain(API_KEY);
  });

  it("redacts the key on a 429 (quota)", async () => {
    const { fetch } = makeFetch([
      httpError(429, { message: `Quota dépassé, clé ${API_KEY}` }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).not.toContain(API_KEY);
  });

  it("redacts the key on a network failure whose error message embeds it", async () => {
    const { fetch } = makeFetch([new Error(`ECONNREFUSED pour Bearer ${API_KEY}`)]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).not.toContain(API_KEY);
  });

  it("redacts the key on an unexpected HTTP status with a leaky body", async () => {
    const { fetch } = makeFetch([httpError(500, { detail: `internal ${API_KEY}` })]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).not.toContain(API_KEY);
  });

  it("reports unreadable tool-call arguments as an error, sanitized", async () => {
    const { fetch } = makeFetch([
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call-bad", type: "function", function: { name: "search_product", arguments: "{pas du json " + API_KEY } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).not.toContain(API_KEY);
  });
});

describe("Mistral BYOK provider — explicit selection only", () => {
  it("makes no network call until generate() is explicitly invoked", async () => {
    const { calls, fetch } = makeFetch([
      okResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    ]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    expect(calls).toHaveLength(0);
    expect(provider.calls).toBe(0);
    expect(await provider.generate({ messages: [{ role: "user", content: "q" }] })).toBeDefined();
    expect(provider.calls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("never retries or falls back automatically: one generate = at most one call", async () => {
    const { calls, fetch } = makeFetch([httpError(500, {}), httpError(500, {})]);
    const provider = createMistralByokProvider({ apiKey: API_KEY, model: "m", fetchImpl: fetch });
    await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(calls).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });
});
