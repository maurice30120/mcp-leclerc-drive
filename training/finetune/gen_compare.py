#!/usr/bin/env python3
"""Baseline vs LoRA comparison at IDENTICAL prompts and parameters (#54).

Replays the frozen F01 fixture (training/finetune/prompts_f01.jsonl — the
same prompts and pinned generation parameters as the harness scenario F01)
against the untouched baseline model and against base+LoRA adapter.

Honesty rules:
  - raw generations and durations are recorded VERBATIM, nothing cleaned up;
  - NO quality claim is produced: the report contains the outputs, not an
    opinion. Quality assessment is a separate documented evaluation.
  - the comparison refuses to run if the adapter is missing (a comparison
    with an invented "before/after" is never fabricated).

Exit codes: 0 ok; 1 generation failure; 2 environment/usage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

COMPARE_TOOL_VERSION = 1


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"GEN-COMPARE : ÉCHEC — {message}", file=sys.stderr)
    sys.exit(code)


def load_prompts(prompts_path: Path) -> list[dict[str, Any]]:
    if not prompts_path.exists():
        fail(
            f"{prompts_path} introuvable — le fixture figé F01 est requis ; "
            f"le générer via node training/finetune/gen_prompts_f01.mjs",
            2,
        )
    prompts = []
    for line_no, line in enumerate(prompts_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        record = json.loads(line)
        for key in ("id", "system", "user", "generation"):
            if key not in record:
                fail(f"{prompts_path} ligne {line_no} : champ {key!r} manquant", 2)
        prompts.append(record)
    if not prompts:
        fail(f"{prompts_path} : aucun prompt figé trouvé", 2)
    return prompts


def build_generate_command(
    model: str, prompt_record: dict[str, Any], adapter: str | None,
) -> list[str]:
    """mlx_lm.generate command — identical params for baseline and LoRA.

    NOTE: --system/--seed flag availability must be validated against the
    pinned mlx-lm version on the reference Mac.
    """
    generation = prompt_record["generation"]
    command = [
        sys.executable, "-m", "mlx_lm.generate",
        "--model", model,
        "--system", str(prompt_record["system"]),
        "--prompt", str(prompt_record["user"]),
        "--max-tokens", str(generation["maxTokens"]),
        "--temp", str(generation["temperature"]),
        "--seed", str(generation["seed"]),
    ]
    if adapter is not None:
        command += ["--adapter", adapter]
    return command


def extract_generation(raw_stdout: str) -> str:
    """Keep everything after the last '=====' separator line (mlx-lm output)."""
    lines = raw_stdout.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].strip().startswith("====="):
            return "\n".join(lines[index + 1:]).strip()
    return raw_stdout.strip()


def run_one(
    label: str, command: list[str]
) -> dict[str, Any]:
    started = time.monotonic()
    process = subprocess.run(command, capture_output=True, text=True)
    duration = time.monotonic() - started
    return {
        "label": label,
        "command": command,
        "exit_code": process.returncode,
        "duration_seconds": round(duration, 3),
        "raw_stdout": process.stdout,
        "raw_stderr": process.stderr,
        "extracted_generation": extract_generation(process.stdout),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Comparaison baseline vs LoRA aux mêmes prompts figés F01 et aux "
            "mêmes paramètres de génération — sorties brutes uniquement."
        )
    )
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--adapter", type=Path, required=True,
                        help="adaptateur LoRA à comparer à la baseline")
    parser.add_argument("--prompts", type=Path,
                        default=Path("training/finetune/prompts_f01.jsonl"))
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--runs-dir", type=Path, default=Path("training/runs"))
    args = parser.parse_args(argv)

    config = json.loads(args.config.read_text(encoding="utf-8"))
    base_model = config["base_model"]

    if not args.adapter.exists():
        fail(
            f"adaptateur introuvable : {args.adapter} — aucune comparaison "
            f"n'est fabriquée sans run réel (lancer lora_smoke_train.py d'abord)",
            2,
        )

    probe = subprocess.run(
        [sys.executable, "-c", "import mlx_lm"], capture_output=True, text=True
    )
    if probe.returncode != 0:
        fail(
            "mlx_lm non installé dans cet interpréteur — installer "
            "training/requirements.txt sur le Mac de référence.",
            2,
        )

    prompts = load_prompts(args.prompts)
    started_at = datetime.now(timezone.utc)
    run_id = args.run_id or (
        f"compare-{started_at.strftime('%Y%m%dT%H%M%SZ')}"
    )
    run_dir = args.runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for prompt_record in prompts:
        prompt_id = str(prompt_record["id"])
        baseline_run = run_one(
            f"{prompt_id}-baseline",
            build_generate_command(base_model, prompt_record, None),
        )
        lora_run = run_one(
            f"{prompt_id}-lora",
            build_generate_command(base_model, prompt_record, str(args.adapter)),
        )
        results.append(
            {
                "prompt_id": prompt_id,
                "prompt": {
                    "system": prompt_record["system"],
                    "user": prompt_record["user"],
                },
                "generation_params": prompt_record["generation"],
                "baseline": baseline_run,
                "lora": lora_run,
            }
        )
        for label, run in (("baseline", baseline_run), ("lora", lora_run)):
            (run_dir / f"{prompt_id}.{label}.json").write_text(
                json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8"
            )

    exit_codes = [
        run["exit_code"]
        for result in results
        for run in (result["baseline"], result["lora"])
    ]
    summary = {
        "tool_version": COMPARE_TOOL_VERSION,
        "run_id": run_id,
        "started_at_utc": started_at.isoformat(),
        "base_model": base_model,
        "adapter": str(args.adapter),
        "config_sha256": hashlib.sha256(args.config.read_bytes()).hexdigest(),
        "prompts_file": str(args.prompts),
        "results": results,
        "quality_assessment": (
            "non évaluée — sorties brutes et durées uniquement ; aucune "
            "affirmation de qualité n'est émise par cet outil"
        ),
    }
    summary_path = run_dir / "summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"GEN-COMPARE : {len(results)} prompt(s) comparé(s), sorties brutes dans {run_dir}/")
    if any(code != 0 for code in exit_codes):
        print("AVERTISSEMENT : au moins une génération a échoué — voir exit codes.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
