# POC — Appel direct à l'API Mistral depuis l'extension MV3 (BYOK)

Ticket #48 (spec #40). Question bloquante : le provider `mistral-byok`
(`packages/agent/src/providers/mistral.ts`) peut-il appeler
`https://api.mistral.ai/v1/chat/completions` directement depuis le contexte de
l'extension (service worker MV3), sans backend ni proxy intermédiaire ?

> **Statut : en attente de validation dans Chrome.** Ce document décrit les
> points techniques et la procédure exacte de validation. Aucun résultat n'est
> rapporté ici tant que la procédure n'a pas été exécutée — aucun faux
> résultat, aucune conclusion anticipée.

## Analyse statique (revue de code, à confirmer en conditions réelles)

Trois mécanismes régissent l'appel :

### 1. `host_permissions`

`extension/manifest.json` déclare déjà :

```json
"host_permissions": [
  "*://*.leclercdrive.fr/*",
  "https://api.openai.com/*",
  "https://api.mistral.ai/*"
]
```

Avec `https://api.mistral.ai/*` accordé, un service worker MV3 est autorisé à
faire des requêtes `fetch` vers cet hôte. **À confirmer** : requête réelle
depuis le service worker compilé (`background.js`).

### 2. CSP des pages d'extension (`connect-src`)

Le manifest MV3 actuel :

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

La CSP MV3 par défaut ne restreint pas `connect-src` : aucune directive
`connect-src` n'est définie, donc les connexions `fetch` ne sont pas bloquées
par la CSP — elles sont gouvernées par `host_permissions`. La valeur minimale
de la CSP par défaut ne peut PAS être relâchée, mais `connect-src` n'en fait
pas partie. **À confirmer** : si un futur durcissement ajoute `connect-src`,
il devra explicitement inclure `https://api.mistral.ai` (et seulement lui) :

```
connect-src 'self' https://api.mistral.ai;
```

### 3. CORS depuis le service worker

Pour les hôtes couverts par `host_permissions`, Chrome ne soumet pas la
requête de l'extension aux contrôles CORS de la page : l'appel direct depuis
le service worker est la configuration de référence pour les appels API
tierce depuis MV3. L'API Mistral renvoie par ailleurs les en-têtes CORS
nécessaires aux clients navigateur. **À confirmer** : comportement réel
(en-têtes de réponse, absence d'erreur CORS dans la console).

### Contraintes restantes (hors périmètre connectivité)

- **Coût** : chaque requête consomme le quota de la clé utilisateur. La
  génération de recette doit compter les appels (le provider expose un
  compteur `calls`) et les paramètres de génération sont épinglés
  (temperature 0, seed 0, maxTokens 1024) pour limiter les tokens.
- **Stockage de la clé** : jamais dans Git ni dans des rapports. Câblage
  `chrome.storage.local` (jamais `sync`) : ticket #51, via l'abstraction
  `SecretStore` (`packages/agent/src/byok.ts`).
- **Sélection explicite uniquement** : aucun appel réseau sans choix et
  consentement explicites, aucune bascule automatique (assertion automatisée
  dans `packages/agent/test/mistral-byok.test.ts` et
  `packages/agent/test/webgpu-provider.test.ts`).

## Procédure de validation (à exécuter dans Chrome)

Prérequis : Chrome stable récent, machine de référence, clé API Mistral
personnelle (jamais commitée).

1. **Construire l'extension** : `npm run build:extension` depuis la racine du
   dépôt.
2. **Charger l'extension non empactée** : `chrome://extensions` → « Mode
   développeur » → « Charger l'extension non empactée » → sélectionner le
   dossier `dist` de l'extension.
3. **Ouvrir la console du service worker** : sur la carte de l'extension,
   cliquer sur « Service worker » pour ouvrir DevTools dédié au contexte
   `background.js`.
4. **Exécuter le test de connectivité minimal** dans cette console (la clé
   n'est saisie que localement, jamais logée) :

   ```js
   const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
     method: "POST",
     headers: {
       Authorization: `Bearer ${/* clé personnelle */ ""}`,
       "Content-Type": "application/json",
     },
     body: JSON.stringify({
       model: "mistral-small-latest",
       messages: [{ role: "user", content: "ping" }],
       max_tokens: 8,
     }),
   });
   console.log(res.status, await res.text());
   ```

5. **Critères de décision** (consigner chaque ligne dans ce fichier après
   exécution, avec la version de Chrome et la date) :
   - `res.status === 200` et corps contenant une complétion → **faisable**.
   - Erreur CORS ou blocage CSP dans la console → **bloqué** : documenter
     l'erreur exacte, présenter l'option Mistral comme « limitée » dans
     l'interface, et soumettre un arbitrage d'architecture. Aucun backend ni
     proxy caché ne sera introduit pour contourner le blocage.
6. **Contrôles complémentaires** :
   - Vérifier dans l'onglet Network du DevTools du service worker que la
     requête part bien sans preflight bloqué.
   - Vérifier qu'une clé invalide renvoie 401 (chemin de rédaction de la clé
     couvert par les tests du provider).
   - Mesurer la latence de bout en bout (elle alimentera le rapport de
     campagne, cf. #49).
7. **Clôturer** : mettre à jour le statut en tête de ce document avec le
   résultat réel, la version de Chrome testée et la date.

## Décision en cas d'impossibilité

Si la validation échoue (CSP, CORS ou refus de permission), l'option Mistral
reste présentée dans le produit mais étiquetée « limitée — extension », et un
arbitrage d'architecture est soumis dans le ticket #48 : appels uniquement
depuis le harnais Node (où le provider fonctionne déjà via `fetchImpl`
injectable), ou abandon de l'appel direct. Aucun proxy/backend caché ne sera
ajouté sans décision explicite.
