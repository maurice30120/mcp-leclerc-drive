#!/usr/bin/env python3
"""Dataset audit for the « French Recipe » Hugging Face dataset (ticket #53).

Pipeline (order matters):

  1. Metadata verification — exact repo id, license, volume, revision are
     READ from the Hugging Face API and the dataset builder. NEVER invented:
     if any of them cannot be verified, the script fails loudly (exit 3).
  2. Schema exploration — columns, types, encoding issues, duplicates,
     incomplete recipes, units inventory, servings distribution.
  3. Rejection rules — records with missing/unparseable servings, or with
     quantities/units that cannot be converted RELIABLY to the controlled
     unit set are rejected, with an explicit provenance note for each.
  4. Deduplication BEFORE splitting — records are grouped by normalized
     title OR normalized ingredient multiset (reformulations collapse).
  5. Split builder — groups (not records) are split train/validation/test
     with a seeded shuffle, so no variant can straddle two splits.
  6. Programmatic verification — the resulting splits are checked with
     splits_check.verify_splits (disjoint even when reformulated).

Requires the network. Dependencies (huggingface_hub, datasets) are imported
lazily so the failure message is actionable. Outputs go to UNTRACKED
directories: training/audit/out/ (stats + provenance + rejections) and
training/data/splits/ (canonical splits + groups manifest).

Exit codes: 0 ok; 2 environment/usage; 3 metadata unverifiable;
4 schema/mapping failure; 1 verification failed.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, NoReturn

# Same-directory import: the verifier owns the shared normalization helpers.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from splits_check import (  # noqa: E402
    CONTROLLED_UNITS,
    VERIFIER_VERSION,
    normalize_text,
    recipe_signature,
    verify_splits,
)

AUDIT_TOOL_VERSION = 1

# Safe unit canonicalization ONLY: textual variants of controlled units.
# Anything not in this map is NOT converted (unreliable conversion => reject).
UNIT_CANONICALIZATION = {
    "gramme": "g", "grammes": "g", "gr": "g",
    "kilogramme": "kg", "kilogrammes": "kg",
    "millilitre": "ml", "millilitres": "ml",
    "centilitre": "cl", "centilitres": "cl",
    "litre": "l", "litres": "l",
    "piece": "pièce", "pieces": "pièce",
    "tranches": "tranche", "sachets": "sachet", "boites": "boîte",
    "bte": "boîte", "gousses": "gousse", "pincees": "pincée",
    "bottes": "botte", "pots": "pot",
    "cuillere a soupe": "cuillère à soupe",
    "cuillere a cafe": "cuillère à café",
    "cas": "cuillère à soupe", "cac": "cuillère à café",
}

FIELD_CANDIDATES = {
    "title": ["title", "name", "recipe_name", "recipe", "nom", "recette"],
    "servings": ["servings", "portions", "nb_servings", "nb_personnes",
                 "n_personnes", "yield", "personnes"],
    "ingredients": ["ingredients", "ingredient_list", "ingredients_list",
                    "ingredients_text", "ingridients"],
    "steps": ["steps", "instructions", "instructions_list",
              "instructions_text", "method", "preparation", "etapes"],
}

QUANTITY_RE = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?)\s*([a-zàâçéèêëîïôùûüœ' ]+?)?\s*(?:de\s+|d')?\s*(.+?)\s*$",
    re.IGNORECASE,
)


class AuditError(Exception):
    """Fatal audit failure — French message, nothing is invented."""


def fail(message: str, code: int) -> NoReturn:
    print(f"AUDIT : ÉCHEC — {message}", file=sys.stderr)
    sys.exit(code)


def require_dependencies() -> tuple[Any, Any]:
    try:
        import datasets  # type: ignore
        import huggingface_hub  # type: ignore
    except ImportError:
        fail(
            "dépendances absentes (huggingface_hub, datasets). Installer "
            "training/requirements.txt dans un environnement dédié — "
            "aucun pip install n'est fait par ce script.",
            2,
        )
    return datasets, huggingface_hub


def fetch_verified_metadata(
    huggingface_hub: Any, datasets: Any, repo_id: str
) -> dict[str, Any]:
    """Read id, license, volume, revision from the source — never invent."""
    api = huggingface_hub.HfApi()
    try:
        info = api.dataset_info(repo_id)
    except Exception as exc:  # noqa: BLE001 — surface the raw API failure
        fail(f"dépôt {repo_id!r} inaccessible ou inexistant : {exc}", 3)

    if info.id != repo_id:
        fail(
            f"identifiant divergent : demandé {repo_id!r}, réel {info.id!r} — "
            f"aucune valeur inventée, l'identifiant exact doit être confirmé.",
            3,
        )

    license_tags = [
        tag.split(":", 1)[1] for tag in (info.tags or []) if tag.startswith("license:")
    ]
    card_license = None
    card_data = getattr(info, "card_data", None)
    if isinstance(card_data, dict):
        card_license = card_data.get("license")
    elif card_data is not None:
        card_license = getattr(card_data, "license", None)
    if not license_tags and not card_license:
        fail(
            "licence du dataset NON VÉRIFIABLE sur le dépôt — impossible de "
            "documenter les obligations de redistribution sans elle "
            "(ticket #53). Rien n'est supposé.",
            3,
        )

    try:
        builder = datasets.load_dataset_builder(repo_id)
        builder_info = builder.info
    except Exception as exc:  # noqa: BLE001
        fail(f"schéma du dataset illisible : {exc}", 4)

    splits_info = getattr(builder_info, "splits", None)
    volume: dict[str, int] = {}
    if splits_info:
        for split_name, split_info in splits_info.items():
            num_examples = getattr(split_info, "num_examples", None)
            if num_examples is None:
                fail(
                    f"volume NON VÉRIFIABLE pour le split {split_name} "
                    f"(num_examples absent) — aucune estimation inventée.",
                    3,
                )
            volume[str(split_name)] = int(num_examples)
    if not volume:
        fail("volume du dataset NON VÉRIFIABLE (aucun split décrit) — abandon.", 3)

    return {
        "repo_id": info.id,
        "revision": info.sha,
        "license": card_license or license_tags[0],
        "license_sources": {
            "card_data": card_license,
            "tags": license_tags,
        },
        "volume_rows_per_split": volume,
        "features": {
            name: str(feature)
            for name, feature in (getattr(builder_info, "features", None) or {}).items()
        },
        "private": bool(getattr(info, "private", False)),
        "downloads": getattr(info, "downloads", None),
    }


def detect_field_map(features: dict[str, Any]) -> dict[str, str]:
    """Auto-detect the recipe field mapping; fail loudly on ambiguity."""
    mapping: dict[str, str] = {}
    for field, candidates in FIELD_CANDIDATES.items():
        normalized_columns = {normalize_text(name): name for name in features}
        matches = [
            normalized_columns[normalize_text(candidate)]
            for candidate in candidates
            if normalize_text(candidate) in normalized_columns
        ]
        if len(matches) == 1:
            mapping[field] = matches[0]
        elif len(matches) > 1:
            fail(
                f"colonne ambiguë pour {field!r} : {matches} — fournir "
                f"--field-map avec un mappage explicite {{\"{field}\": \"...\"}}.",
                4,
            )
    return mapping


def resolve_field_map(
    features: dict[str, Any], field_map_path: Path | None
) -> dict[str, str]:
    if field_map_path is not None:
        mapping = json.loads(field_map_path.read_text(encoding="utf-8"))
        missing = [f for f in FIELD_CANDIDATES if f not in mapping]
        if missing:
            fail(f"--field-map incomplet, champs manquants : {missing}", 2)
        unknown = [c for c in mapping.values() if c not in features]
        if unknown:
            fail(f"--field-map : colonnes absentes du dataset : {unknown}", 4)
        return {str(k): str(v) for k, v in mapping.items()}
    mapping = detect_field_map(features)
    missing = [f for f in FIELD_CANDIDATES if f not in mapping]
    if missing:
        fail(
            f"détection automatique incomplète pour : {missing} — colonnes "
            f"disponibles : {sorted(features)} — fournir --field-map explicite.",
            4,
        )
    return mapping


def parse_servings(raw: Any) -> int | None:
    """Best-effort strict parse: '4', 4, '4 personnes' -> 4; else None."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int) and raw > 0:
        return raw
    if isinstance(raw, float) and raw > 0 and float(raw).is_integer():
        return int(raw)
    if isinstance(raw, str):
        match = re.search(r"\d+", raw)
        if match:
            value = int(match.group(0))
            return value if value > 0 else None
    return None


