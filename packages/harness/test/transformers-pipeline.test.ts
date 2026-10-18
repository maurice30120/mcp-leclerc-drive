import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** Stand-in for @huggingface/transformers `pipeline`. */
  pipelineMock: vi.fn(),
}));

vi.mock("@huggingface/transformers", () => ({
  pipeline: hoisted.pipelineMock,
}));

import {
  createTransformersPipelineFactory,
  extractGeneratedText,
  type TransformersWebGpuPipeline,
} from "../src/poc/transformers-pipeline.js";

const ASSISTANT_REPLY = '{"title":"Poulet au curry"}';

function fakeTransformersPipeline() {
  const generateCall = vi.fn(async () => [
    { generated_text: ASSISTANT_REPLY },
  ]);
  return { generateCall };
}

beforeEach(() => {
  hoisted.pipelineMock.mockReset();
});

describe("Transformers.js WebGPU pipeline adapter (issue #47)", () => {
  it("has no import-time side effects: nothing touches @huggingface/transformers before the factory is called", () => {
    expect(hoisted.pipelineMock).not.toHaveBeenCalled();
    expect(typeof createTransformersPipelineFactory).toBe("function");
  });

  it("loads the pipeline lazily with device webgpu — the only device value ever passed", async () => {
    const { generateCall } = fakeTransformersPipeline();
    hoisted.pipelineMock.mockResolvedValueOnce(generateCall);
    const factory = createTransformersPipelineFactory({ dtype: "q4f16" });

    expect(hoisted.pipelineMock).not.toHaveBeenCalled();
    const pipeline = await factory({
      modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
      revision: "main",
      device: "webgpu",
    });

    expect(hoisted.pipelineMock).toHaveBeenCalledTimes(1);
    const [task, modelId, options] = hoisted.pipelineMock.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(task).toBe("text-generation");
    expect(modelId).toBe("onnx-community/Qwen2.5-0.5B-Instruct");
    expect(options.device).toBe("webgpu");
    expect(options.dtype).toBe("q4f16");
    expect(options.revision).toBe("main");
    expect(pipeline.metrics.loadMs).toBeGreaterThanOrEqual(0);
  });

  it("sends chat messages and pinned generation options, exposes generation latency and raw text", async () => {
    const { generateCall } = fakeTransformersPipeline();
    hoisted.pipelineMock.mockResolvedValueOnce(generateCall);
    const factory = createTransformersPipelineFactory({ dtype: "q4f16" });
    const pipeline = (await factory({
      modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
      device: "webgpu",
    })) as TransformersWebGpuPipeline;

    const output = await pipeline.generate({
      messages: [
        { role: "system", content: "système" },
        { role: "user", content: "utilisateur" },
      ],
      temperature: 0,
      seed: 0,
      maxTokens: 1024,
    });

    expect(generateCall).toHaveBeenCalledTimes(1);
    const [messages, generationOptions] = generateCall.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      Record<string, unknown>,
    ];
    expect(messages).toEqual([
      { role: "system", content: "système" },
      { role: "user", content: "utilisateur" },
    ]);
    expect(generationOptions.max_new_tokens).toBe(1024);
    expect(generationOptions.temperature).toBe(0);
    expect(generationOptions.seed).toBe(0);
    expect(output.text).toBe(ASSISTANT_REPLY);
    expect(pipeline.metrics.lastGenerationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("generated-text extraction (issue #47)", () => {
  it("keeps a plain string generated_text as-is", () => {
    expect(extractGeneratedText([{ generated_text: "réponse" }])).toBe("réponse");
  });

  it("extracts the last assistant message from a chat-template conversation", () => {
    const conversation = [
      { role: "user", content: "utilisateur" },
      { role: "assistant", content: ASSISTANT_REPLY },
    ];
    expect(extractGeneratedText([{ generated_text: conversation }])).toBe(ASSISTANT_REPLY);
  });

  it("degrades honestly to a stringified form for unknown shapes", () => {
    expect(extractGeneratedText([{ generated_text: 42 }])).toBe("42");
  });
});
