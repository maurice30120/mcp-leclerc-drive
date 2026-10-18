#!/usr/bin/env python3
"""Post-export checks: tokenizer intact, prompt format intact, generation smoke.

Ticket #55, spec #40. Runs on the REFERENCE MACHINE against an export
produced by export_onnx.py, and verifies the two acceptance criteria that a
merge/export must not break:

  1. tokenizer intact — token ids of frozen probe strings (French accents,
     quotes, JSON punctuation) are IDENTICAL between the base model and the
     exported artifact;
  2. prompt format intact — the chat template applied to the frozen F01
     messages renders IDENTICALLY on both tokenizers;
  3. generation smoke — the exported model actually generates on an F01
     prompt with the pinned parameters; the raw output is recorded and
     checked against the strict recipe-JSON contract (mirror of
     packages/contracts/src/recipe-generated.ts — bare JSON, allowlist root
     fields, {name, quantity, unit} ingredients, controlled units).

STATUS: PENDING EXECUTION — this script has never run (no reference Mac, no
export). It fails loudly at every missing dependency or artifact instead of
skipping checks. Results land in <report-dir>/checks.json.

Exit codes: 0 all checks pass; 1 at least one check fails; 2 environment.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

CHECK_TOOL_VERSION = 1

# Mirror of packages/contracts/src/recipe-generated.ts (schema version 1):
# keep in sync with the contract — never loosen locally.
RECIPE_ALLOWED_ROOT_FIELDS = {"title", "servings", "ingredients", "steps",
                              "prepMinutes", "cookMinutes", "category"}
RECIPE_ALLOWED_INGREDIENT_FIELDS = {"name", "quantity", "unit"}
CONTROLLED_UNITS = {
    "g", "kg", "ml", "cl", "l", "pièce", "tranche", "sachet", "boîte",
    "gousse", "pincée", "botte", "pot", "cuillère à soupe", "cuillère à café",
}

# Frozen probe strings — accents, guillemets, JSON punctuation.
TOKENIZER_PROBES = [
    "Un poulet au curry pour quatre personnes, et prépare les courses au drive.",
    '{"title": "Poulet au curry", "servings": 4, "unité": "cuillère à café"}',
    "« sans crème » — préparation : 10 min, cuisson : 25 min ;",
    "œuf, bâton de cannelle, pincée de piment d'Espelette…",
]


def fail(message: str, code: int = 2) -> NoReturn:
    print(f"CHECK-EXPORT : ÉCHEC — {message}", file=sys.stderr)
    sys.exit(code)


def require_transformers() -> Any:
    try:
        import transformers  # type: ignore
    except ImportError:
        fail(
            "transformers absent — installer training/requirements.txt dans "
            "l'environnement dédié de la machine de référence.",
            2,
        )
    return transformers


def load_prompts(prompts_path: Path) -> list[dict[str, Any]]:
    if not prompts_path.exists():
        fail(f"fixture figé introuvable : {prompts_path}", 2)
    records = [
        json.loads(line)
        for line in prompts_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not records:
        fail(f"{prompts_path} : aucun prompt", 2)
    return records


def check_tokenizer(base_model: str, exported_dir: Path, transformers: Any) -> dict[str, Any]:
    """Token ids of the probe strings must be identical, tokenizer to tokenizer."""
    try:
        base_tokenizer = transformers.AutoTokenizer.from_pretrained(base_model)
        exported_tokenizer = transformers.AutoTokenizer.from_pretrained(str(exported_dir))
    except Exception as exc:  # noqa: BLE001
        return {"check": "tokenizer", "status": "failed", "error": str(exc)}

    mismatches = []
    for probe in TOKENIZER_PROBES:
        base_ids = base_tokenizer.encode(probe)
        exported_ids = exported_tokenizer.encode(probe)
        if base_ids != exported_ids:
            mismatches.append({"probe": probe, "base": base_ids, "exported": exported_ids})
    return {
        "check": "tokenizer",
        "status": "ok" if not mismatches else "failed",
        "probes": len(TOKENIZER_PROBES),
        "mismatches": mismatches,
    }


def check_prompt_format(
    base_model: str, exported_dir: Path, prompt_record: dict[str, Any], transformers: Any
) -> dict[str, Any]:
    """Chat template applied to the F01 messages must render identically."""
    try:
        base_tokenizer = transformers.AutoTokenizer.from_pretrained(base_model)
        exported_tokenizer = transformers.AutoTokenizer.from_pretrained(str(exported_dir))
        messages = [
            {"role": "system", "content": prompt_record["system"]},
            {"role": "user", "content": prompt_record["user"]},
        ]
        base_rendered = base_tokenizer.apply_chat_template(messages, tokenize=False)
        exported_rendered = exported_tokenizer.apply_chat_template(
            messages, tokenize=False
        )
    except Exception as exc:  # noqa: BLE001
        return {"check": "prompt_format", "status": "failed", "error": str(exc)}
    identical = base_rendered == exported_rendered
    return {
        "check": "prompt_format",
        "status": "ok" if identical else "failed",
        "identical": identical,
        "base_rendered": base_rendered,
        "exported_rendered": exported_rendered,
    }


def check_generation(
    exported_dir: Path, prompt_record: dict[str, Any]
) -> dict[str, Any]:
    """Generation smoke on the exported model + strict recipe-JSON contract."""
    try:
        from optimum.onnxruntime import ORTModelForCausalLM  # type: ignore
        import transformers  # type: ignore

        model = ORTModelForCausalLM.from_pretrained(str(exported_dir))
        tokenizer = transformers.AutoTokenizer.from_pretrained(str(exported_dir))
        messages = [
            {"role": "system", "content": prompt_record["system"]},
            {"role": "user", "content": prompt_record["user"]},
        ]
        inputs = tokenizer.apply_chat_template(
            messages, return_tensors="pt", add_generation_prompt=True
        )
        generation = prompt_record["generation"]
        output_ids = model.generate(
            inputs,
            max_new_tokens=generation["maxTokens"],
            do_sample=generation["temperature"] > 0,
            temperature=max(generation["temperature"], 1e-5),
        )
        raw = tokenizer.decode(output_ids[0][inputs.shape[1]:], skip_special_tokens=True)
    except Exception as exc:  # noqa: BLE001
        return {"check": "generation_smoke", "status": "failed", "error": str(exc)}

    contract = check_recipe_contract(raw)
    return {
        "check": "generation_smoke",
        "status": "ok" if contract["ok"] else "failed",
        "prompt_id": prompt_record["id"],
        "generation_params": generation,
        "raw_output": raw,
        "contract": contract,
        "note": (
            "résultat factuel (JSON strict ou non) — ce n'est PAS une "
            "évaluation de qualité"
        ),
    }


def check_recipe_contract(raw: str) -> dict[str, Any]:
    """Strict recipe-JSON check, mirroring the @leclerc/contracts parser."""
    text = raw.strip()
    issues: list[str] = []
    if text.startswith("```"):
        issues.append("bloc de code Markdown interdit")
    try:
        recipe = json.loads(text)
    except json.JSONDecodeError as exc:
        return {"ok": False, "issues": [f"JSON invalide : {exc}"], "raw": text}

    if not isinstance(recipe, dict):
        return {"ok": False, "issues": ["la racine n'est pas un objet"], "raw": text}
    unknown = set(recipe.keys()) - RECIPE_ALLOWED_ROOT_FIELDS
    if unknown:
        issues.append(f"champs racine interdits : {sorted(unknown)}")
    ingredients = recipe.get("ingredients")
    if not isinstance(ingredients, list) or not ingredients:
        issues.append("ingredients : liste non vide attendue")
    else:
        for ingredient in ingredients:
            if not isinstance(ingredient, dict):
                issues.append("ingrédient non objet")
                continue
            extra = set(ingredient.keys()) - RECIPE_ALLOWED_INGREDIENT_FIELDS
            if extra:
                issues.append(f"champs d'ingrédient interdits : {sorted(extra)}")
            if ingredient.get("unit") not in CONTROLLED_UNITS:
                issues.append(f"unité non contrôlée : {ingredient.get('unit')!r}")
    servings = recipe.get("servings")
    if not isinstance(servings, int) or isinstance(servings, bool) or servings <= 0:
        issues.append("servings : entier strictement positif attendu")
    return {"ok": not issues, "issues": issues, "raw": text}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Vérifications post-export : tokenizer intact, format de prompt "
            "intact, smoke de génération (ticket #55)."
        )
    )
    parser.add_argument("--base-model", required=True,
                        help="modèle de base (id HF ou chemin local)")
    parser.add_argument("--exported", type=Path, required=True,
                        help="répertoire exporté (ONNX + tokenizer)")
    parser.add_argument("--prompts", type=Path,
                        default=Path("training/finetune/prompts_f01.jsonl"))
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args(argv)

    if not args.exported.exists():
        fail(f"répertoire exporté introuvable : {args.exported}", 2)

    transformers = require_transformers()
    prompts = load_prompts(args.prompts)
    prompt_record = prompts[0]

    checks = [
        check_tokenizer(args.base_model, args.exported, transformers),
        check_prompt_format(args.base_model, args.exported, prompt_record, transformers),
        check_generation(args.exported, prompt_record),
    ]

    report = {
        "tool_version": CHECK_TOOL_VERSION,
        "finished_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_model": args.base_model,
        "exported": str(args.exported),
        "checks": checks,
        "all_ok": all(check["status"] == "ok" for check in checks),
        "docs_status": (
            "ces vérifications sont EN ATTENTE D'EXÉCUTION sur la machine de "
            "référence tant qu'aucun export n'a été produit (docs/status.md)"
        ),
    }
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.report_dir / "checks.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"CHECK-EXPORT : {'OK' if report['all_ok'] else 'ÉCHEC'} — rapport : {report_path}")
    return 0 if report["all_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