def parse_ingredient(raw: Any) -> dict[str, Any] | None:
    """Parse one ingredient into {name, quantity, unit} or None if unreliable.

    Structured rows are used as-is (after safe unit canonicalization); free
    text is parsed ONLY when a quantity and a controlled unit are explicit.
    No conversion is guessed: anything ambiguous is rejected upstream.
    """
    if isinstance(raw, dict):
        name = str(raw.get("name", "")).strip()
        unit = normalize_text(str(raw.get("unit", "")))
        try:
            quantity = float(raw.get("quantity"))
        except (TypeError, ValueError):
            return None
        if not name or quantity <= 0:
            return None
        canonical = UNIT_CANONICALIZATION.get(unit)
        if canonical is not None:
            return {"name": name, "quantity": quantity, "unit": canonical}
        if unit in CONTROLLED_UNITS:
            return {"name": name, "quantity": quantity, "unit": unit}
        return None  # unreliable/uncontrolled unit: never converted by guess

    if not isinstance(raw, str) or not raw.strip():
        return None
    match = QUANTITY_RE.match(raw.strip())
    if not match:
        return None
    quantity_text, unit_text, name = match.groups()
    if not name:
        return None
    try:
        quantity = float(quantity_text.replace(",", "."))
    except ValueError:
        return None
    if quantity <= 0:
        return None
    unit_norm = normalize_text(unit_text or "")
    canonical = UNIT_CANONICALIZATION.get(unit_norm)
    if canonical is None and unit_norm not in CONTROLLED_UNITS:
        return None  # e.g. "2 boîtes de conserve", "une tasse": unreliable
    return {
        "name": name.strip(),
        "quantity": quantity,
        "unit": canonical if canonical is not None else unit_norm,
    }


