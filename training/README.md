# Pipeline d'entraînement — répertoire isolé (spécification #40, tickets #53–#55)

Ce répertoire contient le pipeline ML **isolé** du reste du dépôt (aucune
dépendance vers `packages/`, `extension/`, `src/`). Python uniquement. Il
couvre trois tickets :

| Ticket | Portée | Fichiers |
|---|---|---|
| #53 | Audit du dataset « French Recipe » (Hugging Face) : métadonnées, schéma, déduplication **avant** découpage, splits disjoints vérifiés | `audit/audit_dataset.py`, `audit/splits_check.py` |
| #54 | Premier fine-tuning LoRA (MLX-LM, Apple Silicon) : smoke train, reprise, mémoire/temps, comparaison à prompts et paramètres identiques | `finetune/lora_smoke_train.py`, `finetune/gen_compare.py`, `finetune/configs/`, `finetune/prompts_f01.jsonl` |
| #55 | Chaîne d'export expérimentale MLX → fusion LoRA → ONNX → quantification, et vérifications post-export | `export/export_onnx.py`, `export/check_export.py` |

Statut honnête : **aucune étape de ce pipeline n'a encore été exécutée**
(aucun Mac Apple Silicon de référence, aucun réseau, aucun `pip install`
pendant la rédaction). Voir `docs/status.md`. Aucun résultat n'est fabriqué :
tout ce qui n'a pas tourné est documenté comme « en attente d'exécution ».

## Gates bloquantes

1. **Modèle de base prouvé AVANT tout investissement d'entraînement.**
   Le modèle de base doit être démontré expérimentalement en ONNX/WebGPU
   (chargement dans Chrome + sorties valides, et chargement dans le harnais
   Node) avant de dépeler le moindre entraînement — c'est le POC du ticket
   #47. Tant que cette preuve n'existe pas,
   `finetune/lora_smoke_train.py` **refuse de s'exécuter** sans le drapeau
   explicite `--base-validated`, accordé seulement après le POC.
   Les candidats (`packages/harness/src/poc/candidates.ts`) sont
   *informatifs, non validés* : aucun modèle n'est figé par décision de
   principe.

2. **Chaîne d'export prouvée AVANT de déclarer l'intégration navigateur
   terminée.** Aucune conversion MLX → ONNX n'est supposée acquise : la
   chaîne (fusion LoRA → poids HF compatibles → export ONNX → quantification)
   doit être établie expérimentalement pour la famille de modèle retenue, puis
   le modèle exporté doit se charger et produire des recettes JSON valides
   dans Chrome (WebGPU) — gate documentée dans `docs/export-chain.md`.
   En cas d'échec : on documente le blocage, on compare quand même sous MLX,
   **sans** déclarer l'intégration navigateur terminée.

3. **Aucun checkpoint n'est déclaré « prêt » sur la seule baisse de la
   loss.** Toute promotion exige une évaluation qualité documentée
   (comparaison à prompts figés F01 + parse strict du contrat recette,
   relecture humaine). Voir `docs/training-reproducibility.md`.

4. **Le premier fine-tuning porte uniquement sur les recettes structurées**,
   pas sur l'usage des outils. Aucun exemple d'appel d'outil n'entre dans le
   SFT de ce périmètre.

## Arborescence

```
training/
├── README.md               ce fichier
├── requirements.txt        dépendances épinglées (À VALIDER sur le Mac de référence)
├── audit/
│   ├── audit_dataset.py    audit + déduplication + splits (nécessite le réseau)
│   └── splits_check.py     vérificateur pur de disjonction + --self-test hors ligne
├── finetune/
│   ├── lora_smoke_train.py smoke train LoRA (refus sans --base-validated)
│   ├── gen_compare.py     baseline vs LoRA, prompts/paramètres identiques
│   ├── configs/           configs JSON versionnées (seed, rank, lr, …)
│   └── prompts_f01.jsonl  prompts figés F01 (identiques octet par octet au harnais)
├── export/
│   ├── export_onnx.py     chaîne expérimentale fusion → ONNX → quantification
│   └── check_export.py    vérifications post-export (tokenizer, format, génération)
└── docs/
    ├── audit-method.md
    ├── training-reproducibility.md
    ├── export-chain.md
    └── status.md          tableau d'état honnête (rien n'a tourné)
```

