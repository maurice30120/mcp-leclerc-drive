import { describe, expect, it } from "vitest";
import { createTraceBuilder } from "../src/trace.js";
import { PROMPT_VERSION, RECIPE_SYSTEM_PROMPT } from "../src/prompts.js";

describe("prompts", () => {
  it("exposes a frozen French recipe system prompt with a version", () => {
    expect(typeof PROMPT_VERSION).toBe("number");
    expect(RECIPE_SYSTEM_PROMPT).toContain("JSON");
    expect(RECIPE_SYSTEM_PROMPT).not.toContain("```");
    // The prompt must teach the strict rules of @leclerc/contracts recipe parsing.
    expect(RECIPE_SYSTEM_PROMPT).toMatch(/sans markdown/i);
  });
});

describe("TraceBuilder", () => {
  it("records every event type with an ISO timestamp", () => {
    const trace = createTraceBuilder();
    trace.userMessage("un poulet au curry pour 4");
    trace.modelText("voici la recette", 12);
    trace.toolCall("model", "search_product", { query: "poulet" }, "call-1");
    trace.toolResult("search_product", "call-1", { ok: true, output: { products: [] } }, 5);
    trace.repairAttempt(1, [
      { code: "NOT_JSON", message: "pas du JSON pur" },
    ]);
    trace.approvalRequest({ kind: "global_cart_mutation", summary: "3 articles" });
    trace.approvalDecision("approved");
    trace.safetyBlock("add_to_cart", "approbation globale requise");
    trace.clarification(
      { kind: "ambiguous_match", ingredient: "lait de coco", candidates: [], message: "Lequel ?" },
      { productId: "P-1003" },
    );
    trace.error("RECIPE_INVALID", "recette non conforme");

    const events = trace.events;
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "model_text",
      "tool_call",
      "tool_result",
      "repair_attempt",
      "approval_request",
      "approval_decision",
      "safety_block",
      "clarification",
      "error",
    ]);
    for (const event of events) {
      expect(typeof event.timestamp).toBe("string");
      expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
  });

  it("records durations and tool sources on the events that carry them", () => {
    const trace = createTraceBuilder();
    trace.modelText("texte", 42);
    const modelText = trace.events[0];
    expect(modelText).toMatchObject({ type: "model_text", durationMs: 42 });

    trace.toolCall("deterministic", "add_to_cart", { product_id: "P-1" });
    const deterministicCall = trace.events[1];
    expect(deterministicCall).toMatchObject({
      type: "tool_call",
      source: "deterministic",
      name: "add_to_cart",
    });

    trace.toolResult("add_to_cart", undefined, { ok: false, code: "APPROVAL_REQUIRED", message: "refus", retryable: false }, 7);
    const errorResult = trace.events[2];
    expect(errorResult).toMatchObject({ type: "tool_result", ok: false });
    expect(errorResult).toHaveProperty("durationMs", 7);
  });

  it("is JSON-serializable for scenario reports", () => {
    const trace = createTraceBuilder();
    trace.userMessage("bonjour");
    const parsed = JSON.parse(JSON.stringify(trace.events));
    expect(parsed[0].type).toBe("user_message");
  });
});
