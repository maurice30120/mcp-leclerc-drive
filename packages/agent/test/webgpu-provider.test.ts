import { afterEach, describe, expect, it } from "vitest";
import {
  createMistralByokProvider,
  createNavigatorGpuProbe,
  createWebGpuProvider,
  ProviderUnavailableError,
  type WebGpuPipeline,
  type WebGpuPipelineFactory,
  type WebGpuProbe,
} from "../src/index.js";

function okProbe(): WebGpuProbe {
  return async () => ({ ok: true });
}

function failProbe(reason: string): WebGpuProbe {
  return async () => ({ ok: false, reason });
}

function makePipelineFactory(): {
  factory: WebGpuPipelineFactory;
  options: Array<{ modelId: string; revision?: string; device: string }>;
  counts: { generateCalls: number };
} {
  const options: Array<{ modelId: string; revision?: string; device: string }> = [];
  const counts = { generateCalls: 0 };
  const factory: WebGpuPipelineFactory = async (opts) => {
    options.push(opts);
    const pipeline: WebGpuPipeline = {
      generate: async () => {
        counts.generateCalls++;
        return { text: "Deux filets de poulet et du riz." };
      },
    };
    return pipeline;
  };
  return { factory, options, counts };
}

const MESSAGES = [{ role: "user" as const, content: "Poulet au curry pour 4." }];

describe("WebGPU provider — generation", () => {
  it("probes, then runs one generation through the pipeline with device webgpu", async () => {
    const { factory, options, counts } = makePipelineFactory();
    const provider = createWebGpuProvider({
      modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
      revision: "onnx_webgpu",
      probe: okProbe(),
      pipelineFactory: factory,
    });

    const res = await provider.generate({ messages: MESSAGES, temperature: 0, seed: 0, maxTokens: 1024 });

    expect(res.finishReason).toBe("stop");
    expect(res.text).toBe("Deux filets de poulet et du riz.");
    expect(counts.generateCalls).toBe(1);
    expect(provider.calls).toBe(1);
    expect(provider.id).toBe("webgpu:onnx-community/Qwen2.5-0.5B-Instruct");
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({
      modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
      revision: "onnx_webgpu",
      device: "webgpu",
    });
  });

  it("merges generationParams defaults with per-request overrides", async () => {
    let seen: Record<string, unknown> | undefined;
    const factory: WebGpuPipelineFactory = async () => ({
      generate: async (input) => {
        seen = { ...input };
        return { text: "ok" };
      },
    });
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: okProbe(),
      pipelineFactory: factory,
      generationParams: { temperature: 0, seed: 0, maxTokens: 1024 },
    });
    await provider.generate({ messages: MESSAGES, maxTokens: 64 });
    expect(seen).toMatchObject({ temperature: 0, seed: 0, maxTokens: 64 });
    expect(seen?.messages).toEqual(MESSAGES);

    const other = createWebGpuProvider({
      modelId: "m",
      probe: okProbe(),
      pipelineFactory: factory,
      generationParams: { maxTokens: 512 },
    });
    await other.generate({ messages: MESSAGES });
    expect(seen).toMatchObject({ maxTokens: 512 });
    expect(seen?.temperature).toBeUndefined();
  });

  it("returns cancelled on a pre-aborted signal without probing", async () => {
    let probeCalls = 0;
    const probe: WebGpuProbe = async () => {
      probeCalls++;
      return { ok: true };
    };
    const provider = createWebGpuProvider({ modelId: "m", probe, pipelineFactory: makePipelineFactory().factory });
    const controller = new AbortController();
    controller.abort();
    const res = await provider.generate({ messages: MESSAGES, signal: controller.signal });
    expect(res.finishReason).toBe("cancelled");
    expect(probeCalls).toBe(0);
  });
});

