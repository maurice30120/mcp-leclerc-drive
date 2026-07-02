# Orchestrateur local Transformers.js (mode popup)

 Depuis la v1.1, le MCP peut aussi être piloté **sans agent CLI** : une popup
 Chrome transforme une recette ou un plat en liste d'ingrédients achetables,
 puis en recherches produits et actions panier, via un modèle local
 [Transformers.js](https://huggingface.co/docs/transformers.js) embarqué. Les
 9 outils MCP publics restent inchangés pour opencode / Claude Code ; la popup
 réutilise le **même noyau métier** côté onglet Leclerc.

## Architecture

```
Popup (popup.html / popup.ts)
  │  chrome.runtime.sendMessage
  ▼
Background (background.ts)  ──route──►  Offscreen (offscreen.ts)
  │                                         │ Transformers.js (WebGPU / WASM)
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

- Test modèle puissant : `onnx-community/Qwen3-1.7B-ONNX` (dtype `q4`), embarqué dans
  `dist/extension/models/`.
- `env.allowRemoteModels = false`, `env.allowLocalModels = true`,
  `env.localModelPath = chrome.runtime.getURL("models/")`.
- WebGPU si explicitement activé, sinon WASM CPU par défaut.
- Le modèle **ne produit jamais** de `product_id` : il n'émet que
  `{ query, quantity, constraints?, notes? }` (+ `questions?`). Les ids produit
  viennent uniquement des réponses réelles de `search_products`.
- `src/orchestrator/plan.ts` parse + valide la sortie, et **drope** tout champ
  `product_id`/`id` halluciné.

### Stabilité Chrome : WASM q4 mono-thread

`extension/offscreen/offscreen.ts` force actuellement ONNX Runtime WASM en
mono-thread, et `src/orchestrator/models.ts` utilise `MODEL_DTYPE = "q4"` :

```ts
export const MODEL_DTYPE = "q4" as const;
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

- `MODEL_DTYPE = "q4"` évite le graphe `q4f16` incompatible avec WASM sur cette
  pile Chrome / ORT.
- `numThreads = 1` réduit les performances d'inférence, surtout sur les gros
  modèles.
- En échange, on évite la classe de crash liée au runtime WASM multi-thread /
  workers depuis un document offscreen d'extension.
- Le popup ne préchauffe plus le modèle à l'ouverture ; le chargement commence
  uniquement quand l'utilisateur clique sur *Générer la liste*.

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
   - clic *Générer la liste* en WASM ;
   - clic *Générer la liste* avec WebGPU activé.

Si le crash revient après retrait de `numThreads = 1`, rétablir la ligne et
rebuilder. Si l'ouverture du popup plante encore avec `numThreads = 1`, le
déclencheur n'est probablement plus le backend WASM multi-thread : isoler alors
le popup, l'offscreen et l'injection Leclerc séparément.

Pour tester `q4f16` explicitement :

1. Remettre `MODEL_DTYPE = "q4f16"` dans `src/orchestrator/models.ts`.
2. Rebuilder avec les artefacts `q4f16` présents, ou relancer :

   ```bash
   MCP_LECLERC_MODEL_DTYPE=q4f16 npm run fetch:model
   npm run build:extension
   ```

3. Tester plutôt WebGPU. En WASM, l'erreur `tensor(float16)` vs `tensor(float)`
   indique que ce dtype n'est pas viable sur la pile testée.

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
- `tests/orchestrator-dispatcher.test.ts` — lecture vs mutation, erreurs,
  host Leclerc refusé.
- `tests/orchestrator-correlator.test.ts` — corrélation `requestId`, timeout,
  erreur page (horloge fictive).
