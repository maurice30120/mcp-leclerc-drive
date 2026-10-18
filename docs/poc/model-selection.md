# POC — Sélection du modèle de base (WebGPU) et tool calling réel

Ticket #47 (spécification #40). **Statut : EN ATTENTE D'EXÉCUTION (GPU requis).**

Ce document est le gabarit du rapport de POC. Aucune mesure n'y figure pour
l'instant : toutes les valeurs ci-dessous seront **mesurées** sur la machine de
référence lors de l'exécution opt-in décrite plus loin, puis reportées ici.
Rien n'est inventé, rien n'est prévalidé.

## Décision de principe (spécification, non négociable)

- Le modèle de base (~0,5–1,5 Md de paramètres, instruction-tuned, licence
  permissive) est sélectionné **sur preuve** d'inférence ONNX/WebGPU dans Chrome
  **et** dans le harnais Node — jamais par décision de principe. La liste des
  candidats (`packages/harness/src/poc/candidates.ts`) est **informatifs, non
  validés**.
- L'inférence locale est **WebGPU exclusif** : aucun repli CPU/WASM n'existe
  nulle part dans le code. Si la sonde WebGPU échoue, le POC s'arrête avec un
  diagnostic en français et un code de sortie non nul.
- Aucun travail de fine-tuning ne démarre avant la conclusion de ce ticket.

## Procédure

1. **Exécution Chrome (preuve navigateur).** Charger le modèle candidat via
   Transformers.js WebGPU dans Chrome (machine de référence, GPU activé) :
   chargement réussi, latence de génération mesurée, sortie lisible.
2. **Exécution harnais Node (preuve reproductible).** Sur la même machine :
   ```
   MCP_LECLERC_RUN_LOCAL=1 npm run test:harness:local
   ```
   La commande sonde WebGPU, puis exécute l'unique prompt figé A01 (recette de
   poulet au curry sans crème pour 4) via `createWebGpuProvider` avec les
   paramètres épinglés (temperature 0, seed 0, maxTokens 1024), et écrit un
   rapport JSON `runs/poc-<horodatage>.json` (gitignoré) : identifiant du
   modèle, révision, dtype, durée de chargement, latence de génération, sortie
   brute, validité de la recette au sens de `parseRecipeText`.
   Surclavages : `MCP_LECLERC_POC_MODEL_ID`, `MCP_LECLERC_POC_REVISION`,
   `MCP_LECLERC_POC_DTYPE`.
3. **Évaluation du tool calling réel.** Via l'intégration
   Transformers.js ↔ Vercel AI SDK (`@browser-ai/transformers-js` côté
   navigateur) : présenter au modèle les outils du registre
   `@leclerc/contracts` et observer s'il émet des appels d'outils **natifs**
   corrects (nom d'outil existant, entrée conforme au schéma, pas
   d'identifiant inventé).

## Critères de décision

| Critère | Seuil |
| --- | --- |
| Chargement WebGPU (Chrome + Node) | réussi pour le candidat, révision et dtype consignés |
| Génération A01 | sortie brute exploitable ; validité JSON recette mesurée |
| Latence | mesurée (chargement + génération), jugée acceptable pour l'usage |
| Français / JSON | qualité constatée sur le prompt A01, pas supposée |
| Tool calling natif | appels d'outils corrects observés sur les 9 capacités, ou échec documenté |

**Décision à consigner à l'issue du POC (l'une des deux, jamais les deux) :**

- **Parcours tool calling natif** : le modèle émet des appels d'outils valides ;
  l'intégration AI SDK est retenue pour la suite.
- **Parcours orchestration déterministe** : le modèle produit du JSON de
  recette exploitable mais échoue au tool calling natif. Les recherches sont
  alors orchestrées de façon déterministe par le moteur d'agent. Ce parcours
  ne doit **jamais** être qualifié de « tool calling réussi » : c'est un
  contournement assumé, documenté comme tel.

## Garde-fous

- Le POC est **strictement opt-in** : `MCP_LECLERC_RUN_LOCAL=1` explicite, sans
  quoi la commande s'arrête immédiatement (code non nul) sans sonde, sans
  téléchargement, sans inférence.
- Rien ne s'exécute dans la CI hors ligne ; les tests automatisés du harnais
  n'utilisent que des doublures injectées (sonde, fabrique de pipeline).
- WebGPU exclusif : échec de sonde = arrêt immédiat, aucun repli.
- Rapports mesurés uniquement : toute valeur non mesurée reste vide ou
  « non exécuté ».

## Résultats (à remplir après exécution)

### Candidat 1 : `<id du modèle>` (révision `<révision>`, dtype `<dtype>`)

- Chrome : chargement — `<mesure ou « non exécuté »>` ; génération — `<mesure>`
- Harnais Node (`runs/poc-<horodatage>.json`) :
  - chargement : `<ms>` — génération : `<ms>`
  - recette valide au sens du schéma : `<oui/non + codes d'issues>`
  - sortie brute : `<coller la sortie>`
- Tool calling natif : `<preuve ou échec documenté>`

(Répéter le bloc par candidat testé.)

### Conclusion

- Modèle retenu : `<à décider sur preuve — aucun modèle n'est figé par principe>`
- Parcours retenu : `<tool calling natif | orchestration déterministe>`
- Date, machine de référence : `<à consigner>`
