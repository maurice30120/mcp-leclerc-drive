# Test navigateur WebMCP opt-in (M01–M04)

Statut : **opt-in, jamais exécuté en CI.** Ce test protocole passe par le vrai
chemin de bout en bout — extension chargée dans Chrome, relay local
`@mcp-b/webmcp-local-relay`, et un vrai client MCP stdio. Il nécessite un
profil Chrome connecté à un compte Leclerc Drive, ce que la CI ne peut pas
fournir (et ne doit pas : aucune session ne sort jamais de l'onglet, cf.
ADR-0001/ADR-0004). Les tests automatisés du dépôt couvrent la projection pure
(`tests/webmcp-projection.test.ts`) et la logique métier ; ce document décrit
la vérification humaine, milestone par milestone.

## Prérequis

- Chrome (profil avec une session Leclerc Drive active).
- L'extension chargée non empaquetée depuis `dist/extension/`
  (`chrome://extensions` → « Charger l'extension non empaquetée »), après
  `npm run build:extension`.
- Le relay local en écoute : `npx @mcp-b/webmcp-local-relay` lancé sur la
  machine (le background worker injecte `embed.js` uniquement quand il
  répond).
- Un client MCP stdio quelconque configuré pour le relay (opencode, ou tout
  client `@modelcontextprotocol/sdk`).

## M01 — les neuf contrats via `tools/list`

1. Ouvre un onglet sur ton drive Leclerc
   (ex. `https://fd9-courses.leclercdrive.fr/magasin-053701-053701-.../`).
   La console de l'onglet doit afficher
   `[mcp-leclerc-drive] WebMCP tools registered (16)`.
2. Depuis le client MCP, appelle `tools/list`.

Attendu :

- les 9 capacités du registre `@leclerc/contracts` sont visibles avec leurs
  noms exacts : `find_stores`, `set_store`, `get_store`, `search_product`,
  `list_habitual_products`, `get_cart`, `add_to_cart`, `update_quantity`,
  `remove_from_cart` — plus les 7 outils recette ;
- les schémas d'entrée sont cohérents avec la surface historique :
  `query` (recherches), `product_id` (+ `quantity` pour le panier),
  `store_id` (+ `host` optionnel) pour `set_store` ;
- les annotations distinguent lectures (`readOnlyHint`) et mutations
  (`destructiveHint`/`idempotentHint`) — le client hôte peut en dériver sa
  politique d'approbation ;
- `untrustedContentHint` est présent sur `search_product`, `find_stores` et
  `list_habitual_products` (contenu de catalogue traité comme donnée non
  fiable).

## M02 — lectures depuis l'onglet réel

1. `tools/call` sur `get_store`, puis `search_product` avec
   `{ "query": "lait de coco" }`, puis `get_cart`.
2. Vérifie que les réponses correspondent à la page ouverte dans l'onglet
   (mêmes produits, même panier).

Attendu : réponses textuelles valides, formatées, sans exception brute ; les
libellés sont nettoyés par `scrubUntrusted` mais restent de simples données.

## M03 — mutations relisibles sur le panier réel

1. Après approbation explicite côté client hôte, `tools/call` sur
   `add_to_cart` avec un `product_id` issu de M02, puis
   `update_quantity` (quantité cible), puis `get_cart`.
2. Vérifie le panier dans l'onglet Leclerc lui-même, puis
   `remove_from_cart` et re-vérifie.

Attendu : chaque mutation retourne le panier mis à jour ; `get_cart` après
chaque mutation reflète l'état réel de l'onglet (lecture et écriture partagent
le même `fetch` authentifié de la page).

## M04 — erreurs normalisées, mutations identifiables

1. Appelle `search_product` avec une requête inconnue → texte
   « Aucun produit trouvé… », pas d'erreur.
2. Appelle `add_to_cart` avec un `product_id` inventé → réponse
   `isError: true` avec un message normalisé en français, sans stack trace
   ni fuite d'exception interne.
3. Vérifie dans `tools/list` que les annotations des trois mutations
   (`add_to_cart`, `update_quantity`, `remove_from_cart`) sont bien exposées
   au client hôte pour sa politique d'approbation.

Attendu : aucune donnée de session (cookie, datadome) ne quitte l'onglet ;
les erreurs traversent le relay sous forme texte uniquement.

## Garde-fous vérifiés au passage

- La porte SSRF (`isLeclercHost`) et la validation d'hôte de `set_store`
  sont inchangées : un `host` non-Leclerc est refusé.
- Les cookies restent dans l'onglet : chaque `fetch` part du contexte MAIN
  world de la page, jamais d'un process Node (ADR-0001/0002).
- Le garde `__mcpLeclercDriveInjected` empêche la double injection.

## Non-exécuté en CI

Ce parcours exige un vrai navigateur connecté et une vraie session Leclerc ;
il est donc documenté ici et exécuté à la main, à chaque changement de la
surface WebMCP (projection `src/webmcp/projection.ts`, enregistrement dans
`extension/inject.ts`). Aucun job CI ne le déclenche, volontairement.
