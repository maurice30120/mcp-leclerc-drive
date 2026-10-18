import { describe, expect, it } from "vitest";
import { ProviderUnavailableError, SimulatedProvider } from "../src/index.js";

describe("ModelProvider seam", () => {
  it("serves scripted text steps in order and stops cleanly when exhausted", () => {
    const provider = new SimulatedProvider({ script: [{ text: "première" }, { text: "seconde" }] });
    const first = provider.generate({ messages: [{ role: "user", content: "q" }] });
    return first.then(async (res) => {
      expect(res.text).toBe("première");
      expect(res.finishReason).toBe("stop");
      const second = await provider.generate({ messages: [{ role: "user", content: "q" }] });
      expect(second.text).toBe("seconde");
      const third = await provider.generate({ messages: [{ role: "user", content: "q" }] });
      expect(third.text).toBe("");
      expect(third.finishReason).toBe("stop");
    });
  });

  it("reports native tool calls with finishReason tool_calls", async () => {
    const provider = new SimulatedProvider({
      script: [
        { toolCalls: [{ id: "call-1", name: "search_product", input: { query: "poulet" } }] },
      ],
    });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("tool_calls");
    expect(res.toolCalls).toEqual([
      { id: "call-1", name: "search_product", input: { query: "poulet" } },
    ]);
  });

  it("propagates a scripted error response without throwing", async () => {
    const provider = new SimulatedProvider({ script: [{ error: "sortie illisible" }] });
    const res = await provider.generate({ messages: [{ role: "user", content: "q" }] });
    expect(res.finishReason).toBe("error");
    expect(res.text).toBe("sortie illisible");
  });

  it("respects a pre-aborted signal (cooperative cancellation)", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new SimulatedProvider({ script: [{ text: "jamais servi" }] });
    const res = await provider.generate({
      messages: [{ role: "user", content: "q" }],
      signal: controller.signal,
    });
    expect(res.finishReason).toBe("cancelled");
  });

  it("exposes call counts and identity for campaign reports", async () => {
    const provider = new SimulatedProvider({
      id: "simulated",
      modelVersion: "simulated-1.0",
      script: [{ text: "ok" }],
    });
    await provider.generate({ messages: [] });
    await provider.generate({ messages: [] });
    expect(provider.calls).toBe(2);
    expect(provider.id).toBe("simulated");
    expect(provider.modelVersion).toBe("simulated-1.0");
    expect(provider.capabilities.toolCalling).toBe(true);
  });
});

describe("ProviderUnavailableError", () => {
  it("carries a diagnostic and a consent-only proposal", () => {
    const err = new ProviderUnavailableError(
      "WebGPU indisponible",
      "WebGPU est indisponible sur cette machine : le modèle local ne peut pas être lancé.",
      { providerId: "mistral-byok", label: "Mistral (clé personnelle)", consentRequired: true },
    );
    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
    expect(err.diagnostic).toContain("WebGPU");
    expect(err.proposal?.consentRequired).toBe(true);
    expect(err.proposal?.providerId).toBe("mistral-byok");
  });
});
