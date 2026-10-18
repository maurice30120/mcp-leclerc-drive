# Reproductibilité de l'entraînement et promotion des checkpoints (ticket #54)

Statut : procédure écrite, **aucun entraînement exécuté à ce jour** — voir
`status.md`.

## 1. Ce qui rend un run reproductible

Chaque run LoRA est entièrement décrit par trois éléments versionnés :

1. **la config** (`training/finetune/configs/*.json`) : modèle de base, rank
   LoRA, nombre de couches, taux d'apprentissage, batch, longueur de
   séquence, nombre de pas, seed, politique de checkpoints. La config est
   copiée intégralement dans `metrics.json` avec son sha256 : toute
   divergence de config entre deux runs est détectable.
2. **le seed** : le découpage des splits (audit) et le shuffle de
   l'entraînement partent du même seed versionné ; les paramètres de
   génération des comparaisons sont épinglés (temperature 0, seed 0,
   maxTokens 1024 — mêmes valeurs que le harnais, F01).
3. **les données** : fichier, révision du dataset et manifeste de provenance
   produits par l'audit (ticket #53) ; les données d'entraînement sont
   régénérables à l'identique via `audit_dataset.py` + le même seed.

`training/runs/<runid>/metrics.json` enregistre en plus : horodatages UTC de
début/fin, durée mesurée, mémoire mesurée (`getrusage(RUSAGE_CHILDREN)`,
valeur brute + plateforme — l'unité de `ru_maxrss` diffère entre macOS et
Linux), points de loss **analysés depuis la sortie réelle du trainer**
(rien n'est estimé), la commande exacte exécutée et son code retour, et le
chemin de reprise éventuel.

## 2. Smoke train puis augmentation progressive

- `lora_smoke_train.py` cible un run très court (défaut : 20 pas) sur le
  mini-échantillon (mode `--max-records` de l'audit). But : prider la chaîne,
  mesurer mémoire/temps, vérifier la reprise — pas la qualité.
- L'augmentation progressive (plus de pas, dataset complet `--full`) ne
  démarre qu'après un smoke train vert ET la comparaison F01 documentée.
- Le premier fine-tuning porte **uniquement sur les recettes structurées** :
  aucun exemple d'usage des outils n'entre dans le SFT (décision de la
  spécification #40).

## 3. Baseline jamais modifiée

- les adaptateurs sont écrits sous `training/runs/<runid>/adapters/`,
  jamais dans le répertoire du modèle de base ;
- la baseline reste exécutable telle quelle : `gen_compare.py` relance le
  modèle de base aux mêmes prompts figés F01 et aux mêmes paramètres que la
  variante LoRA, dans le même run, pour une comparaison honnête ;
- `gen_compare.py` refuse de tourner sans adaptateur existant : aucune
  comparaison « avant/après » n'est fabriquée sans run réel.

## 4. Vérification de la reprise

1. lancer un smoke train A (par ex. 20 pas) ;
2. relancer avec `--resume training/runs/A/adapters` : le run B repart de
   l'adaptateur existant (`--resume-adapter-file`) ;
3. critères de reprise OK : B démarre sans téléchargement/réinitialisation
   de l'adaptateur, la loss initiale de B est cohérente avec la loss finale
   de A (constat relevé dans les métriques, pas supposé), et les
   `metrics.json` de A et B référencent la même config (sha256 identique).

## 5. Aucun checkpoint promu sur la seule baisse de la loss

La loss est un signal d'entraînement, pas un critère de qualité. Un
checkpoint n'est déclaré « prêt » qu'après une **évaluation qualité
documentée**, au minimum :

1. comparaison baseline vs LoRA aux prompts figés F01 (`gen_compare.py`),
   sorties brutes archivées ;
2. vérification du contrat recette sur chaque sortie (JSON strict, unités
   contrôlées, pas d'identifiant produit — même critères que
   `check_export.check_recipe_contract`) ;
3. relecture humaine consignée (qui, quand, constat) dans le répertoire du
   run ;
4. pour l'usage navigateur : les gates d'export (`export-chain.md`) doivent
   en plus être franchies — l'entraînement ne prouve jamais l'intégration.

Toute promotion est tracée dans `metrics.json` du run concerné ; le champ
`promotion` de chaque run rappelle cette règle.

## 6. Gate bloquante : modèle de base prouvé AVANT l'investissement

`lora_smoke_train.py` refuse de s'exécuter sans `--base-validated` : le
modèle de base doit d'abord être démontré en ONNX/WebGPU (chargement dans
Chrome + sorties valides, harnais Node) — POC du ticket #47. Les candidats
actuels sont informatifs et non validés ; aucun entraînement n'investit sur
un modèle non prouvé.