describe("WebGPU provider — WebGPU exclusivity (no CPU/WASM fallback)", () => {
  it("always passes device 'webgpu' to the pipeline factory, ignoring any injected device", async () => {
    const { factory, options } = makePipelineFactory();
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: okProbe(),
      pipelineFactory: factory,
      // Sneaking a device option must be ignored: there is no code path that
      // can construct a wasm/cpu device configuration.
      ...({ device: "wasm" } as Record<string, unknown>),
    } as Parameters<typeof createWebGpuProvider>[0]);
    await provider.generate({ messages: MESSAGES });
    expect(options[0].device).toBe("webgpu");
  });

  it("does not probe or create a pipeline at construction (nothing runs at import time)", async () => {
    let probeCalls = 0;
    let factoryCalls = 0;
    const probe: WebGpuProbe = async () => {
      probeCalls++;
      return { ok: true };
    };
    const pipelineFactory: WebGpuPipelineFactory = async () => {
      factoryCalls++;
      return { generate: async () => ({ text: "ok" }) };
    };
    createWebGpuProvider({ modelId: "m", probe, pipelineFactory });
    expect(probeCalls).toBe(0);
    expect(factoryCalls).toBe(0);
  });
});

describe("WebGPU provider — unavailability (A10, provider level)", () => {
  it("throws ProviderUnavailableError on probe failure and never launches the pipeline", async () => {
    const { factory, counts } = makePipelineFactory();
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: failProbe("aucun adaptateur GPU disponible"),
      pipelineFactory: factory,
    });

    let error: unknown;
    try {
      await provider.generate({ messages: MESSAGES });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    const unavailable = error as ProviderUnavailableError;
    expect(unavailable.code).toBe("PROVIDER_UNAVAILABLE");
    expect(unavailable.diagnostic).toContain("WebGPU");
    expect(unavailable.diagnostic).toContain("repli CPU/WASM");
    expect(unavailable.proposal).toMatchObject({
      providerId: "mistral-byok",
      consentRequired: true,
    });
    expect(unavailable.proposal?.label).toContain("Mistral");
    // The local model was NOT launched.
    expect(counts.generateCalls).toBe(0);
  });

  it("never calls the proposed Mistral provider (zero cloud calls, counter asserted)", async () => {
    const mistralCalls: unknown[] = [];
    const mistral = createMistralByokProvider({
      apiKey: "sk-TEST",
      model: "m",
      fetchImpl: (url, init) => {
        mistralCalls.push({ url, init });
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
      },
    });
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: failProbe("WebGPU indisponible"),
      pipelineFactory: makePipelineFactory().factory,
    });

    await expect(provider.generate({ messages: MESSAGES })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(mistral.calls).toBe(0);
    expect(mistralCalls).toHaveLength(0);
  });

  it("throws ProviderUnavailableError when session creation (pipeline) fails", async () => {
    const pipelineFactory: WebGpuPipelineFactory = async () => {
      throw new Error("session WebGPU: création impossible");
    };
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: okProbe(),
      pipelineFactory,
    });
    let error: unknown;
    try {
      await provider.generate({ messages: MESSAGES });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    const unavailable = error as ProviderUnavailableError;
    expect(unavailable.diagnostic).toContain("session");
    expect(unavailable.proposal?.providerId).toBe("mistral-byok");
  });

  it("stays unavailable on repeated generate calls: no silent fallback ever materializes", async () => {
    const { factory, counts } = makePipelineFactory();
    const provider = createWebGpuProvider({
      modelId: "m",
      probe: failProbe("indisponible"),
      pipelineFactory: factory,
    });
    await expect(provider.generate({ messages: MESSAGES })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.generate({ messages: MESSAGES })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(counts.generateCalls).toBe(0);
  });
});

describe("createNavigatorGpuProbe", () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value });
  }

  afterEach(() => {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("fails beyond mere presence when the adapter request returns no adapter", async () => {
    setNavigator({ gpu: { requestAdapter: async () => null } });
    const probe = createNavigatorGpuProbe();
    const result = await probe({ modelId: "m", device: "webgpu" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("adaptateur");
  });

  it("succeeds when a real adapter is obtained", async () => {
    setNavigator({ gpu: { requestAdapter: async () => ({ features: [] }) } });
    const probe = createNavigatorGpuProbe();
    const result = await probe({ modelId: "m", device: "webgpu" });
    expect(result.ok).toBe(true);
  });

  it("fails with an explicit reason when WebGPU is not exposed at all", async () => {
    setNavigator(undefined);
    const probe = createNavigatorGpuProbe();
    const result = await probe({ modelId: "m", device: "webgpu" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("WebGPU");
  });
});
