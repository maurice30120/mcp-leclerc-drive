# Tableau d'état honnête du pipeline (tickets #53, #54, #55)

Dernière mise à jour : 2026-10-18 (scaffolding). **Aucune étape ci-dessous
n'a été exécutée.** Les scripts existent, compilent, et le vérificateur de
splits passe son self-test hors ligne ; tout le reste attend la machine de
référence (Apple Silicon), le réseau et les identifiants. Aucun résultat
n'a été fabriqué pour combler les cases « en attente ».

| Étape | Script | Statut | Bloqué par |
|---|---|---|---|
| Audit métadonnées + schéma du dataset HF | `audit/audit_dataset.py` | **EN ATTENTE D'EXÉCUTION** | réseau + identifiant exact du dépôt + `pip install` (aucun install effectué) |
| Rejets + déduplication + splits disjoints | `audit/audit_dataset.py` | **EN ATTENTE D'EXÉCUTION** | idem (nécessite l'audit ci-dessus) |
| Vérificateur de splits (self-test hors ligne) | `audit/splits_check.py --self-test` | **EXÉCUTÉ — OK** (aucune dépendance, hors ligne) | — |
| Exemples SFT instruction → JSON | `audit/audit_dataset.py` | **EN ATTENTE D'EXÉCUTION** | dépend de l'audit du dataset |
| Gate : base prouvée ONNX/WebGPU (POC #47) | — | **EN ATTENTE D'EXÉCUTION** | Mac de référence + Chrome + harnais Node |
| Smoke train LoRA (mlx-lm) | `finetune/lora_smoke_train.py` | **EN ATTENTE D'EXÉCUTION** | gate POC #47 + mlx/mlx-lm + données SFT |
| Vérification de reprise (--resume) | `finetune/lora_smoke_train.py` | **EN ATTENTE D'EXÉCUTION** | idem |
| Comparaison baseline vs LoRA (F01) | `finetune/gen_compare.py` | **EN ATTENTE D'EXÉCUTION** | adaptateur issu d'un run réel |
| Fusion LoRA → HF (mlx_lm.fuse) | `export/export_onnx.py` | **EN ATTENTE D'EXÉCUTION** | adaptateur + mlx-lm |
| Export ONNX (optimum) | `export/export_onnx.py` | **EN ATTENTE D'EXÉCUTION** | fusion réussie + optimum |
| Quantification int8 | `export/export_onnx.py` | **EN ATTENTE D'EXÉCUTION** | export ONNX réussi |
| Vérifs post-export (tokenizer, prompt, génération) | `export/check_export.py` | **EN ATTENTE D'EXÉCUTION** | export réel sur la machine de référence |
| Gate Chrome/WebGPU | procédure manuelle (docs/export-chain.md) | **NON FRANCHIE** | preuve expérimentale requise |
| Publication Hugging Face | `export/export_onnx.py --step publish` | **REFUSÉE tant que l'audit de licence n'est pas produit** | audit de licence (dataset + modèle de base) + HF_TOKEN |

## Ce qui est vérifié à ce jour

- `python3 -m py_compile` passe sur tous les scripts Python du répertoire ;
- `python3 training/audit/splits_check.py --self-test` passe hors ligne
  (chaque règle de détection attrape bien les violations synthétiques
  attendues) ;
- `training/finetune/prompts_f01.jsonl` est extrait octet par octet des
  constantes figées du harnais (`RECIPE_SYSTEM_PROMPT`, `A01_PROMPT`,
  paramètres de génération épinglés).

## Ce qui reste volontairement NON vérifié

Toute valeur relative au dataset réel (identifiant, licence, volume,
schéma), toute métrique d'entraînement, toute sortie de génération, tout
résultat d'export : ces valeurs n'existeront qu'après exécution sur la
machine de référence, et seront alors relevées — jamais estimées.
