# Orchestrateur local Transformers.js (mode popup)

Depuis la v1.1, le MCP peut aussi être piloté **sans agent CLI** : une popup
Chrome transforme une liste de courses explicite en recherches produits et
actions panier. Les cas fiables passent d'abord par un normaliseur déterministe
local (`src/orchestrator/shopping-list.ts`) ; le modèle local
[Transformers.js](https://huggingface.co/docs/transformers.js) embarqué reste
un fallback pour les formulations non reconnues. Le modèle ne génère pas de
recette : il ne doit normaliser que les produits déjà écrits par l'utilisateur
vers le format `{ query, quantity, constraints? }`. Les 9 outils MCP publics
restent inchangés pour opencode / Claude Code ; la popup réutilise le **même
noyau métier** côté onglet Leclerc.

## Architecture

```
Popup (popup.html / popup.ts)
  │  chrome.runtime.sendMessage
  ▼
Background (background.ts)  ──route──►  Offscreen (offscreen.ts)
  │  normaliseur déterministe               │ Transformers.js (fallback)
  │                                         ▼  plan { items, questions? }
  │  chrome.tabs.sendMessage                │
  ▼                                         │
Content relay (content-relay.ts, ISOLATED)  │
  │  window.postMessage  (LeclercRequest)   │
  ▼                                         │
inject.ts (MAIN world)  ── dispatcher interne ──►  src/leclerc/api.ts
  │  window.postMessage  (LeclercResponse)   │
  ▼
Popup : candidats → sélection → *Valider* → mutations
```

## Dispatcher interne

`extension/inject.ts` expose un dispatcher structuré (`runDispatch`) qui
implémente les 6 commandes cœur :

| Lecture | Mutation |
| --- | --- |
| `search_products` | `add_to_cart` |
| `get_cart` | `update_quantity` |
| `get_store` | `remove_from_cart` |

Les 9 outils MCP textuels appellent ce dispatcher (aucune duplication de
logique). Le pont `window.postMessage` (bridge) valide chaque commande via
`src/orchestrator/dispatcher.ts` :

- commande inconnue → refusée ;
- mutation sur host non-Leclerc → refusée ;
- `product_id` doit être une chaîne (jamais coercée depuis un nombre).

## Modèle

- Modèle par défaut : `onnx-community/Qwen3-0.6B-ONNX` (dtype `q4`), embarqué
  dans `dist/extension/models/`.
- Modèle expérimental WebGPU : `onnx-community/Qwen3-0.6B-ONNX` (dtype
  `q4f16`), importé depuis le projet `jira-agent` et proposé dans le picker avec
  l'id `onnx-community/Qwen3-0.6B-ONNX:q4f16-webgpu`.
- Les modèles `q4` utilisent un prompt texte explicite (`SYSTEM/USER/ASSISTANT`)
  pour contourner les artefacts sans `tokenizer.chat_template`. Le variant
  `q4f16-webgpu` utilise le format chat (`ChatMessage[]`), comme dans le POC
  `jira-agent`.
- Le 1.7B est exclu du picker : `q4f16` échoue en WASM avec une erreur de type
  ONNX, et `q4` peut provoquer un crash natif Chrome sur macOS.
- Le 0.6B Instruct est exclu du picker : en smoke test liste de courses, il
  dérive vers de la prose ou copie les exemples au lieu de retourner les
  produits écrits par l'utilisateur.
- `env.allowRemoteModels = false`, `env.allowLocalModels = true`,
  `env.localModelPath = chrome.runtime.getURL("models/")`.
- WebGPU si explicitement activé, sinon WASM CPU par défaut.
- Le modèle **ne produit jamais** de `product_id` : il n'émet que
  `{ query, quantity, constraints?, notes? }` (+ `questions?`). Les ids produit
  viennent uniquement des réponses réelles de `search_products`.
- Le modèle ne déduit pas les ingrédients d'un plat. Une demande comme
  `carbonara pour 4` doit retourner `items: []` avec une question demandant la
  liste des ingrédients à acheter.
- Le normaliseur déterministe couvre en priorité les listes explicites, les
  poids/volumes, les quantités `xN`, et les refus de recettes seules. Cela évite
  de dépendre d'une sortie générative pour les cas courants.
- `src/orchestrator/plan.ts` parse + valide la sortie, et **drope** tout champ
  `product_id`/`id` halluciné.

### Stabilité Chrome : variantes modèle

`extension/offscreen/offscreen.ts` force actuellement ONNX Runtime WASM en
mono-thread. Le dtype n'est plus global : chaque entrée de
`src/orchestrator/models.ts` déclare son `repoId`, son `dtype`, son
`promptFormat` et son support WASM.

```ts
{ id: "onnx-community/Qwen3-0.6B-ONNX", dtype: "q4", promptFormat: "text", supportsWasm: true }
{ id: "onnx-community/Qwen3-0.6B-ONNX:q4f16-webgpu", dtype: "q4f16", promptFormat: "chat", supportsWasm: false }
ortWasm.numThreads = 1;
ortWasm.proxy = false;
```

Contexte :

- l'ouverture du plugin a déclenché des crashes natifs Chrome
  (`EXC_BREAKPOINT` / `SIGTRAP`) pendant l'initialisation du runtime local
  Transformers.js / ONNX ;
- avec `q4f16` en WASM, ONNX Runtime peut aussi échouer proprement à la création
  de session avec une erreur de type `tensor(float16)` vs `tensor(float)`.

Dans le premier cas, le code JS ne reçoit pas d'exception exploitable : le
navigateur tombe avant que l'extension puisse afficher une erreur. Dans le
second, le popup affiche l'erreur ONNX.

Compromis choisi :

- `q4` reste le défaut stable en WASM.
- `q4f16` est disponible uniquement via l'entrée expérimentale WebGPU ; le
  background refuse cette variante avant création de session si WebGPU n'est pas
  coché.
- Le 1.7B est retiré du catalogue actif pour éviter un crash natif sur
  mémoire/runtime.
- `numThreads = 1` réduit les performances d'inférence, surtout sur les gros
  modèles.
- En échange, on évite la classe de crash liée au runtime WASM multi-thread /
  workers depuis un document offscreen d'extension.
- Le popup ne préchauffe plus le modèle à l'ouverture ; le chargement commence
  uniquement quand l'utilisateur clique sur *Préparer la liste*.

Pour revenir en arrière et tester le multi-thread WASM tout en restant en `q4` :

1. Dans `extension/offscreen/offscreen.ts`, supprimer ou commenter uniquement
   la ligne `ortWasm.numThreads = 1;`.
2. Garder `ortWasm.proxy = false;` inchangé, sauf si le test vise explicitement
   le proxy worker ORT.
3. Rebuilder l'extension :

   ```bash
   npm run typecheck
   npm run build:extension
   ```

4. Recharger l'extension unpacked depuis `dist/extension/` dans
   `chrome://extensions`.
5. Tester séparément :
   - ouverture simple du popup ;
   - clic *Préparer la liste* en WASM ;
   - clic *Préparer la liste* avec WebGPU activé.

Si le crash revient après retrait de `numThreads = 1`, rétablir la ligne et
rebuilder. Si l'ouverture du popup plante encore avec `numThreads = 1`, le
déclencheur n'est probablement plus le backend WASM multi-thread : isoler alors
le popup, l'offscreen et l'injection Leclerc séparément.

Pour tester `q4f16` explicitement :

1. Choisir `Qwen3 0.6B q4f16 — WebGPU expérimental` dans le picker.
2. Cocher WebGPU avant de cliquer *Préparer la liste*.
3. Si l'artefact manque, relancer :

   ```bash
   MCP_LECLERC_MODEL_DTYPE=q4f16 npm run fetch:model
   npm run build:extension
   ```

4. En WASM, l'erreur `tensor(float16)` vs `tensor(float)` indique que ce dtype
   n'est pas viable sur la pile testée ; il doit rester WebGPU-only.
5. Si le modèle se charge mais ne retourne pas de JSON, le bloc Debug affiche
   `rawOutput` pour voir si la sortie est du texte libre, du raisonnement
   `<think>`, ou un JSON tronqué.

## Sécurité panier

- Aucune mutation n'est envoyée avant le clic *Valider* dans la popup.
- Les libellés produits Leclerc sont rendus en `textContent` (jamais en HTML)
  et traités comme données non fiables — jamais comme instructions.
- Le host est re-vérifié par le bridge avant toute action.

## Build & modèle

```bash
npm run fetch:model        # télécharge le modèle ONNX dans dist/extension/models/
npm run build:extension    # bundler popup/offscreen/relay + copier ort-wasm + modèles
npm run typecheck
npm test
```

`scripts/model-files.json` (manifeste committé) liste les fichiers + tailles +
sha256 (poids LFS). `scripts/fetch-model.mjs` vérifie checksums/taille et écrit
un lock reproductible (`scripts/model-lock.json`, gitignoré). Les gros fichiers
modèle ne sont **jamais** committés ; seul l'artefact `dist/extension/` les
contient.

## Tests unitaires

- `tests/orchestrator-plan.test.ts` — parsing/validation de la sortie modèle
  (réponses mockées), droppage des `product_id` hallucinés.
- `tests/shopping-list-normalizer.test.ts` — normalisation déterministe des
  listes explicites et refus des recettes seules.
- `tests/model-inference.test.ts` — smoke tests opt-in de normalisation de
  listes de courses explicites par le modèle seul ; diagnostic, pas chemin
  fiable principal.
- `tests/orchestrator-dispatcher.test.ts` — lecture vs mutation, erreurs,
  host Leclerc refusé.
- `tests/orchestrator-correlator.test.ts` — corrélation `requestId`, timeout,
  erreur page (horloge fictive).
