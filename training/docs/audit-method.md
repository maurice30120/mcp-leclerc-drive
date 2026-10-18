# Méthode d'audit du dataset « French Recipe » (ticket #53)

Ce document décrit la méthode appliquée par `training/audit/audit_dataset.py`.
**Statut : méthode écrite, exécution EN ATTENTE** (aucun Mac de référence ni
réseau mobilisés à ce jour) — voir `status.md`.

## 1. Métadonnées — relevées, jamais inventées

Toute la section métadonnées provient de l'API Hugging Face et du builder
`datasets`, et rien d'autre :

| Information | Source | Politique |
|---|---|---|
| Identifiant exact du dépôt | `HfApi().dataset_info(repo_id).id` | si l'id renvoyé diffère de l'id demandé → échec immédiat (exit 3) |
| Licence | card data du modèle / tags `license:*` | si aucune licence vérifiable → échec immédiat ; AUCUNE licence n'est supposée par défaut |
| Volume | `load_dataset_builder().info.splits[*].num_examples` | si un split n'expose pas son volume → échec immédiat, aucune estimation |
| Révision | SHA du dépôt au moment de l'audit | consigné dans le manifeste de provenance |

Le manifeste `training/audit/out/provenance.json` enregistre : identifiant,
révision, licence, horodatage UTC, versions des outils, mappage de champs,
règles de rejet, politique de déduplication, seed et ratios.

## 2. Exploration du schéma

- colonnes et types relevés depuis `builder.info.features` ;
- encodage : détection de caractères de remplacement U+FFFD dans l'échantillon ;
- doublons : textes exacts puis signatures normalisées (cf. § 4) ;
- recettes incomplètes : titre vide, étapes absentes, ingrédients vides ;
- unités : inventaire des unités réellement présentes vs unités contrôlées
  du contrat (`packages/contracts/src/recipe-generated.ts`) ;
- portions : distribution des valeurs de servings après parsing strict.

## 3. Règles de rejet — avec provenance explicite

Chaque rejet est tracé ligne par ligne dans
`training/audit/out/rejections.jsonl` (index de ligne source, règle, note de
provenance : dépôt, révision, split). Règles :

1. titre absent ou vide ;
2. portions absentes ou non parsables de façon fiable ;
3. liste d'ingrédients absente ou vide ;
4. ingrédient à quantité/unité non fiable — **aucune conversion n'est devinée** :
   seules les canonisations sûres sont appliquées (ex. « gramme(s) » → g,
   « c. à soupe » → cuillère à soupe) ; tout le reste est rejeté ;
5. étapes absentes ou vides (recette incomplète).

## 4. Déduplication AVANT découpage

Deux enregistrements tombent dans le même groupe si leur titre normalisé est
identique OU si leur multiset d'ingrédients normalisé est identique (une
reformulation conserve au moins l'une des deux signatures en pratique).
L'union des deux critères est calculée avant TOUT découpage ; un seul
représentant par groupe entre dans les splits, les variantes sont
conservées dans `groups.json`. Le découpage s'opère **par groupe**, jamais
par enregistrement : une variante ne peut donc pas chevaucher deux splits.

## 5. Splits disjoints — vérification programmatique

Le découpage (shuffle seedé, ratios par défaut 0,8/0,1/0,1) est immédiatement
vérifié par `splits_check.verify_splits` :

- aucun doublon dans un split (texte exact, puis titre+ingrédients
  normalisés) ;
- aucune recette de test/validation dans train, **même reformulée**
  (titre normalisé OU multiset d'ingrédients identique) ;
- aucun groupe à cheval sur deux splits (manifeste des groupes inclus) ;
- règles de rejet respectées dans ce qui est conservé (portions, quantités,
  unités contrôlées).

`splits_check.py` se relance aussi de façon autonome (hors ligne, sans
dépendance) sur les fichiers de splits, avec un mode `--self-test` qui
vérifie que chaque détection attrape bien ce qu'elle doit attraper.

## 6. Échantillon contrôlé avant dataset complet

Par défaut l'audit travaille sur un échantillon (`--max-records`, défaut 500)
via le streaming Hugging Face : les splits produits sont alors marqués
« usage smoke uniquement » dans `stats.json`. Le découpage final sur le
dataset complet exige `--full`.

## 7. Exemples SFT (instruction → réponse JSON)

`audit_dataset.py` produit aussi `training/data/sft/{train,validation,test}.jsonl`
au format messages mlx-lm (system/user/assistant) :

- le prompt système est le prompt figé du harnais, lu depuis
  `training/finetune/prompts_f01.jsonl` (extraction octet par octet depuis
  `packages/agent/src/prompts.ts`) ;
- l'instruction est un gabarit déterministe sur les champs vérifiés (titre,
  portions) — **aucune vérité terrain n'est fabriquée** ;
- la réponse cible est la recette canonique elle-même, au format strict du
  contrat (champs autorisés, unités contrôlées) — garanti par les règles de
  rejet qui ont déjà filtré tout ce qui n'était pas fiable.

## 8. Licences et redistribution des poids dérivés

La licence relevée (§ 1) est bloquante pour toute publication : si elle
interdit ou conditionne les œuvres dérivées, la publication des
adaptateurs/poids dérivés est interdite ou conditionnée. La licence du
modèle de base s'applique aussi (fusion LoRA = poids dérivés) et doit
accompagner toute publication. Voir `README.md` et `export-chain.md`
(gate de publication).
