# Roadmap — mcp-leclerc-drive

> Document vivant. La « Proposition бассе » qui suit est un bac-à-sable d'idées
> réunies en croisant **le code existant**, **la capture API** (`docs/api-capture.md`,
> « Points ouverts ») et **la spec WebMCP / MCP-B** (https://docs.mcp-b.ai).
> Rien ici n'est engagé ; tout est ouvert à discussion via issues/PR.

## État actuel (v1.0 — WebMCP)

Neuf outils, exécutés dans l'onglet Chrome connecté via une extension MV3 + le
relay local `@mcp-b/webmcp-local-relay` :

| Domaine | Outils |
| --- | --- |
| Magasin | `find_stores`, `set_store`, `get_store` |
| Catalogue | `search_product`, `list_habitual_products` |
| Panier | `get_cart`, `add_to_cart`, `update_quantity`, `remove_from_cart` |

Architecture éprouvée : logique métier pure (`src/leclerc/api.ts`, sans `fetch`
ni Node), injection MAIN-world, throttle anti-DataDome, fermeture SSRF
(`isLeclercHost`), épuration anti-injection de prompt (`scrubUntrusted`).

## Direction

Faire de cet outil le **bras de login** le plus sûr et le plus utile pour ses
courses Leclerc Drive, pilotable depuis n'importe quel client MCP — sans jamais
extraire de cookie ni réinventer l'authentification. Deux axes :

1. **Couverture fonctionnelle** — recouvrir davantage du parcours de courses
   réel (listes, catalogue structuré, créneaux, validation de commande).
2. **Qualité d'intégration** — exploiter plus à fond le modèle WebMCP
   (ressources, prompts, cycle de vie dynamique, human-in-the-loop) pour réduire
   le bruit imposé au modèle et durcir les actions sensibles.

## Roadmap par horizon

### Court terme — fiabilité & qualité de vie

- **Endpoint panier en lecture propre.** Aujourd'hui `get_cart` scrape une page
  `recherche.aspx?TexteRecherche=<no-match>` (cf. `NO_MATCH_QUERY` et « Points
  ouverts » de `docs/api-capture.md`). Investiguer un endpoint panier read-only
  natif pour supprimer ce contournement HTML.
- **Confirmer l'omission de `objContexteProvenanceArticle` sur `add`.** Vérifié
  omittable sur `remove` seulement.
- **Surface riche côté client** — exposer `Product.imageUrl`, Nutri-Score et
  `pricePerUnit` comme champs structurés (pas seulement dans le texte formaté),
  pour que les clients MCP qui supportent les images les montrent nativement.
  La spec WebMCP autorise les `content` de type `image` dans `CallToolResult`.
- **Tests de bout en bout pilotés par le relay.** Le `CONTRIBUTING.md` mentionne
  un harnais relay ; le formaliser dans CI (vaultien, marqué `@local-only`).
- **Recharge automatique DataDome.** Détecter une page de challenge dans
  `assertStorePage` et guider l'utilisateur (ou déclencher un `location.reload()`
  de l'onglet via le background worker) plutôt que лишь lever une erreur.

### Moyen terme — couverture fonctionnelle

- **`list_categories` / `browse_catalog`.** Parcourir rayons/familles (`iIdRayon`,
  `iIdFamille`, `niIdSousFamille` déjà présents dans `RawProduct`) plutôt que
  only free-text search — utile pour « montre-moi les promos du rayon frais ».
- **Promotions & « prix carrefour »-like.** Distinguer `sPrixPromo` vs
  `nrPVUnitaireTTC` dans `mapProduct` + un outil `list_promos` (page promos du
  drive) pour planifier une liste de courses à budget.
- **Listes sauvegardées / favoris.** Page « produits habitués » déjà couverte ;
  étendre aux listes personnelles (si endpoint existe) et à un
  `save_cart_as_list(name)`.
- **Gestion multi-listes de courses (caddies nommés).** Permettre plusieurs
  paniers nommés sauvegardés côté extension (`chrome.storage`) qu'on recharge
  dans le panier Leclerc courant.

### Long terme — fin du parcours & portée

- **Checkout & réservation de créneau.** Reverse-engineer le flux de commande
  (créneau de retrait/livraison, validation panier). Sensible — exige un gate
  human-in-the-loop strict (voir Zone Propositions).
- **Switch drive côté serveur.** Ingénierie inverse de l'appel « switch drive »
  de Leclerc pour que `set_store` puisse rattacher la session à n'importe quel
  drive sans obliger l'utilisateur à naviguer manuellement dessus. Aujourd'hui
  point ouvert explicite (`docs/api-capture.md` §5).
.

---

## 🧪 Zone Propositions

Idées non triées, à évaluer puis promouvoir en roadmap. Chacune indique sa
source d'inspiration (code / capture / spec WebMCP).

### 1. Exposer le panier comme une *Resource* WebMCP `leclerc://cart`

**Source :** spec WebMCP — `registerResource` (« data endpoints read-only »),
aujourd'hui inutilisée par le projet.

Plutôt que de forcer l'agent à appeler `get_cart` pour deviner l'état, enregistrer
une ressource `leclerc://cart` (et `leclerc://store`) que les clients MCP
échantillonnent automatiquement. Le modèle obtient le panier *sans consommer un
tour d'outil*, et les tea-vraiment-coût de DataDome baissent (une lecture
partagée cacheable côté page). Compose bien avec le plan « surface riche ».

