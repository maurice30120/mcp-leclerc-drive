# Chaîne d'export : fusion LoRA → ONNX → quantification, et gates (ticket #55)

Statut : procédure écrite, chaîne **jamais exécutée à ce jour** — voir
`status.md`. Rien n'est supposé : la faisabilité MLX → ONNX pour la famille
de modèle retenue doit être établie **expérimentalement** sur le Mac de
référence.

## 1. Chaîne étape par étape (commandes réelles)

Éxecutées par `training/export/export_onnx.py` ; chaque étape enregistre
commande, code retour, durée et sortie dans `<work-dir>/export_status.json`.

### Étape 1 — fusion LoRA en poids conventionnels (format HF)

```
python3 -m mlx_lm.fuse \
  --model <base> \
  --adapter-path training/runs/<runid>/adapters \
  --save-path training/runs/<runid>/export/merged-hf \
  --export-format hf
```

La fusion produit un NOUVEAU répertoire ; la baseline n'est jamais modifiée.

### Étape 2 — export ONNX (pas de conversion MLX→ONNX supposée)

La conversion ne part PAS des poids MLX : elle part de la fusion au format
HF, via optimum — c'est ce chemin (et non un hypothétique MLX→ONNX direct)
que la spécification exige d'établir expérimentalement.

```
optimum-cli export onnx \
  --model training/runs/<runid>/export/merged-hf \
  --task text-generation-with-past \
  --device cpu \
  training/runs/<runid>/export/onnx
```

### Étape 3 — quantification

Quantification dynamique int8 (exécutable et vérifiable par ce scaffold) :

```python
from onnxruntime.quantization import QuantType, quantize_dynamic
quantize_dynamic("<onnx>/model.onnx", "<out>/model-int8-dynamic.onnx",
                weight_type=QuantType.QInt8)
```

Honnêteté : la quantification 4 bits côté navigateur (MatMulNBits, dtype
`q4f16` attendu par Transformers.js/WebGPU) exige un outillage
supplémentaire à prouver sur la machine de référence — cette étape ne
prétend PAS au q4 WebGPU.

### Étape 4 — publication Hugging Face (gated)

```
--publish --hf-repo-id <org/model> --license-audit <document>
```

Refusée sans : (1) un document d'audit de licence complété prouvant que les
licences du dataset ET du modèle de base autorisent la redistribution des
poids dérivés, (2) le jeton `HF_TOKEN`. Sinon l'étape est refusée avec
motif tracé.

## 2. Gates bloquantes

1. **Gate Chrome/WebGPU.** Le modèle exporté doit être démontré : chargement
   dans Chrome (WebGPU) ET chargement dans le harnais Node, avec des recettes
   JSON valides en sortie sur les prompts de test. Tant que cette preuve
   n'existe pas, `export_status.json` garde
   `browser_integration: "PENDING — gate Chrome/WebGPU non franchie"`.
   `export_onnx.py --declare-browser-ready` REFUSE et explique pourquoi :
   aucune déclaration d'intégration navigateur ne peut être émise par la
   chaîne elle-même. La gate n'est franchie que manuellement, preuves liées.
2. **Vérifications post-export.** `training/export/check_export.py` doit
   passer sur la machine de référence :
   - tokenizer intact : ids identiques (base vs export) sur des sondes
     figées (accents, guillemets, ponctuation JSON) ;
   - format de prompt intact : rendu du chat template identique sur les
     messages F01 figés ;
   - smoke de génération sur prompt F01 avec paramètres épinglés, sortie
     brute enregistrée et vérifiée contre le contrat recette strict (JSON
     nu, champs autorisés, unités contrôlées, pas d'identifiant produit) —
     miroir de `packages/contracts/src/recipe-generated.ts`.
3. **Audit de licence** (cf. étape 4) avant toute publication.

## 3. En cas d'échec d'export

- documenter le blocage précis dans `export_status.json` (étape, commande,
  erreur) et dans ce document ;
- comparer quand même sous MLX : `finetune/gen_compare.py` reste utilisable
  pour la comparaison baseline vs LoRA en local ;
- **ne jamais déclarer l'intégration navigateur terminée** : le statut reste
  « intégration non prouvée » jusqu'aux preuves, même si l'entraînement et
  la fusion réussissent.

## 4. Commandes complètes d'un cycle

```bash
# après un run LoRA validé (lora_smoke_train.py + évaluation qualité documentée)
python3 training/export/export_onnx.py \
  --config training/finetune/configs/smoke.json \
  --adapter training/runs/<runid>/adapters \
  --work-dir training/runs/<runid>/export \
  --step all

python3 training/export/check_export.py \
  --base-model <base> \
  --exported training/runs/<runid>/export/onnx \
  --report-dir training/runs/<runid>/export/checks

# gate Chrome/WebGPU : procédure manuelle du POC (#47) + harnais Node,
# preuves archivées — puis seulement publication éventuelle :
python3 training/export/export_onnx.py --step publish \
  --hf-repo-id <org/model> --license-audit <document>
```

Les versions exactes des outils (mlx, mlx-lm, optimum, onnx, onnxruntime)
sont celles épinglées et validées de `training/requirements.txt` — les
relever dans chaque `export_status.json` au moment du run réel.
