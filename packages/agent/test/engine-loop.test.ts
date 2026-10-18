import { describe, expect, it } from "vitest";
import { runToolLoop } from "../src/engine.js";
import { bindingFromContract, ToolExecutor } from "../src/engine.js";
import { ApprovalGate } from "../src/approval.js";
import { createTraceBuilder } from "../src/trace.js";
import { SimulatedProvider } from "../src/providers/simulated.js";
import type { SimulatedStep } from "../src/providers/simulated.js";
import { addToCart, getCart, searchProduct } from "@leclerc/contracts";

function makeLoopExecutor() {
  const trace = createTraceBuilder();
  const gate = new ApprovalGate(() => ({ approved: true }));
  const executor = new ToolExecutor({
    bindings: [
      bindingFromContract(searchProduct, async (input) => ({
        ok: true,
        output: { products: [{ id: "P-1001", label: "Filets de poulet 600 g", price: 7.2, available: true }] },
      })),
      bindingFromContract(addToCart, async () => ({ ok: true, output: { cart: { items: [], itemCount: 0, total: 0, storeId: "053701" } } })),
      bindingFromContract(getCart, async () => ({ ok: true, output: { cart: { items: [], itemCount: 0, total: 0, storeId: "053701" } } })),
    ],
    gate,
    trace,
  });
  return { executor, trace };
}

describe("runToolLoop", () => {
  it("completes a text-only conversation", async () => {
    const { executor } = makeLoopExecutor();
    const provider = new SimulatedProvider({ script: [{ text: "bonjour" }] });
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "salut" }],
    });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("bonjour");
    expect(result.turns).toBe(1);
  });

  it("executes model tool calls and feeds tool results back to the model", async () => {
    const { executor } = makeLoopExecutor();
    const seenRequests: unknown[] = [];
    const script: SimulatedStep[] = [
      { toolCalls: [{ id: "call-1", name: "search_product", input: { query: "poulet" } }] },
      { text: "voilà le poulet" },
    ];
    const provider = new SimulatedProvider({ script, onGenerate: (req) => seenRequests.push(req) });
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "cherche du poulet" }],
    });
    expect(result.status).toBe("completed");
    expect(result.toolCallCount).toBe(1);
    // The second generate call must contain the tool result message.
    const second = seenRequests[1] as { messages: Array<{ role: string; toolCallId?: string; toolName?: string }> };
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call-1");
    expect(toolMessage?.toolName).toBe("search_product");
  });

  it("stops with limits_exceeded on maxTurns", async () => {
    const { executor } = makeLoopExecutor();
    const provider = new SimulatedProvider({
      script: [{ toolCalls: [{ id: "c", name: "search_product", input: { query: "poulet" } }] }],
    });
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "boucle" }],
      maxTurns: 1,
    });
    expect(result.status).toBe("limits_exceeded");
  });

  it("stops with limits_exceeded on maxToolCalls", async () => {
    const { executor } = makeLoopExecutor();
    const call = { id: "c", name: "search_product", input: { query: "poulet" } };
    const provider = new SimulatedProvider({ script: [{ toolCalls: [call] }] });
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "boucle" }],
      maxTurns: 10,
      maxToolCalls: 0,
    });
    expect(result.status).toBe("limits_exceeded");
    expect(result.toolCallCount).toBe(0);
  });

  it("stops cleanly on a pre-aborted signal (cancelled)", async () => {
    const { executor } = makeLoopExecutor();
    const provider = new SimulatedProvider({ script: [{ text: "jamais" }] });
    const controller = new AbortController();
    controller.abort();
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "stop" }],
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(provider.calls).toBe(0);
  });

  it("reports provider_error on a scripted error response", async () => {
    const { executor } = makeLoopExecutor();
    const provider = new SimulatedProvider({ script: [{ error: "sortie illisible" }] });
    const result = await runToolLoop({
      provider,
      executor,
      messages: [{ role: "user", content: "q" }],
    });
    expect(result.status).toBe("provider_error");
  });
});
