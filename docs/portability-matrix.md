# Matrice de portabilité multi-OS (contextes observés)

Ticket #57 (spécification #40). Date d'observation : 2026-10-18, commit `cd425cd`.

> **Règle de ce document : n'y figure que ce qui a été réellement observé.**
> Une ligne non testée est signalée « non testé » et n'est jamais présentée
> comme fonctionnelle. Les exécutions exigeant un GPU réel, un Chrome réel,
> un téléchargement de modèle ou une clé Mistral sont strictement opt-in :
> elles ne se lancent jamais sans un consentement explicite, et leur échec
> produit une erreur explicite suivie d'une proposition Mistral **avec
> consentement** — jamais un crash silencieux, jamais un repli CPU/WASM
> (ADR-0012, scénario A10).

## État vérifié sur le Mac de développement (macOS)

La suite hors-ligne suivante a été exécutée le 2026-10-18 depuis la racine du
dépôt au commit `cd425cd` et **passe intégralement** :

```
npm run build && npm run typecheck && node --test tests/*.test.ts && npm test --workspaces --if-present
```

Observé : build TypeScript (racine + workspaces) vert ; `typecheck` vert
(incluant `tsconfig.extension.json`) ; tests legacy `node --test` :
227 tests passés ; `@leclerc/contracts` : 130 tests ; `@leclerc/agent` :
30 tests ; `@leclerc/harness` : 70 tests (dont les scénarios A01–A10/F01 et
le chemin d'échec A10).

Tout ce qui exige une machine (WebGPU réel, Chrome réel, téléchargement HF,
appel Mistral réel) est **en attente d'exécution** : opt-in, jamais exécuté
en CI, jamais exécuté implicitement.

## Contexte 1 — Chrome MV3 + panneau latéral

| OS | Statut observé | Limites connues | Procédure de vérification |
| --- | --- | --- | --- |
| macOS | Vérifié hors-ligne : `typecheck` extension vert, projection du registre WebMCP testée (9 capacités + 7 outils recette). Panneau latéral : **en attente d'exécution** (intégration en cours, ticket #51). | Suspension du service worker MV3 : l'état d'inférence doit survivre aux suspensions ; l'inférence locale doit sortir du thread UI (worker/offscreen) ; l'UI du site Leclerc n'est pas modifiée. | `npm run build:extension`, charger `dist/extension/` non empaquetée (`chrome://extensions`), puis suivre `docs/testing/webmcp-opt-in.md` (M01–M04) pour le chemin extension ; panneau latéral : procédure du ticket #51 une fois intégré. |
| Windows | **Non testé.** | Non testé — aucune limite observée ne peut être affirmée. | Même procédure que macOS ; aucun résultat n'y est présumé. |
| Linux | **Non testé.** | Non testé — aucune limite observée ne peut être affirmée. | Même procédure que macOS ; aucun résultat n'y est présumé. |

## Contexte 2 — Inférence locale Transformers.js WebGPU

| OS | Statut observé | Limites connues | Procédure de vérification |
| --- | --- | --- | --- |
| macOS | Chemin d'échec vérifié hors-ligne (A10 : sonde défaillante → `PROVIDER_UNAVAILABLE`, diagnostic français, proposition Mistral consentie, zéro appel Mistral, zéro session locale). Inférence WebGPU réelle : **en attente d'exécution** (gate `MCP_LECLERC_RUN_LOCAL=1`). | WebGPU indisponible ou refus d'adaptateur → le modèle local **ne se lance pas** : erreur explicite, aucun repli CPU/WASM (par conception, ticket #49) ; la sonde va au-delà de la présence de `navigator.gpu` (création de session réelle) ; pas de GPU en CI/headless. | Hors-ligne : `npm test --workspace @leclerc/harness`. Réel (opt-in, GPU requis, télécharge les poids) : `MCP_LECLERC_RUN_LOCAL=1 npm run test:harness:local` — échec de sonde = sortie non nulle + diagnostic français ; rapport JSON dans `runs/` (gitignoré). |
| Windows | **Non testé.** | Non testé — le support WebGPU de Chrome/Windows n'est pas affirmé ici. | Même procédure que macOS ; aucun résultat n'y est présumé. |
| Linux | **Non testé.** | Non testé — le support WebGPU de Chrome/Linux n'est pas affirmé ici. | Même procédure que macOS ; aucun résultat n'y est présumé. |

## Contexte 3 — Chargement du modèle HF / cache

| OS | Statut observé | Limites connues | Procédure de vérification |
| --- | --- | --- | --- |
| macOS | Pipeline opt-in vérifié hors-ligne (ticket #52) : manifeste versionné, vérification taille exacte + sha256, `put` atomique dans le cache. Téléchargement HF réel : **en attente d'exécution** (consentement explicite requis avant tout octet téléchargé). | Échec de téléchargement (réseau, checksum, abandon) → cache **inchangé** (aucune entrée partielle, aucun modèle à moitié téléchargé) ; quotas de stockage (navigateur : `navigator.storage` ; Node : disque) → erreur explicite, pas de contournement silencieux ; cache complet = exécution **totalement hors-ligne**. | Hors-ligne : `npm test --workspace @leclerc/agent` (manifeste, cache, pipeline de téléchargement avec transport injecté). Téléchargement réel (opt-in) : consentement explicite puis vérification sha256 ; pour les modèles de l'extension : `npm run fetch:model` (lock reproductible `scripts/model-lock.json`). |
| Windows | **Non testé.** | Non testé — notamment le comportement des quotas de disque n'est pas observé. | Même procédure que macOS ; aucun résultat n'y est présumé. |
| Linux | **Non testé.** | Non testé — notamment le comportement des quotas de disque n'est pas observé. | Même procédure que macOS ; aucun résultat n'y est présumé. |

## Contexte 4 — Mistral BYOK

| OS | Statut observé | Limites connues | Procédure de vérification |
| --- | --- | --- | --- |
| macOS | Provider `mistral-byok` vérifié hors-ligne (`packages/agent/src/providers/mistral.ts`) : sélection **strictement explicite**, clé jamais loguée et scrubée de toute erreur (401, 429, réseau). Appel Mistral réel : **en attente d'exécution** (gates opt-in : `MISTRAPI_KEY` et `--provider mistral`, campagne #46 en cours d'intégration). | Clé invalide → erreur 401 explicite ; quota → erreur 429 explicite ; échec réseau → erreur explicite — la clé n'apparaît jamais ; **jamais appelé automatiquement** : Mistral n'est jamais substitué au local, il est *proposé* avec consentement requis (A10) ; un échec Mistral ne déclenche aucun repli. | Hors-ligne : `npm test --workspace @leclerc/agent`. Réel (opt-in) : campagne Mistral — `MISTRAPI_KEY=… npm run harness:campaign:mistral` avec `--provider mistral` (ticket #46) ; validation dans le contexte extension : `docs/poc/mistral-byok-extension.md`. |
| Windows | **Non testé.** | Non testé. | Même procédure que macOS ; aucun résultat n'y est présumé. |
| Linux | **Non testé.** | Non testé. | Même procédure que macOS ; aucun résultat n'y est présumé. |

## Contexte 5 — MCP Chrome → client externe

| OS | Statut observé | Limites connues | Procédure de vérification |
| --- | --- | --- | --- |
| macOS | Projection du registre `@leclerc/contracts` vérifiée hors-ligne (`tests/webmcp-projection.test.ts` : 9 capacités projetées, annotations préservées). Parcours réel Chrome → relay → client MCP stdio : procédure humaine opt-in **à exécuter** (M01–M04), non encore rapportée sur cette machine pour ce commit. | 403 DataDome → recharger l'onglet Leclerc (le navigateur ré-obtient son cookie lui-même) ; session liée à un seul drive : `set_store` vers un drive ≠ onglet → erreur « session expirée » explicite (`SESSION_EXPIRED`) ; l'origine du relay est épinglée à une origine Leclerc (`--widget-origin`). | `npm run build:extension`, charger l'extension, relay local `npx @mcp-b/webmcp-local-relay --widget-origin https://fdN-courses.leclercdrive.fr`, puis la check-list M01–M04 de `docs/testing/webmcp-opt-in.md` depuis un client MCP stdio (opencode, Claude Code…). |
| Windows | **Non testé.** | Non testé. | Même procédure que macOS ; aucun résultat n'y est présumé. |
| Linux | **Non testé.** | Non testé. | Même procédure que macOS ; aucun résultat n'y est présumé. |

## Échecs connus → comportement exigé (jamais de crash silencieux)

| Mode d'échec | Comportement observé/exigé | Où c'est vérifié |
| --- | --- | --- |
| WebGPU indisponible (pas d'adaptateur, session impossible) | `ProviderUnavailableError` (`PROVIDER_UNAVAILABLE`) : le modèle local **n'est pas lancé** (0 appel, 0 session), diagnostic français rendu à l'utilisateur, proposition Mistral en données pures `{providerId: "mistral-byok", consentRequired: true}` — Mistral **jamais** construit ni appelé par le parcours ; aucun repli CPU/WASM n'existe. | Scénario A10 du harnais (assertions bloquantes, vert hors-ligne) ; `packages/agent/src/providers/webgpu.ts`. |
| Cache / quotas (téléchargement interrompu, checksum invalide, quota de stockage) | Erreur explicite ; le cache reste inchangé (commit atomique, pas d'entrée partielle) ; reprise possible après accord — pas de modèle à moitié chargé, pas de repli silencieux. | Tests `@leclerc/agent` (manifeste, cache, téléchargement) ; `packages/agent/src/model-download.ts`, `cache-store.ts`. |
| DataDome / session (403, session expirée) | Erreur explicite (`SESSION_EXPIRED` / consigne de recharger l'onglet) ; aucune extraction de cookie, aucun contournement ; l'utilisateur recharge l'onglet et réessaie. | `docs/testing/webmcp-opt-in.md` ; README (« If you hit a 403 (DataDome) »). |

## Écarts connus

Écart signalé le 2026-10-18 (revue PR #58, spécification #40) : le nouveau
chemin agent / panneau latéral est **WebGPU-exclusif** — aucun repli
CPU/WASM n'existe (A10 : sonde défaillante → erreur explicite, modèle non
lancé). L'orchestrateur **popup historique** conserve lui son comportement
préexistant dans `extension/background.ts` : `wasm` par défaut, `webgpu`
seulement en cas de flag de stockage manuel. Cette contradiction est
documentée et assumée — pas de changement du comportement popup sans
décision explicite : son remplacement par le panneau latéral est la direction
fixée par la spécification (issue #40), et le découpage du service worker
qui séparera les deux chemins est suivi par le ticket #59.

## Plan de tests multi-OS

- **macOS (machine de développement) : priorité pédagogique.** La suite
  hors-ligne ci-dessus doit rester verte à chaque intégration ; les exécutions
  opt-in (WebGPU réel, panneau latéral, téléchargement HF, Mistral réel,
  M01–M04) y sont exécutées et rapportées dans ce document.
- **Windows / Linux : souhaitables, non bloquants.** Chaque plateforme doit
  rejouer la même procédure (colonne « Procédure de vérification » de chaque
  contexte) et rapporter ses résultats observés ici. Tant qu'une plateforme
  n'a pas rejoué une procédure, sa ligne reste « **non testé** » — elle n'est
  jamais présentée comme fonctionnelle.
- Aucun résultat multi-OS n'est présumé par déduction : seul ce qui est
  exécuté et observé est inscrit dans ce document.
