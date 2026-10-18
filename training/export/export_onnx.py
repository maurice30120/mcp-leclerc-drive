#!/usr/bin/env python3
"""Experimental export chain: LoRA merge -> HF weights -> ONNX -> quantization.

Ticket #55, spec #40. Nothing here is assumed to work: the MLX -> ONNX path
for the retained model family must be ESTABLISHED EXPERIMENTALLY on the
reference Mac (Apple Silicon). Every step runs a real, documented command and
its result (exit code, duration, output path) is recorded in
<work-dir>/export_status.json — successes and failures alike.

Blocking gates:
  - the script NEVER declares browser integration done. Even a fully
    successful chain leaves `browser_integration` at "PENDING — gate
    Chrome/WebGPU non franchie" until the exported model is proven to load
    and produce valid recipe JSON in Chrome (WebGPU) AND in the Node harness.
    --declare-browser-ready REFUSES and explains why.
  - HF publication is gated behind --publish + --license-audit <file> + the
    HF_TOKEN environment variable. --license-audit must point to a completed
    license-audit document (see training/docs/export-chain.md); without it,
    publishing is refused.

Exit codes: 0 chain ok; 1 a step failed; 2 environment/usage/refusal.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

EXPORT_TOOL_VERSION = 1

BROWSER_GATE_EXPLANATION = """\
REFUS : l'intégration navigateur ne peut PAS être déclarée terminée.