Sorties **non versionnées** (ignorées via `.gitignore`) :
`training/runs/` (runs, métriques, adaptateurs, exports),
`training/data/` (dataset + splits),
`training/audit/out/` (stats et manifestes de provenance).

## Exécution de chaque étape

Aucune dépendance Python n'est installée par ce dépôt. Sur le Mac de
référence (Apple Silicon), après avoir validé les versions réelles :
`python3 -m venv .venv && . .venv/bin/activate && pip install -r training/requirements.txt`.

1. **Audit du dataset** (ticket #53, nécessite le réseau) :
   ```bash
   python3 training/audit/audit_dataset.py --repo-id <ID_EXACT_DU_DATASET_HF>
   ```
   L'identifiant exact, la licence et le volume sont relevés depuis l'API
   Hugging Face — **jamais inventés** : si une métadonnée ne peut pas être
   vérifiée, le script échoue bruyamment. Sorties :
   `training/audit/out/stats.json`, `training/audit/out/provenance.json`,
   splits dans `training/data/splits/`.

2. **Vérification des splits** (hors ligne) :
   ```bash
   python3 training/audit/splits_check.py --self-test          # autonome, hors ligne
   python3 training/audit/splits_check.py \
     --train training/data/splits/train.jsonl \
     --validation training/data/splits/validation.jsonl \
     --test training/data/splits/test.jsonl
   ```

3. **Smoke train LoRA** (ticket #54, nécessite MLX + le POC #47) :
   ```bash
   python3 training/finetune/lora_smoke_train.py \
     --config training/finetune/configs/smoke.json --base-validated
   ```
   Sans `--base-validated` : refus + explication de la gate WebGPU.
   Reprise : `--resume training/runs/<runid>/adapters`.
   Métriques : `training/runs/<runid>/metrics.json` (loss observée, mémoire,
   durée — rien de fabriqué). La baseline n'est jamais modifiée.

4. **Comparaison baseline vs LoRA** (mêmes prompts/paramètres, F01) :
   ```bash
   python3 training/finetune/gen_compare.py \
     --config training/finetune/configs/smoke.json \
     --adapter training/runs/<runid>/adapters
   ```
   Sorties brutes + durées uniquement, aucune affirmation de qualité.

5. **Export ONNX + quantification** (ticket #55, expérimental) :
   ```bash
   python3 training/export/export_onnx.py --step all \
     --adapter training/runs/<runid>/adapters \
     --work-dir training/runs/<runid>/export
   python3 training/export/check_export.py \
     --base-model <base> --exported training/runs/<runid>/export/onnx
   ```
   Le script **refuse** toute déclaration d'intégration navigateur tant que
   la gate Chrome/WebGPU n'est pas franchie (voir `docs/export-chain.md`).

## Ce qui est en attente d'exécution, et pourquoi

- Audit réel du dataset, entraînement, comparaison, export : exigent le Mac
  de référence (Apple Silicon pour MLX), le réseau Hugging Face et des
  identifiants éventuels ; aucun n'a tourné. Voir `docs/status.md`.
- `audit/splits_check.py --self-test` est le seul élément exécutable
  immédiatement, hors ligne, sans dépendance.

## Licences et redistribution des poids dérivés

- Le dataset audité porte sa propre licence, relevée par
  `audit_dataset.py` (jamais supposée). Si la licence du dataset interdit ou
  conditionne la redistribution d'œuvres dérivées (poids entraînés inclus),
  la publication publique des adaptateurs/poids dérivés est **interdite ou
  conditionnée** ; l'audit de licence est un prérequis bloquant de toute
  publication Hugging Face (ticket #55).
- Le modèle de base retenu apporte ses propres conditions (ex. Apache-2.0
  pour les candidats listés — à confirmer sur le dépôt réel). La fusion LoRA
  produit des poids dérivés : la licence du modèle de base s'applique et doit
  être recopiée dans tout dépôt publié, avec mention du dataset utilisé et
  de sa licence.
- `export/export_onnx.py` refuse l'étape de publication sans
  `--license-audit <fichier>` documentant l'audit de licence effectué.
