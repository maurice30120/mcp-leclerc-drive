/**
 * Candidate base models for the bounded WebGPU POC (spec issue #40, ticket #47).
 *
 * SPEC DECISION: this list is INFORMATIVE AND NOT VALIDATED ("informatifs, non
 * validés"). No model is frozen by fiat — the base model is selected ON PROOF,
 * after its ONNX/WebGPU inference is demonstrated in Chrome and in the Node
 * harness (docs/poc/model-selection.md). Every candidate therefore records
 * what still has to be checked, not what has been concluded.
 */

export interface PocModelCandidate {
  /** Hugging Face model id used verbatim by the Transformers.js pipeline. */
  id: string;
  /** Approximate parameter count in millions (~0.5–1.5B window). */
  parametersMillions: number;
  /** Pin used by the POC run (transformers.js `revision` option). */
  revision: string;
  /** ONNX dtype to load on WebGPU (transformers.js `dtype` option). */
  dtype: string;
  license: string;
  /** French + strict-JSON recipe capability — NEVER pre-validated here. */
  frenchJsonCapability: "à vérifier";
  /** ONNX/WebGPU proof status — NEVER pre-validated here. */
  onnxWebgpuProof: "non exécuté";
  /** Honest motivation for listing the candidate; not a conclusion. */
  rationale: string;
}

/** Header status line reproduced verbatim in the POC report. */
export const CANDIDATES_STATUS =
  "Candidats informatifs, non validés — la sélection du modèle de base se fait sur preuve ONNX/WebGPU, jamais par décision de principe.";

export const POC_MODEL_CANDIDATES: readonly PocModelCandidate[] = [
  {
    id: "onnx-community/Qwen2.5-0.5B-Instruct",
    parametersMillions: 500,
    revision: "main",
    dtype: "q4f16",
    license: "Apache-2.0",
    frenchJsonCapability: "à vérifier",
    onnxWebgpuProof: "non exécuté",
    rationale:
      "Instruction-tuned, licence permissive, export ONNX communautaire actif ; capacité française/JSON à prouver au POC.",
  },
  {
    id: "onnx-community/Qwen2.5-1.5B-Instruct",
    parametersMillions: 1500,
    revision: "main",
    dtype: "q4f16",
    license: "Apache-2.0",
    frenchJsonCapability: "à vérifier",
    onnxWebgpuProof: "non exécuté",
    rationale:
      "Haut du créneau 0,5–1,5 Md ; même famille que le 0,5B pour comparer qualité/coût de chargement WebGPU.",
  },
  {
    id: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
    parametersMillions: 1600,
    revision: "main",
    dtype: "q4f16",
    license: "Apache-2.0",
    frenchJsonCapability: "à vérifier",
    onnxWebgpuProof: "non exécuté",
    rationale:
      "Limite haute du créneau, sortie Apache-2.0 ; anglais dominant, la capacité française est le point à trancher.",
  },
  {
    id: "HuggingFaceTB/SmolLM2-360M-Instruct",
    parametersMillions: 400,
    revision: "main",
    dtype: "q4f16",
    license: "Apache-2.0",
    frenchJsonCapability: "à vérifier",
    onnxWebgpuProof: "non exécuté",
    rationale:
      "Plancher du créneau pour mesurer le coût minimal acceptable en latence WebGPU ; qualité JSON probablement insuffisante, à vérifier.",
  },
];

/** Default candidate of the opt-in local run — overridable via environment. */
export const DEFAULT_POC_CANDIDATE: PocModelCandidate = POC_MODEL_CANDIDATES[0];
