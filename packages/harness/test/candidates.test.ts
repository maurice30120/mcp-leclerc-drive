import { describe, expect, it } from "vitest";
import {
  CANDIDATES_STATUS,
  DEFAULT_POC_CANDIDATE,
  POC_MODEL_CANDIDATES,
} from "../src/poc/candidates.js";

describe("POC base-model candidate list (issue #47)", () => {
  it("is explicitly marked as informative and unvalidated", () => {
    expect(CANDIDATES_STATUS).toContain("informatifs");
    expect(CANDIDATES_STATUS).toContain("non validés");
  });

  it("only lists instruction-tuned models in the ~0.5–1.5B range", () => {
    expect(POC_MODEL_CANDIDATES.length).toBeGreaterThan(0);
    for (const candidate of POC_MODEL_CANDIDATES) {
      expect(candidate.parametersMillions).toBeGreaterThanOrEqual(400);
      expect(candidate.parametersMillions).toBeLessThanOrEqual(1600);
      expect(candidate.id.toLowerCase()).toMatch(/instruct|smollm/i);
    }
  });

  it("documents a permissive license and the checks still to run for each candidate", () => {
    for (const candidate of POC_MODEL_CANDIDATES) {
      expect(candidate.license).toMatch(/apache|mit|cc-by/i);
      expect(candidate.frenchJsonCapability).toBe("à vérifier");
      expect(candidate.onnxWebgpuProof).toBe("non exécuté");
    }
  });

  it("exposes a default candidate carrying the fields the report needs", () => {
    expect(DEFAULT_POC_CANDIDATE.id).toBe(POC_MODEL_CANDIDATES[0].id);
    expect(typeof DEFAULT_POC_CANDIDATE.revision).toBe("string");
    expect(DEFAULT_POC_CANDIDATE.revision.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_POC_CANDIDATE.dtype).toBe("string");
  });
});