La gate bloquante n'est pas franchie : le modèle exporté doit être démontré
expérimentalement — chargement dans Chrome (WebGPU) ET chargement dans le
harnais Node, avec des recettes JSON valides en sortie (ticket #55 ; procédure
dans training/docs/export-chain.md). Une chaîne d'export qui réussit ne prouve
PAS l'intégration navigateur. En cas d'échec d'export, on documente le
blocage et on compare quand même sous MLX, sans jamais déclarer l'intégration
terminée."""


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"EXPORT : ÉCHEC — {message}", file=sys.stderr)
    sys.exit(code)


def require_tool(command: list[str], label: str) -> None:
    binary = shutil.which(command[0])
    if binary is None:
        fail(
            f"outil requis absent : {command[0]!r} ({label}) — installer "
            f"training/requirements.txt dans l'environnement dédié.",
            2,
        )


def run_step(
    name: str, command: list[str], cwd: Path | None = None
) -> dict[str, Any]:
    """Run one real command and record its honest outcome."""
    require_tool(command[:1], name)
    started = time.monotonic()
    process = subprocess.run(command, capture_output=True, text=True, cwd=cwd)
    duration = time.monotonic() - started
    return {
        "step": name,
        "command": command,
        "exit_code": process.returncode,
        "duration_seconds": round(duration, 3),
        "stdout_tail": process.stdout[-4000:],
        "stderr_tail": process.stderr[-4000:],
        "status": "ok" if process.returncode == 0 else "failed",
    }


def step_merge(
    base_model: str, adapter: Path, work_dir: Path
) -> tuple[dict[str, Any], Path]:
    """Step 1: fuse LoRA into merged HF-format weights (mlx_lm.fuse).

    The BASE model is only read; the merged result is a NEW directory.
    """
    merged_dir = work_dir / "merged-hf"
    command = [
        sys.executable, "-m", "mlx_lm.fuse",
        "--model", base_model,
        "--adapter-path", str(adapter),
        "--save-path", str(merged_dir),
        "--export-format", "hf",
    ]
    result = run_step("merge (mlx_lm.fuse, format HF)", command)
    return result, merged_dir


def step_onnx(merged_dir: Path, work_dir: Path) -> tuple[dict[str, Any], Path]:
    """Step 2: HF weights -> ONNX via optimum (NOT a direct MLX->ONNX path)."""
    onnx_dir = work_dir / "onnx"
    command = [
        "optimum-cli", "export", "onnx",
        "--model", str(merged_dir),
        "--task", "text-generation-with-past",
        "--device", "cpu",
        str(onnx_dir),
    ]
    result = run_step("export ONNX (optimum-cli)", command)
    return result, onnx_dir


def step_quantize(onnx_dir: Path, work_dir: Path) -> tuple[dict[str, Any], Path]:
    """Step 3: dynamic quantization of the exported ONNX graph.

    NOTE (honest): dynamic int8 quantization is the step this scaffold can
    actually run and verify. Browser-side 4-bit (MatMulNBits, dtype q4f16)
    requires extra tooling that must be proven on the reference Mac — this
    step does NOT claim WebGPU q4 support.
    """
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore
    except ImportError:
        fail(
            "onnxruntime non installé — quantification impossible ; installer "
            "training/requirements.txt.",
            2,
        )
    onnx_file = None
    for candidate in sorted(onnx_dir.rglob("*.onnx")):
        if "quant" in candidate.name:
            continue
        onnx_file = candidate
        break
    if onnx_file is None:
        fail(f"aucun fichier .onnx trouvé dans {onnx_dir}", 1)
    quantized_dir = work_dir / "onnx-quantized"
    quantized_dir.mkdir(parents=True, exist_ok=True)
    quantized_file = quantized_dir / f"{onnx_file.stem}-int8-dynamic.onnx"
    started = time.monotonic()
    try:
        quantize_dynamic(
            str(onnx_file), str(quantized_file), weight_type=QuantType.QInt8
        )
        result = {
            "step": "quantification dynamique int8 (onnxruntime.quantization)",
            "command": [
                "python", "-c",
                "onnxruntime.quantization.quantize_dynamic(...)  # voir "
                "training/export/export_onnx.py:step_quantize",
            ],
            "exit_code": 0,
            "duration_seconds": round(time.monotonic() - started, 3),
            "output": str(quantized_file),
            "status": "ok",
        }
    except Exception as exc:  # noqa: BLE001 — record the real failure
        result = {
            "step": "quantification dynamique int8 (onnxruntime.quantization)",
            "command": ["onnxruntime.quantization.quantize_dynamic"],
            "exit_code": 1,
            "duration_seconds": round(time.monotonic() - started, 3),
            "error": str(exc),
            "status": "failed",
        }
    return result, quantized_file


def step_publish(
    work_dir: Path, repo_id: str, license_audit: Path | None
) -> dict[str, Any]:
    """Step 4 (gated): public Hugging Face upload of derived weights.

    Refused unless a completed license audit is provided (dataset + base
    model licenses must permit derived-weights redistribution).
    """
    if license_audit is None:
        return {
            "step": "publication Hugging Face",
            "status": "refusé",
            "reason": (
                "publication refusée : fournir --license-audit <document> "
                "attestant que les licences du dataset ET du modèle de base "
                "autorisent la redistribution des poids dérivés"
            ),
        }
    if not license_audit.exists():
        fail(f"document d'audit de licence introuvable : {license_audit}", 2)
    token = os.environ.get("HF_TOKEN")
    if not token:
        return {
            "step": "publication Hugging Face",
            "status": "refusé",
            "reason": "HF_TOKEN absent — aucune publication sans identifiants explicites",
        }
    command = [
        sys.executable, "-m", "huggingface_hub.commands.huggingface_cli",
        "upload", repo_id, str(work_dir / "onnx-quantized"), "--commit-message",
        "Export ONNX quantifié (fusion LoRA) — chain #55",
    ]
    result = run_step("publication Hugging Face", command)
    result["license_audit"] = str(license_audit)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Chaîne d'export expérimentale MLX → fusion LoRA → ONNX → "
            "quantification (ticket #55). Chaque étape est une commande réelle "
            "documentée ; aucune intégration navigateur n'est déclarée sans "
            "la gate Chrome/WebGPU."
        )
    )
    parser.add_argument("--config", type=Path, default=None,
                        help="config du run (source du modèle de base)")
    parser.add_argument("--base-model", default=None,
                        help="modèle de base (surcharge la config)")
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument(
        "--step", choices=["merge", "onnx", "quantize", "publish", "all"],
        default="all",
    )
    parser.add_argument("--hf-repo-id", default=None,
                        help="dépôt HF cible de la publication (étape publish)")
    parser.add_argument("--license-audit", type=Path, default=None)
    parser.add_argument("--declare-browser-ready", action="store_true")
    args = parser.parse_args(argv)

    if args.declare_browser_ready:
        print(BROWSER_GATE_EXPLANATION, file=sys.stderr)
        return 2

    if not args.adapter.exists():
        fail(
            f"adaptateur introuvable : {args.adapter} — aucun export n'est "
            f"fabriqué sans run d'entraînement réel.",
            2,
        )

    base_model = args.base_model
    if base_model is None:
        if args.config is None:
            fail("fournir --base-model ou --config", 2)
        config = json.loads(args.config.read_text(encoding="utf-8"))
        base_model = config["base_model"]

    work_dir = args.work_dir
    work_dir.mkdir(parents=True, exist_ok=True)

    steps: list[dict[str, Any]] = []
    merged_dir = work_dir / "merged-hf"
    onnx_dir = work_dir / "onnx"
    quantized_file: Path | None = None

    if args.step in ("merge", "all"):
        result, merged_dir = step_merge(base_model, args.adapter, work_dir)
        steps.append(result)
        if result["status"] != "ok":
            finish(work_dir, steps, failed=True)
            return 1
    if args.step in ("onnx", "all"):
        if not merged_dir.exists():
            fail("l'étape onnx exige le répertoire merged-hf (lancer --step merge d'abord)", 2)
        result, onnx_dir = step_onnx(merged_dir, work_dir)
        steps.append(result)
        if result["status"] != "ok":
            finish(work_dir, steps, failed=True)
            return 1
    if args.step in ("quantize", "all"):
        if not onnx_dir.exists():
            fail("l'étape quantize exige le répertoire onnx (lancer --step onnx d'abord)", 2)
        result, quantized_file = step_quantize(onnx_dir, work_dir)
        steps.append(result)
        if result["status"] != "ok":
            finish(work_dir, steps, failed=True)
            return 1
    if args.step in ("publish", "all"):
        if args.hf_repo_id is None:
            fail("--hf-repo-id requis pour l'étape publish", 2)
        steps.append(step_publish(work_dir, args.hf_repo_id, args.license_audit))

    finish(work_dir, steps)
    return 0


def finish(work_dir: Path, steps: list[dict[str, Any]], failed: bool = False) -> None:
    """Write the honest export status — browser gate is NEVER auto-passed."""
    status = {
        "tool_version": EXPORT_TOOL_VERSION,
        "finished_at_utc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "steps": steps,
        # Blocking gate: even a 100% successful chain does not prove browser
        # integration. Only the documented Chrome (WebGPU) + Node harness
        # procedure can flip this — manually, in export_status.json, with the
        # evidence linked. See training/docs/export-chain.md.
        "browser_integration": "PENDING — gate Chrome/WebGPU non franchie",
        "post_export_checks": (
            "exécuter training/export/check_export.py — statut : EN ATTENTE "
            "D'EXÉCUTION sur la machine de référence"
        ),
    }
    (work_dir / "export_status.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"EXPORT : statut écrit dans {work_dir}/export_status.json "
          f"({'ÉCHEC' if failed else 'chaîne exécutée'})")
    if failed:
        print(
            "Blocage documenté — comparer quand même sous MLX "
            "(finetune/gen_compare.py) sans déclarer l'intégration navigateur terminée.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    sys.exit(main())