def canonicalize_record(
    row: dict[str, Any], row_index: int, field_map: dict[str, str]
) -> tuple[dict[str, Any] | None, str | None]:
    """Return (canonical_record, None) or (None, french_rejection_reason)."""
    title_raw = row.get(field_map["title"])
    if not isinstance(title_raw, str) or not title_raw.strip():
        return None, "titre absent ou vide"
    title = title_raw.strip()

    servings = parse_servings(row.get(field_map["servings"]))
    if servings is None:
        return None, "portions absentes ou non parsables de façon fiable"

    ingredients_raw = row.get(field_map["ingredients"])
    if not isinstance(ingredients_raw, list) or not ingredients_raw:
        return None, "liste d'ingrédients absente ou vide"
    ingredients: list[dict[str, Any]] = []
    for item in ingredients_raw:
        parsed = parse_ingredient(item)
        if parsed is None:
            return None, (
                "ingrédient à quantité/unité non fiable (rejet : "
                "conversion non garantie)"
            )
        ingredients.append(parsed)

    steps_raw = row.get(field_map["steps"])
    if isinstance(steps_raw, str):
        steps = [s.strip() for s in re.split(r"\s*\n+\s*|(?<=\.)\s{2,}", steps_raw) if s.strip()]
    elif isinstance(steps_raw, list):
        steps = [str(s).strip() for s in steps_raw if str(s).strip()]
    else:
        steps = []
    if not steps:
        return None, "étapes absentes ou vides (recette incomplète)"

    return {
        "id": f"row-{row_index:06d}",
        "title": title,
        "servings": servings,
        "ingredients": ingredients,
        "steps": steps,
    }, None


