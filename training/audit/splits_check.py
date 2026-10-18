#!/usr/bin/env python3
"""Pure disjointness + dedup-before-split verifier (ticket #53, spec #40).

Reads the canonical JSONL split files produced by audit_dataset.py and
verifies, programmatically and OFFLINE:

  1. no duplicate recipe inside a split (exact text and normalized signature);
  2. no test/validation recipe present in train, even reformulated
     (same normalized title, or same normalized ingredient multiset);
  3. no dedup group straddling two splits (dedup BEFORE split, by group);
  4. rejection rules respected: every kept record has a servings value > 0,
     positive quantities and controlled units (mirrors
     packages/contracts/src/recipe-generated.ts GENERATED_RECIPE_UNITS).

The script is deliberately dependency-free (stdlib only) so it can run
anywhere, including in CI. `--self-test` runs the whole battery on a tiny
synthetic fixture embedded below: it needs no network and no dataset.

Exit codes: 0 = all checks pass (or self-test passes); 1 = check failure;
2 = environment/usage error.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

# Mirror of packages/contracts/src/recipe-generated.ts GENERATED_RECIPE_UNITS.
# Never edited without bumping the contracts version it mirrors.
CONTROLLED_UNITS = [
    "g", "kg", "ml", "cl", "l",
    "pièce", "tranche", "sachet", "boîte", "gousse", "pincée",
    "botte", "pot", "cuillère à soupe", "cuillère à café",
]

VERIFIER_VERSION = 1


class VerificationError(Exception):
    """One failed check, with a French human-readable message."""


# ---- normalization (shared with audit_dataset.py) -------------------------------

def strip_accents(text: str) -> str:
    """NFD + drop combining marks: `crème` -> `creme`."""
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def normalize_text(text: str) -> str:
    """Lowercase, accent-free, punctuation-free, whitespace-collapsed text."""
    if text is None:
        return ""
    lowered = strip_accents(text).lower()
    without_punct = re.sub(r"[^\w\s]", " ", lowered, flags=re.UNICODE)
    return re.sub(r"\s+", " ", without_punct).strip()


def normalize_ingredient(ingredient: dict[str, Any]) -> str:
    """Canonical `name|quantity|unit` signature of one ingredient."""
    name = normalize_text(str(ingredient.get("name", "")))
    unit = normalize_text(str(ingredient.get("unit", "")))
    try:
        quantity = float(ingredient.get("quantity"))
    except (TypeError, ValueError):
        quantity = ingredient.get("quantity")
    return f"{name}|{quantity}|{unit}"


def recipe_signature(record: dict[str, Any]) -> dict[str, Any]:
    """Comparable signatures of a recipe: title, ingredient multiset, steps."""
    ingredients = record.get("ingredients") or []
    return {
        "title": normalize_text(str(record.get("title", ""))),
        "ingredients": Counter(
            normalize_ingredient(ing) for ing in ingredients if isinstance(ing, dict)
        ),
        "steps": [
            normalize_text(str(step)) for step in (record.get("steps") or [])
        ],
    }


# ---- record loading ---------------------------------------------------------------

def load_jsonl(path: Path, split_name: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise VerificationError(
                    f"[{split_name}] ligne {line_no} : JSON invalide ({exc})"
                ) from exc
            if not isinstance(record, dict):
                raise VerificationError(
                    f"[{split_name}] ligne {line_no} : enregistrement non objet"
                )
            records.append(record)
    if not records:
        raise VerificationError(f"[{split_name}] aucun enregistrement dans {path}")
    return records


# ---- checks -----------------------------------------------------------------------

def check_no_duplicates(records: list[dict[str, Any]], split_name: str) -> None:
    """No exact duplicate text and no duplicate normalized signature."""
    seen_ids: set[str] = set()
    seen_exact: set[str] = set()
    seen_title_ingredients: set[str] = set()
    for record in records:
        record_id = str(record.get("id", ""))
        if record_id in seen_ids:
            raise VerificationError(
                f"[{split_name}] id dupliqué dans le split : {record_id!r}"
            )
        seen_ids.add(record_id)

        exact = json.dumps(record.get("title", "")) + json.dumps(
            record.get("ingredients", []), sort_keys=True, ensure_ascii=False
        )
        if exact in seen_exact:
            raise VerificationError(
                f"[{split_name}] recette dupliquée (texte exact) : {record_id!r}"
            )
        seen_exact.add(exact)

        signature = recipe_signature(record)
        key = f"{signature['title']}::{sorted(signature['ingredients'].elements())}"
        if key in seen_title_ingredients:
            raise VerificationError(
                f"[{split_name}] recette dupliquée (titre+ingrédients normalisés) : "
                f"{record_id!r}"
            )
        seen_title_ingredients.add(key)


def check_no_reformulated_leak(
    haystack_records: list[dict[str, Any]],
    needle_records: list[dict[str, Any]],
    haystack_name: str,
    needle_name: str,
) -> None:
    """No recipe of `needle_records` inside `haystack_records`, even reformulated.

    Detection: identical normalized title OR identical normalized ingredient
    multiset — a reformulation keeps at least one of the two in practice.
    """
    haystack_titles: set[str] = set()
    haystack_ingredients: set[frozenset] = set()
    for record in haystack_records:
        signature = recipe_signature(record)
        haystack_titles.add(signature["title"])
        haystack_ingredients.add(
            frozenset(signature["ingredients"].elements())
        )
    for record in needle_records:
        signature = recipe_signature(record)
        record_id = str(record.get("id", "<sans id>"))
        if signature["title"] in haystack_titles:
            raise VerificationError(
                f"une recette de {needle_name} ({record_id!r}) figure dans "
                f"{haystack_name} (titre normalisé identique : "
                f"{signature['title']!r})"
            )
        if frozenset(signature["ingredients"].elements()) in haystack_ingredients:
            raise VerificationError(
                f"une recette de {needle_name} ({record_id!r}) figure dans "
                f"{haystack_name} sous une forme reformulée (multiset "
                f"d'ingrédients identique)"
            )


def check_groups_do_not_straddle(
    splits: dict[str, list[dict[str, Any]]],
    groups_path: Path | None,
) -> None:
    """Dedup BEFORE split: a group (recipe + variants) lives in ONE split."""
    group_locations: dict[str, set[str]] = {}
    for split_name, records in splits.items():
        for record in records:
            group_id = record.get("group_id")
            if not group_id:
                raise VerificationError(
                    f"[{split_name}] enregistrement sans group_id "
                    f"({record.get('id', '<sans id>')!r}) — déduplication "
                    f"impossible à vérifier"
                )
            group_locations.setdefault(str(group_id), set()).add(split_name)
    for group_id, locations in sorted(group_locations.items()):
        if len(locations) > 1:
            raise VerificationError(
                f"le groupe {group_id!r} chevauche plusieurs splits : "
                f"{sorted(locations)} — la déduplication doit précéder le découpage"
            )
    if groups_path is not None:
        groups = json.loads(groups_path.read_text(encoding="utf-8"))
        declared = set(groups.get("groups", {}).keys()) if isinstance(groups, dict) else set()
        used = set(group_locations.keys())
        missing = used - declared
        if missing:
            raise VerificationError(
                f"groupes absents du manifeste {groups_path} : {sorted(missing)}"
            )


def check_rejection_rules_respected(records: list[dict[str, Any]], split_name: str) -> None:
    """Kept records must satisfy the acceptance rules (servings, quantities, units)."""
    for record in records:
        record_id = str(record.get("id", "<sans id>"))
        servings = record.get("servings")
        if not isinstance(servings, int) or isinstance(servings, bool) or servings <= 0:
            raise VerificationError(
                f"[{split_name}] {record_id!r} : portions absentes ou invalides "
                f"({servings!r}) — règle de rejet non appliquée"
            )
        ingredients = record.get("ingredients") or []
        if not ingredients:
            raise VerificationError(
                f"[{split_name}] {record_id!r} : liste d'ingrédients vide"
            )
        for ingredient in ingredients:
            if not isinstance(ingredient, dict):
                raise VerificationError(
                    f"[{split_name}] {record_id!r} : ingrédient non objet"
                )
            try:
                quantity = float(ingredient.get("quantity"))
            except (TypeError, ValueError):
                raise VerificationError(
                    f"[{split_name}] {record_id!r} : quantité non numérique "
                    f"({ingredient.get('quantity')!r}) — conversion non fiable, "
                    f"aurait dû être rejetée"
                ) from None
            if quantity <= 0:
                raise VerificationError(
                    f"[{split_name}] {record_id!r} : quantité non positive "
                    f"({quantity})"
                )
            unit = ingredient.get("unit")
            if unit not in CONTROLLED_UNITS:
                raise VerificationError(
                    f"[{split_name}] {record_id!r} : unité non contrôlée "
                    f"({unit!r}) — aurait dû être rejetée ou convertie de façon fiable"
                )
        if not (record.get("steps") or []):
            raise VerificationError(
                f"[{split_name}] {record_id!r} : étapes absentes (recette incomplète)"
            )


def verify_splits(
    train: list[dict[str, Any]],
    validation: list[dict[str, Any]],
    test: list[dict[str, Any]],
    groups_path: Path | None = None,
) -> None:
    """Full battery. Raises VerificationError on the FIRST failed check."""
    for split_name, records in (
        ("train", train), ("validation", validation), ("test", test),
    ):
        check_no_duplicates(records, split_name)
        check_rejection_rules_respected(records, split_name)
    check_no_reformulated_leak(train, validation, "train", "validation")
    check_no_reformulated_leak(train, test, "train", "test")
    check_no_reformulated_leak(validation, test, "validation", "test")
    check_groups_do_not_straddle(
        {"train": train, "validation": validation, "test": test}, groups_path
    )


# ---- self-test --------------------------------------------------------------------

def _fixture_record(
    record_id: str,
    group_id: str,
    title: str,
    servings: int,
    ingredients: list[tuple[str, float, str]],
    steps: list[str],
) -> dict[str, Any]:
    return {
        "id": record_id,
        "group_id": group_id,
        "title": title,
        "servings": servings,
        "ingredients": [
            {"name": name, "quantity": quantity, "unit": unit}
            for name, quantity, unit in ingredients
        ],
        "steps": steps,
    }


def _write_fixture(dir_path: Path, name: str, records: list[dict[str, Any]]) -> Path:
    path = dir_path / f"{name}.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path


def self_test() -> int:
    """Offline battery on a tiny synthetic fixture — must all pass."""
    failures: list[str] = []

    curry = _fixture_record(
        "r1", "g-curry", "Poulet au curry", 4,
        [("filets de poulet", 800, "g"), ("lait de coco", 400, "ml")],
        ["Découper le poulet.", "Mijoter 20 minutes."],
    )
    # Same recipe, reformulated title (accent + casing + punctuation drift).
    curry_variant = _fixture_record(
        "r2", "g-curry", "Poulet au Curry !", 4,
        [("Filets de poulet", 800, "g"), ("Lait de coco", 40, "cl")],
        ["Découper le poulet en morceaux.", "Mijoter vingt minutes."],
    )
    dahl = _fixture_record(
        "r3", "g-dahl", "Dahl de lentilles", 4,
        [("lentilles corail", 300, "g"), ("lait de coco", 200, "ml")],
        ["Rincer les lentilles.", "Cuire 25 minutes."],
    )
    tarte = _fixture_record(
        "r4", "g-tarte", "Tarte aux pommes", 6,
        [("pommes", 1, "kg"), ("pâte brisée", 1, "pièce")],
        ["Éplucher les pommes.", "Cuire 40 minutes."],
    )
    soupe = _fixture_record(
        "r5", "g-soupe", "Soupe de potimarron", 4,
        [("potimarron", 1, "kg"), ("crème fraîche", 10, "cl")],
        ["Découper le potimarron.", "Mixer."],
    )
    gratin = _fixture_record(
        "r6", "g-gratin", "Gratin de pommes de terre", 4,
        [("pommes de terre", 1, "kg"), ("crème fraîche", 20, "cl")],
        ["Trancher les pommes de terre.", "Cuire 45 minutes."],
    )
    # Variant of dahl that neither the title check nor the ingredient-multiset
    # check can see: only the dedup group manifests it (group_id g-dahl).
    dahl_variant = _fixture_record(
        "r7", "g-dahl", "Lentilles à la coco", 4,
        [("lentilles corail", 250, "g"), ("lait de coco", 200, "ml")],
        ["Rincer les lentilles.", "Cuire douze minutes."],
    )
    # Same ingredients as curry, different title: multiset-leak detector only.
    curry_reformulated = _fixture_record(
        "r8", "g-curry-maison", "Curry de poulet maison", 4,
        [("filets de poulet", 800, "g"), ("lait de coco", 400, "ml")],
        ["Découper le poulet.", "Mijoter vingt minutes."],
    )

    def run_case(label: str, fn) -> None:
        try:
            fn()
            failures.append(f"{label} : aucune erreur détectée (attendu : échec)")
        except VerificationError:
            pass  # expected

    # Case 1: clean fixture passes every check.
    try:
        verify_splits([dahl, tarte], [soupe], [curry])
    except VerificationError as exc:
        failures.append(f"fixture saine rejetée à tort : {exc}")

    # Case 2: reformulated test recipe leaking into train (title detection).
    run_case(
        "fuite reformulée dans train (titre)",
        lambda: verify_splits(
            [dahl, tarte, curry_variant], [soupe], [curry]
        ),
    )

    # Case 2b: leak detectable only by the ingredient multiset.
    run_case(
        "fuite reformulée dans train (multiset d'ingrédients)",
        lambda: verify_splits(
            [dahl, tarte, curry_reformulated], [soupe], [curry]
        ),
    )

    # Case 3: duplicate inside one split.
    run_case(
        "doublon dans train",
        lambda: verify_splits(
            [dahl, tarte, dict(dahl)], [soupe], [curry]
        ),
    )

    # Case 4: dedup group straddling splits — only the group check can see it.
    run_case(
        "groupe à cheval sur deux splits",
        lambda: verify_splits(
            [dahl, tarte, curry], [soupe, dahl_variant], [gratin]
        ),
    )

    # Case 5: record with missing servings must be rejected (rejection rules).
    no_servings = {**curry, "servings": None}
    run_case(
        "portions absentes non rejetées",
        lambda: verify_splits([dahl, tarte, no_servings], [soupe], [curry]),
    )

    # Case 6: uncontrolled unit must be rejected.
    bad_unit = {
        **dahl,
        "ingredients": [{"name": "lentilles corail", "quantity": 300, "unit": "tasses"}],
    }
    run_case(
        "unité non contrôlée non rejetée",
        lambda: verify_splits([bad_unit, tarte], [soupe], [curry]),
    )

    # Case 7: same title in two splits (title leak across splits).
    same_title = {
        **dahl,
        "id": "r9",
        "ingredients": [{"name": "lentilles vertes", "quantity": 300, "unit": "g"}],
    }
    run_case(
        "fuite par titre identique entre splits",
        lambda: verify_splits([dahl, tarte, curry], [soupe, same_title], [gratin]),
    )

    # Case 8: full CLI round trip on files (groups manifest check included).
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        train_path = _write_fixture(tmp_path, "train", [dahl, tarte])
        validation_path = _write_fixture(tmp_path, "validation", [soupe])
        test_path = _write_fixture(tmp_path, "test", [curry])
        groups_path = tmp_path / "groups.json"
        groups_path.write_text(
            json.dumps(
                {
                    "groups": {
                        record["group_id"]: {"representative": record["id"]}
                        for record in (dahl, tarte, soupe, curry)
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        try:
            verify_splits(
                load_jsonl(train_path, "train"),
                load_jsonl(validation_path, "validation"),
                load_jsonl(test_path, "test"),
                groups_path,
            )
        except VerificationError as exc:
            failures.append(f"round trip sur fichiers rejeté à tort : {exc}")
        # A group missing from the manifest must fail.
        bad_groups_path = tmp_path / "bad_groups.json"
        bad_groups_path.write_text(json.dumps({"groups": {}}), encoding="utf-8")
        run_case(
            "groupe absent du manifeste non détecté",
            lambda: verify_splits(
                load_jsonl(train_path, "train"),
                load_jsonl(validation_path, "validation"),
                load_jsonl(test_path, "test"),
                bad_groups_path,
            ),
        )

    if failures:
        print("SELF-TEST : ÉCHEC")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("SELF-TEST : OK — toutes les vérifications détectent ce qu'elles doivent détecter.")
    return 0


# ---- CLI --------------------------------------------------------------------------

def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Vérificateur de disjonction et de déduplication-avant-découpage "
            "pour les splits du dataset de recettes (ticket #53)."
        )
    )
    parser.add_argument("--train", type=Path, help="splits/train.jsonl")
    parser.add_argument("--validation", type=Path, help="splits/validation.jsonl")
    parser.add_argument("--test", type=Path, help="splits/test.jsonl")
    parser.add_argument("--groups", type=Path, help="manifeste des groupes (optionnel)")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="batterie autonome hors ligne sur une fixture synthétique minuscule",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.self_test:
        return self_test()

    if not (args.train and args.validation and args.test):
        parser.error(
            "fournir --train, --validation et --test, ou utiliser --self-test"
        )
        return 2

    try:
        verify_splits(
            load_jsonl(args.train, "train"),
            load_jsonl(args.validation, "validation"),
            load_jsonl(args.test, "test"),
            args.groups,
        )
    except VerificationError as exc:
        print(f"VÉRIFICATION : ÉCHEC — {exc}", file=sys.stderr)
        return 1
    print("VÉRIFICATION : OK — splits disjoints, dédupliqués avant découpage, règles de rejet respectées.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