### 2. Prompts standardisés (« templates de courses »)

**Source :** spec WebMCP — `registerPrompt`.

Enregistrer des prompts applicatifs : « courses hebdo » (lister habituels + ajouter
manquants), « budget 50€ » (optimiser le panier sous budget), « remplir mon
frigo à partir d'une recette ». Les clients MCP qui montrent les prompts les
proposent directement — l'utilisateur ne doit pas connaître les noms d'outils.

### 3. Cycle de vie dynamique des outils (AbortSignal)

**Source :** spec WebMCP — « tool lifecycle and context replacement ».

Aujourd'hui les 9 outils sont enregistrés une fois statiquement. La spec invite
à ne montrer que les actions actuellement *significatives et autorisées* : ne
proposer `checkout` que si un créneau est sélectionnable, ne proposer
`update_quantity` que sur les lignes réellement au panier, etc. Réenregistrer
dynamiquement sur changement de contexte (route, état panier). Réduit le bruit
imposé au modèle et la tentation d'appels inutiles (doncDataDome).

### 4. Human-in-the-loop natif pour les actions destructives/sensibles

**Source :** spec WebMCP — « Security and human-in-the-loop » ; `destructiveHint`
déjà posé sur `remove_from_cart` / `update_quantity(0)`.

Ajouter une confirmation UI in-page (via `chrome.notifications` ou un toast
injecté) pour `remove_from_cart`, `clear_cart`, et surtout tout futur
`checkout`. WebMCP insiste : « a tool name is not a permission check ». Le gate
se fait côté page, pas côté modèle — cohérent avec l'architecture « fetch de la
page ».

### 5. `clear_cart` (vider tout le panier en une fois)

**Source :** code — `remove_from_cart` boucle une ligne à la fois ; pas d'outil
bulk.

Très demandé en pratiques pour « je recommence mes courses ». Risque DataDome
(rAF de mutations) → implémenter comme **une seule** opération serveur si
Leclerc l'expose, sinon comme boucle sérialisée réutilisant le throttle. Marquer
explicitement `destructiveHint: true` et l'assortir du gate §4.

### 6. Extraction DOM intelligente (`@mcp-b/smart-dom-reader`)

**Source :** spec WebMCP — paquet `@mcp-b/smart-dom-reader`.

Pour les pages mal fermées par JSON (panier, créneaux), plutôt qu'à nouveau
addField-by-field scraper HTML, brancher le lecteur DOM intelligent de MCP-B
pour récupérer un contexte structuré fiable. Réduit la fragilité observée dans
`scanProductRecords` / `extractArrayNamed` quand Leclerc change son HTML.

### 7. Tool « recettes → panier » (ingrédient matching)

**Source :** idée produit, s'appuie sur `search_product` + `add_to_cart`.

Outil `add_recipe(recipe_text, servings)` qui parse une recette libre, cherche
chaque ingrédient, demande clarification sur les ambigus, ajoute au panier.
Vrai cas d'usage « IA agent », différenciant vs le site web classique.

### 8. Ressource `leclerc://promos` + outil `compare_prices`

**Source :** capture API — `sPrixPromo`, prix au kilo déjà parsés.

Exposer les promos du drive comme ressource puis un outil `best_price(query,
limit)` qui trie par `pricePerUnit` (utile au kg/litre pour comparer formats).
Aujourd'hui le tri côté page est perdu — on ne renvoie que l'ordre de Leclerc.

### 9. Stockage multi-drives côté extension

**Source :** code — `chrome.storage` déjà dans les permissions du manifest, mais
l'active-store vit dans le `localStorage` de la page (ADR-0005).

Permettre de mémoriser plusieurs drives favoris et de basculer sans re-saisir
`find_stores`. Tant que le « switch drive côté serveur » (long terme) n'est pas
résolu, ça guide au moins l'utilisateur vers le bon onglet à ouvrir.

### 10. Telemetry de santé (offline, jamais exporté)

**Source :** code — `console.info` au boot ; aucun compteur.

Compteur local dans `chrome.storage` : nombre de 403/429, latence moyenne,
dernier succès. Exposé via `get_store` ou une ressource `leclerc://health` pour
aider au support sans aucune télémétrie sortante (cohérent avec le modèle de
confidentialité « no exfiltration »).

### 11. Support image dans `search_product`

**Source :** spec WebMCP — `CallToolResult` accepte `content` de type `image`.

Renvoyer les vignettes (`sUrlVignetteProduit`) comme `image` content en plus du
texte. Les clients multimodaux (Claude) montrent les produits. `untrustedContentHint`
reste posé ; l'image est traitée comme non fiable.

### 12. Auto-détection du drive au premier lancement

**Source :** code — `loadStore()` erreure si ni URL ni sauvegarde.

En l'absence de magasin, appeler `find_stores` sur une géoloc navigateur
(`navigator.geolocation`) ou le drive déjà ouvert dans un autre onglet Leclerc
(via `chrome.tabs.query`) pour amorcer sans friction.

---

## Comment contribuer à cette roadmap

- Ouvre une issue pour discuter d'une proposition avant de coder.
- Une proposition acceptée devient un objectif de roadmap ci-dessus, avec un
  ADR si c'est une décision d'architecture (voir `docs/adr/`).
- Respecte `CONTRIBUTING.md` : `api.ts` reste pure, `inject.ts` reste le seul
  endroit qui `fetch`, et `isLeclercHost` reste la porte SSRF.