def dedup_groups(records: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Group records by normalized title OR identical ingredient multiset.

    Union-find over two signature keys so reformulations/variants collapse
    into ONE group. Dedup happens BEFORE any split is drawn.
    """
    parent: dict[str, str] = {}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for record in records:
        parent[record["id"]] = record["id"]

    title_index: dict[str, str] = {}
    ingredients_index: dict[frozenset, str] = {}
    for record in records:
        signature = recipe_signature(record)
        if signature["title"]:
            title_index.setdefault(signature["title"], record["id"])
            union(title_index[signature["title"]], record["id"])
        ingredient_set = frozenset(signature["ingredients"].elements())
        if ingredient_set:
            ingredients_index.setdefault(ingredient_set, record["id"])
            union(ingredients_index[ingredient_set], record["id"])

    groups: dict[str, list[str]] = {}
    for record in records:
        groups.setdefault(find(record["id"]), []).append(record["id"])
    return groups


def build_splits(
    representatives: list[dict[str, Any]], groups: dict[str, list[str]],
    ratios: tuple[float, float, float], seed: int,
) -> dict[str, list[dict[str, Any]]]:
    """Split GROUPS (never records) with a seeded shuffle.

    Only one representative per dedup group enters the splits; the group
    membership is preserved in each record's `group_id`.
    """
    rep_by_group: dict[str, dict[str, Any]] = {}
    for record in representatives:
        group_id = next(
            gid for gid, members in groups.items() if record["id"] in members
        )
        rep_by_group[group_id] = record

    group_ids = sorted(rep_by_group.keys())
    rng = random.Random(seed)
    rng.shuffle(group_ids)

    train_ratio, valid_ratio, _ = ratios
    n_train = int(round(len(group_ids) * train_ratio))
    n_valid = int(round(len(group_ids) * valid_ratio))
    buckets: dict[str, list[str]] = {"train": [], "validation": [], "test": []}
    for index, group_id in enumerate(group_ids):
        if index < n_train:
            buckets["train"].append(group_id)
        elif index < n_train + n_valid:
            buckets["validation"].append(group_id)
        else:
            buckets["test"].append(group_id)

    splits: dict[str, list[dict[str, Any]]] = {}
    for split_name, split_group_ids in buckets.items():
        splits[split_name] = []
        for group_id in sorted(split_group_ids):
            record = dict(rep_by_group[group_id])
            record["group_id"] = group_id
            splits[split_name].append(record)
    return splits


def build_sft_example(
    record: dict[str, Any], system_prompt: str
) -> dict[str, Any]:
    """One SFT example: instruction -> strict recipe JSON.

    The instruction is a deterministic template over VERIFIED fields (title,
    servings); the target is the canonical recipe itself — no ground truth
    is invented. The target JSON respects the generated-recipe contract
    (allowlist fields, controlled units) because rejection rules ran first.
    """
    recipe_json = json.dumps(
        {
            "title": record["title"],
            "servings": record["servings"],
            "ingredients": record["ingredients"],
            "steps": record["steps"],
        },
        ensure_ascii=False,
    )
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    f"Propose une recette de « {record['title']} » pour "
                    f"{record['servings']} personnes, au format JSON strict."
                ),
            },
            {"role": "assistant", "content": recipe_json},
        ]
    }


def load_system_prompt(system_prompt_path: Path) -> str:
    """Read the frozen recipe system prompt from prompts_f01.jsonl.

    Single source of truth: the harness constant (byte-identical extraction).
    Fails loudly rather than embedding a possibly divergent copy.
    """
    if not system_prompt_path.exists():
        fail(
            f"{system_prompt_path} introuvable — le prompt système figé est "
            f"requis pour construire les exemples SFT ; relancer "
            f"training/finetune/gen_prompts_f01.mjs.",
            2,
        )
    first = json.loads(
        system_prompt_path.read_text(encoding="utf-8").splitlines()[0]
    )
    system = first.get("system")
    if not isinstance(system, str) or not system.strip():
        fail("prompt système absent de prompts_f01.jsonl", 2)
    return system


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Audit du dataset « French Recipe » (HF) : métadonnées vérifiées, "
            "schéma, rejets tracés, déduplication AVANT découpage, splits "
            "disjoints vérifiés (ticket #53)."
        )
    )
    parser.add_argument(
        "--repo-id", required=True,
        help="identifiant EXACT du dataset Hugging Face (jamais deviné)",
    )
    parser.add_argument(
        "--split", default="train",
        help="nom du split HF à auditer (défaut : train)",
    )
    parser.add_argument(
        "--max-records", type=int, default=500,
        help="taille de l'échantillon contrôlé avant le dataset complet",
    )
    parser.add_argument(
        "--full", action="store_true",
        help="auditer/découper le dataset COMPLET (ne pas se limiter à l'échantillon)",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--ratios", default="0.8,0.1,0.1")
    parser.add_argument("--field-map", type=Path, default=None)
    parser.add_argument(
        "--system-prompt-file", type=Path,
        default=Path("training/finetune/prompts_f01.jsonl"),
        help="source du prompt système figé (identité octet par octet avec le harnais)",
    )
    parser.add_argument("--data-dir", type=Path, default=Path("training/data"))
    parser.add_argument("--out-dir", type=Path, default=Path("training/audit/out"))
    args = parser.parse_args(argv)

    datasets, huggingface_hub = require_dependencies()

    try:
        parsed_ratios = tuple(float(x) for x in args.ratios.split(","))
    except ValueError:
        fail("--ratios doit être trois nombres, ex. 0.8,0.1,0.1", 2)
    if len(parsed_ratios) != 3 or abs(sum(parsed_ratios) - 1.0) > 1e-6:
        fail("--ratios doit contenir trois nombres sommant à 1", 2)
    ratios = parsed_ratios  # type: ignore[assignment]

    fetched_at = datetime.now(timezone.utc).isoformat()
    metadata = fetch_verified_metadata(huggingface_hub, datasets, args.repo_id)

    if args.split not in metadata["volume_rows_per_split"]:
        fail(
            f"split {args.split!r} absent du dataset "
            f"(splits réels : {sorted(metadata['volume_rows_per_split'])})",
            4,
        )

    field_map = resolve_field_map(metadata["features"], args.field_map)

    # ---- sample / full iteration --------------------------------------------
    try:
        stream = datasets.load_dataset(
            args.repo_id, split=args.split, streaming=True
        )
        rows: Iterator[dict[str, Any]] = iter(stream)
        limit = None if args.full else args.max_records
        collected: list[dict[str, Any]] = []
        encoding_issues = 0
        for row in rows:
            if limit is not None and len(collected) >= limit:
                break
            for value in row.values():
                if isinstance(value, str) and "\ufffd" in value:
                    encoding_issues += 1
            collected.append(dict(row))
    except Exception as exc:  # noqa: BLE001
        fail(f"lecture du dataset impossible : {exc}", 3)

    if not collected:
        fail("aucune ligne lue — abandon (aucune statistique inventée)", 3)

    # ---- canonicalization + rejection rules ----------------------------------
    accepted: list[dict[str, Any]] = []
    rejections: list[dict[str, Any]] = []
    rejection_counts: Counter[str] = Counter()
    for index, row in enumerate(collected):
        record, reason = canonicalize_record(row, index, field_map)
        if record is None:
            rejection_counts[reason] += 1
            rejections.append(
                {
                    "row_index": index,
                    "rule": reason,
                    "provenance": {
                        "repo_id": metadata["repo_id"],
                        "revision": metadata["revision"],
                        "split": args.split,
                        "source_row": index,
                    },
                }
            )
        else:
            accepted.append(record)

    if not accepted:
        fail("toutes les lignes de l'échantillon ont été rejetées — vérifier le mappage de champs", 4)

    # ---- schema stats ---------------------------------------------------------
    units_inventory: Counter[str] = Counter()
    servings_distribution: Counter[int] = Counter()
    for record in accepted:
        servings_distribution[record["servings"]] += 1
        for ingredient in record["ingredients"]:
            units_inventory[ingredient["unit"]] += 1
    duplicate_exact = len(accepted) - len(
        {json.dumps(r, sort_keys=True, ensure_ascii=False) for r in accepted}
    )

    # ---- dedup BEFORE split ---------------------------------------------------
    groups = dedup_groups(accepted)
    groups_manifest = {
        "group_id": {
            "members": member_ids,
            "representative": sorted(member_ids)[0],
        }
        for group_id, member_ids in groups.items()
    }
    representatives = [
        next(r for r in accepted if r["id"] == sorted(ids)[0])
        for ids in groups.values()
    ]

    splits = build_splits(representatives, groups, ratios, args.seed)

    # ---- programmatic verification (fail loudly, never trust the builder) -----
    try:
        verify_splits(splits["train"], splits["validation"], splits["test"])
    except Exception as exc:  # noqa: BLE001 — VerificationError surfaced as-is
        fail(f"vérification de disjonction ÉCHOUÉE : {exc}", 1)

    # ---- outputs (untracked dirs) ---------------------------------------------
    splits_dir = args.data_dir / "splits"
    splits_dir.mkdir(parents=True, exist_ok=True)
    for split_name, records in splits.items():
        with (splits_dir / f"{split_name}.jsonl").open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    (splits_dir / "groups.json").write_text(
        json.dumps(
            {
                "seed": args.seed,
                "ratios": list(ratios),
                "groups": groups_manifest,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    # ---- SFT examples (instruction -> recipe JSON, deterministic template) ----
    system_prompt = load_system_prompt(args.system_prompt_file)
    sft_dir = args.data_dir / "sft"
    sft_dir.mkdir(parents=True, exist_ok=True)
    for split_name, records in splits.items():
        with (sft_dir / f"{split_name}.jsonl").open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(
                    json.dumps(
                        build_sft_example(record, system_prompt),
                        ensure_ascii=False,
                    )
                    + "\n"
                )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stats = {
        "tool_version": AUDIT_TOOL_VERSION,
        "mode": "full" if args.full else "sample",
        "metadata": metadata,
        "sample": {
            "requested": None if args.full else args.max_records,
            "collected_rows": len(collected),
            "encoding_issues": encoding_issues,
            "duplicate_exact_texts": duplicate_exact,
            "servings_distribution": dict(servings_distribution.most_common()),
            "units_inventory": dict(units_inventory.most_common()),
            "accepted_records": len(accepted),
        },
        "rejections": {
            "total": len(rejections),
            "per_rule": dict(rejection_counts.most_common()),
        },
        "dedup": {
            "groups": len(groups),
            "variants_collapsed": len(accepted) - len(groups),
        },
        "splits": {
            name: {
                "records": len(records),
                "groups": len({r["group_id"] for r in records}),
            }
            for name, records in splits.items()
        },
        "sft_examples": {
            "format": "messages (system/user/assistant), mlx-lm compatible",
            "system_prompt_source": str(args.system_prompt_file),
            "instruction_template": (
                "dérivé uniquement des champs vérifiés (titre, portions) — "
                "aucune vérité terrain fabriquée"
            ),
            "counts": {
                name: len(records) for name, records in splits.items()
            },
        },
        "verification": {
            "verifier_version": VERIFIER_VERSION,
            "disjoint_even_reformulated": True,
            "dedup_before_split": True,
        },
        "caveat": (
            "Splits issus d'un ÉCHANTILLON contrôlé (--max-records) : usage "
            "smoke uniquement. Le découpage final exige --full."
            if not args.full
            else "Découpage sur le dataset complet."
        ),
    }
    (args.out_dir / "stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with (args.out_dir / "rejections.jsonl").open("w", encoding="utf-8") as handle:
        for rejection in rejections:
            handle.write(json.dumps(rejection, ensure_ascii=False) + "\n")

    provenance = {
        "repo_id": metadata["repo_id"],
        "revision": metadata["revision"],
        "license": metadata["license"],
        "fetched_at_utc": fetched_at,
        "tool_versions": {
            "audit_tool": AUDIT_TOOL_VERSION,
            "verifier": VERIFIER_VERSION,
            "python": sys.version.split()[0],
            "huggingface_hub": getattr(huggingface_hub, "__version__", "inconnue"),
            "datasets": getattr(datasets, "__version__", "inconnue"),
        },
        "field_map": field_map,
        "field_map_source": (
            str(args.field_map) if args.field_map else "détection automatique (validée)"
        ),
        "seed": args.seed,
        "ratios": list(ratios),
        "rejection_rules": [
            "titre absent ou vide",
            "portions absentes ou non parsables de façon fiable",
            "liste d'ingrédients absente ou vide",
            "ingrédient à quantité/unité non fiable (rejet : conversion non garantie)",
            "étapes absentes ou vides (recette incomplète)",
        ],
        "dedup_policy": (
            "regroupement par titre normalisé OU multiset d'ingrédients "
            "normalisé ; découpage par GROUPE, déduplication AVANT découpage"
        ),
    }
    (args.out_dir / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"AUDIT : OK — {len(accepted)} recettes acceptées, "
          f"{len(groups)} groupes, {len(rejections)} rejets tracés.")
    print(f"Sorties : {args.out_dir}/stats.json, provenance.json, rejections.jsonl ; "
          f"splits dans {splits_dir}/ ; exemples SFT dans {sft_dir}/")
    print("Relancer training/audit/splits_check.py sur les splits pour la vérification autonome.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
