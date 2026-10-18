#!/usr/bin/env python3
"""LoRA smoke train on MLX-LM (ticket #54, spec #40) — Apple Silicon only.

Short, seeded, measured smoke training over the mini-sample produced by
audit_dataset.py (SFT examples, structured recipes ONLY — no tool usage).

BLOCKING GATE: the script REFUSES to run without --base-validated. The base
model must be proven loadable and correct in ONNX/WebGPU (Chrome) and in the
Node harness — POC ticket #47 — BEFORE any training investment. The flag is
explicit human acknowledgment that this proof exists; nothing is assumed.

Guarantees:
  - the BASELINE is never modified: adapters are written under
    training/runs/<run_id>/adapters/, never inside the base model path;
  - loss values are parsed from the trainer's real stdout, never invented;
  - memory and wall time are measured (getrusage(RUSAGE_CHILDREN) + monotonic
    clock), not estimated;
  - --resume restarts from an existing adapter (--resume-adapter-file);
  - every run writes training/runs/<run_id>/metrics.json with the config
    snapshot and its sha256, so runs are reproducible and versioned.

Exit codes: 0 trained; 1 training failed; 2 environment/usage (including the
gate refusal).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

TRAIN_TOOL_VERSION = 1

# Regexes against mlx-lm's observed output format ("It 12: Train loss 3.41,
# ...", "Validation loss ... at Iteration ..."). Only MATCHED values are
# recorded — anything the trainer does not print stays out of metrics.json.
TRAIN_LOSS_RE = r"It (\d+): Train loss ([\d.eE+-]+)"
VALID_LOSS_RE = r"Validation loss ([\d.eE+-]+),? (?:at [Ii]teration (\d+))?"

GATE_EXPLANATION = """\
REFUS : modèle de base non prouvé (gate bloquante, spéc #40 / tickets #47 et #54).

Aucun entraînement n'est lancé avant que le modèle de base ait été démontré
expérimentalement en ONNX/WebGPU : chargement dans Chrome (WebGPU) + sorties
valides, et chargement dans le harnais Node (POC du ticket #47). Les candidats
actuels sont INFORMATIFS ET NON VALIDÉS — un modèle n'est jamais figé par
décision de principe, seulement sur preuve.

Une fois la preuve documentée (rapport POC), relancer avec le drapeau :
    --base-validated
Ce drapeau est une reconnaissance humaine explicite que la preuve existe ;
il ne peut jamais être un réglage par défaut."""


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"SMOKE-TRAIN : ÉCHEC — {message}", file=sys.stderr)
    sys.exit(code)


def load_config(config_path: Path) -> dict[str, Any]:
    if not config_path.exists():
        fail(f"config introuvable : {config_path}", 2)
    config = json.loads(config_path.read_text(encoding="utf-8"))

    required = [
        ("base_model", str),
        ("lora", dict), ("training", dict), ("data", dict), ("checkpoint", dict),
    ]
    for key, expected_type in required:
        if key not in config:
            fail(f"config {config_path} : champ requis manquant {key!r}", 2)
        if not isinstance(config[key], expected_type):
            fail(f"config {config_path} : {key!r} doit être {expected_type.__name__}", 2)
    training = config["training"]
    for key in ("learning_rate", "batch_size", "iters", "seed"):
        if key not in training:
            fail(f"config {config_path} : training.{key} requis (reproductibilité)", 2)
    for key in ("num_layers", "rank"):
        if key not in config["lora"]:
            fail(f"config {config_path} : lora.{key} requis", 2)
    return config


def check_mlx_lm() -> None:
    """Fail loudly if mlx-lm is not importable in the current interpreter."""
    probe = subprocess.run(
        [sys.executable, "-c", "import mlx, mlx_lm"],
        capture_output=True, text=True,
    )
    if probe.returncode != 0:
        fail(
            "mlx/mlx_lm non installés dans cet interpréteur "
            f"({sys.executable}). Installer training/requirements.txt dans un "
            "environnement dédié sur le Mac de référence (Apple Silicon) — "
            "aucun pip install n'est effectué par ce script.",
            2,
        )


def build_command(
    config: dict[str, Any], data_dir: Path, adapter_path: Path,
    resume_path: Path | None,
) -> list[str]:
    """Assemble the mlx_lm.lora command from the versioned config.

    NOTE: flag names (--lora-rank, --seed, --save-every, --max-seq-len,
    --resume-adapter-file) must be validated against the PINNED mlx-lm
    version on the reference Mac — see training/requirements.txt.
    """
    lora = config["lora"]
    training = config["training"]
    checkpoint = config["checkpoint"]
    command = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", str(config["base_model"]),
        "--train",
        "--data", str(data_dir),
        "--adapter-path", str(adapter_path),
        "--iters", str(training["iters"]),
        "--batch-size", str(training["batch_size"]),
        "--learning-rate", str(training["learning_rate"]),
        "--num-layers", str(lora["num_layers"]),
        "--lora-rank", str(lora["rank"]),
        "--seed", str(training["seed"]),
    ]
    if training.get("max_seq_len") is not None:
        command += ["--max-seq-len", str(training["max_seq_len"])]
    if checkpoint.get("save_every") is not None:
        command += ["--save-every", str(checkpoint["save_every"])]
    if resume_path is not None:
        command += ["--resume-adapter-file", str(resume_path)]
    return command


def parse_losses(stdout: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Extract only the loss points the trainer actually printed."""
    import re

    train_points = [
        {"iter": int(match.group(1)), "loss": float(match.group(2))}
        for match in re.finditer(TRAIN_LOSS_RE, stdout)
    ]
    valid_points = [
        {"loss": float(match.group(1)), "at_iteration": match.group(2)}
        for match in re.finditer(VALID_LOSS_RE, stdout)
    ]
    return train_points, valid_points


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Smoke train LoRA MLX-LM sur le mini-échantillon (ticket #54). "
            "Refuse de s'exécuter sans --base-validated (gate WebGPU)."
        )
    )
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--base-validated", action="store_true",
        help="attestation que le modèle de base est prouvé en ONNX/WebGPU (POC #47)",
    )
    parser.add_argument("--resume", type=Path, default=None,
                        help="adaptateur existant depuis lequel reprendre")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--runs-dir", type=Path, default=Path("training/runs"))
    parser.add_argument("--data-dir", type=Path, default=None,
                        help="dossier contenant train.jsonl/valid.jsonl (défaut : dérivé de la config)")
    parser.add_argument("--dry-run", action="store_true",
                        help="construire et afficher la commande sans exécuter")
    args = parser.parse_args(argv)

    config = load_config(args.config)

    # ---- blocking gate --------------------------------------------------------
    if not args.base_validated:
        print(GATE_EXPLANATION, file=sys.stderr)
        return 2

    if not args.dry_run:
        check_mlx_lm()

    # ---- data checks (fail loudly, no silent fallback) ------------------------
    data_dir = args.data_dir
    if data_dir is None:
        train_file = Path(config["data"]["train_file"])
        valid_file = Path(config["data"]["valid_file"])
        for path, label in ((train_file, "train"), (valid_file, "valid")):
            if not path.exists():
                fail(
                    f"fichier {label} introuvable : {path} — produire d'abord "
                    f"l'échantillon avec training/audit/audit_dataset.py (ticket #53)",
                    2,
                )
        data_dir = train_file.parent

    # ---- run layout: baseline NEVER modified -----------------------------------
    started_at = datetime.now(timezone.utc)
    run_id = args.run_id or (
        f"{config.get('config_name', 'run')}-{started_at.strftime('%Y%m%dT%H%M%SZ')}"
    )
    run_dir = args.runs_dir / run_id
    adapter_path = run_dir / "adapters"
    if str(adapter_path.resolve()) in {
        str(Path(config["base_model"]).resolve()),
    }:
        fail("l'adaptateur ne peut pas écraser le modèle de base", 2)
    command = build_command(config, data_dir, adapter_path, args.resume)
    command_str = " ".join(command)
    if args.dry_run:
        print(f"DRY-RUN (rien n'est exécuté) :\n  {command_str}")
        return 0

    run_dir.mkdir(parents=True, exist_ok=True)

    # ---- training: measure time + memory, parse real losses --------------------
    before_rusage = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    started = time.monotonic()
    process = subprocess.run(command, capture_output=True, text=True)
    duration_seconds = time.monotonic() - started
    after_rusage = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    stdout, stderr = process.stdout, process.stderr

    train_points, valid_points = parse_losses(stdout)
    status = "completed" if process.returncode == 0 else "failed"

    metrics = {
        "tool_version": TRAIN_TOOL_VERSION,
        "run_id": run_id,
        "status": status,
        "exit_code": process.returncode,
        "started_at_utc": started_at.isoformat(),
        "ended_at_utc": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(duration_seconds, 3),
        "memory": {
            # ru_maxrss is bytes on macOS, KiB on Linux: keep the raw value
            # and the platform so nobody misreads it.
            "max_rss_children_raw": max(before_rusage, after_rusage),
            "rss_unit": "octets (macOS) / KiB (Linux) — voir platform",
            "platform": platform.platform(),
        },
        "base_model": config["base_model"],
        "seed": config["training"]["seed"],
        "iters_requested": config["training"]["iters"],
        "loss_observed": {
            "train": train_points,
            "validation": valid_points,
            "note": (
                "valeurs analysées depuis la sortie réelle de mlx_lm.lora — "
                "rien n'est estimé ni inventé"
            ),
        },
        "resume": str(args.resume) if args.resume else None,
        "baseline_protection": (
            "les adaptateurs sont écrits sous training/runs/ ; le modèle de "
            "base n'est jamais modifié"
        ),
        "config_snapshot": config,
        "config_path": str(args.config),
        "config_sha256": hashlib.sha256(
            args.config.read_bytes()
        ).hexdigest(),
        "command": command,
        "promotion": (
            "aucun checkpoint déclaré prêt : la baisse de la loss ne suffit "
            "jamais — évaluation qualité documentée obligatoire (docs/"
            "training-reproducibility.md)"
        ),
    }
    metrics_path = run_dir / "metrics.json"
    metrics_path.write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (run_dir / "train_stdout.log").write_text(stdout, encoding="utf-8")
    (run_dir / "train_stderr.log").write_text(stderr, encoding="utf-8")

    if status == "completed" and not train_points:
        print(
            "AVERTISSEMENT : entraînement terminé mais AUCUNE loss analysée "
            "dans la sortie — vérifier le format de mlx_lm.lora épinglé.",
            file=sys.stderr,
        )

    print(f"SMOKE-TRAIN : {status.upper()} — durées {metrics['duration_seconds']}s, "
          f"{len(train_points)} points de loss observés.")
    print(f"Métriques : {metrics_path}")
    print(f"Adaptateurs : {adapter_path}")
    return 0 if status == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
