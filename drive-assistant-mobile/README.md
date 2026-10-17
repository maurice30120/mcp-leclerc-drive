# Drive Assistant Mobile

Solution mobile **autonome et isolée** du projet `mcp-leclerc-drive`. Aucun
fichier en dehors de `drive-assistant-mobile/` n’est modifié : le projet
Chrome/WebMCP/orchestrateur existant reste intact et sert uniquement de
**référence de lecture** pour les concepts Leclerc déjà reverse-engineerés.

## Objectif

Un assistant courses Leclerc Drive **on-device** sur iOS/Android :

1. Une WebView Leclerc officielle pour le login, la session et le panier réel.
2. Un connecteur Leclerc local (recopie minimale du reverse engineering).
3. Un runtime IA distant Mistral, appelé depuis l’app mobile.
4. Un runtime MCP interne à l’app (registre de tools, validation schéma,
   logs, permissions read/mutation).
5. Une validation utilisateur obligatoire avant toute mutation panier.

## Structure

```text
drive-assistant-mobile/
├── app.json
├── index.js
├── package.json
├── babel.config.js
├── react-native.config.js
├── tsconfig.json
├── tsconfig.test.json
├── src/
│   ├── app/                    # navigation + écrans racine
│   ├── features/
│   │   ├── webview/            # WebView Leclerc + capture session
│   │   ├── assistant/          # chat outillé + confirmation panier
│   │   ├── ai/                 # prompt, parse/validate plan, client/runtime Mistral
│   │   ├── mcp/                # registre/distributeur/permissions/logs/historique
│   │   ├── leclerc/            # connecteur local (parsing + fetch)
│   │   └── safety/             # garde-fous (no productId modèle, pas de WebView direct…)
│   └── shared/                 # types + helpers
└── tests/                      # node:test (logique pure) — voir ci-dessous
```

## Garde-fous (invariants)

- Le modèle ne touche **jamais** directement la WebView.
- Le modèle ne produit **jamais** de `productId`.
- Les `productId` viennent **uniquement** des résultats réels de recherche Leclerc.
- **Aucune** mutation panier sans clic explicite de validation.
- **Aucun** paiement, checkout ou validation de commande.
- **Aucun** stockage de mot de passe ou données bancaires.
- Les cookies restent limités au besoin de session mobile.

## Lancer et tester sur le poste de dev

Depuis la racine du dépôt `mcp-leclerc-drive` :

```sh
npm run mobile:start                       # serveur Metro natif http://localhost:8081
npm run mobile:android -- --no-packager    # installe/lance Android avec Metro déjà ouvert
npm run mobile:ios                         # build/run iOS (nécessite Xcode complet + CocoaPods)
npm run mobile:typecheck                   # tsc --noEmit (src + tests)
npm run mobile:test                        # node:test (55 tests, logique pure)
```

Le projet cible uniquement Android et iOS. Il n'y a plus de preview navigateur :
la WebView Leclerc est testée dans l'app native.

Android :

- Un projet natif `android/` est présent.
- Le script `npm run mobile:android` force OpenJDK 17 via Homebrew quand il est
  disponible (`/opt/homebrew/opt/openjdk@17/...`), car Gradle 9 refuse Java 11.
- Vérifié sur l'AVD `Medium_Phone_API_36.0` : APK debug compilé, installé et
  lancé ; la WebView Leclerc affiche l'écran de connexion.

iOS :

- Un projet natif `ios/` est présent.
- Le poste doit avoir Xcode complet sélectionné (`xcodebuild` et `simctl`) et
  CocoaPods (`pod install`) avant `npm run mobile:ios`.
- Si `xcode-select` pointe seulement sur Command Line Tools, le lancement iOS
  échoue avant compilation.

Depuis `drive-assistant-mobile/`, les commandes équivalentes restent
`npm start`, `npm run android`, `npm run ios`, `npm run typecheck` et
`npm test`.

### Ce qui a été corrigé pour l'env de dev

- `@react-native-community/cli` (+ plateformes) ajoutés en devDependencies :
  RN 0.82 ne bundle plus le CLI.
- `ios/` et `android/` générés avec React Native 0.82 pour lancer l'app sur
  simulateur/émulateur au lieu de seulement bundler le JS.
- `react` / `@types/react` alignés sur React 19, requis par React Native 0.82.
- `@react-native/metro-config` + `metro.config.js` ajoutés pour le bundling.
- `babel.config.js` pointe sur `module:@react-native/babel-preset` (le preset
  `react-native-babel-preset` n'existe pas en 0.82).
- `"type": "module"` retiré du `package.json` : les configs RN/Babel sont en
  CommonJS ; les tests `.ts` restent en ESM via `--experimental-strip-types`
  (Node détecte le syntax ESM des fichiers TypeScript).
- `lint`/`clean` scripts ajustés (le `lint` eslint a été retiré faute de config).

## Scénarios de tests

- parsing JSON modèle + rejet ids hallucinés (`tests/plan.test.ts`)
- normaliseur déterministe de liste de courses (`tests/shopping-list.test.ts`)
- validation des tools / permissions read vs mutation (`tests/dispatcher.test.ts`)
- construction des appels search/add_to_cart (`tests/workflow.test.ts`)
- blocage mutation sans confirmation (`tests/safety.test.ts`)
- connecteur Leclerc avec `fetch` mocké (`tests/leclerc-connector.test.ts`)
- scénario complet mocké : demande → plan → recherche → proposition →
  validation → ajout panier (`tests/e2e-mock.test.ts`)

> Un smoke test manuel réel sur device (login WebView, session, recherche,
> ajout validé, panier visible) reste à exécuter (voir `docs/smoke-test.md`).

## Initialisation native (scaffold)

Ce dépôt contient la couche TS/RN applicative ; les dossiers `ios/` et
`android/` natifs sont générés par le CLI React Native lorsqu’on monte le
projet pour la première fois :

```sh
npx react-native init DriveAssistantMobile --template react-native-template-typescript
# puis reporter le contenu de src/ et les configs de ce dossier dans le projet généré
```

## API Mistral

Le POC n’utilise plus de modèle local embarqué ou téléchargé. Le runtime IA
mobile utilise le SDK officiel `@mistralai/mistralai` (`new Mistral(...)`,
`mistral.chat.complete(...)`) avec le modèle `mistral-small-latest`, en mode
JSON, puis le plan reste validé par `src/features/ai/plan.ts`.

Configuration locale :

```sh
cp .env.example .env
npm run prepare:env
```

`MISTRAL_API_BASE_URL` doit rester sur la base serveur du SDK
(`https://api.mistral.ai`) : le SDK ajoute lui-même les routes `/v1/...`.

Pour ce POC, la clé Mistral est lue depuis `.env` au bootstrap, puis importée
dans le SecureStore applicatif par l’écran **Réglages Mistral**. Comme cette
app React Native CLI n’est pas une app Expo, ce SecureStore est adossé au
Keychain/Keystore natif via `react-native-keychain`.

Ce choix reste temporaire : la clé `.env` est générée dans
`src/features/ai/env.generated.ts` et donc embarquée dans le bundle mobile tant
qu’on garde le bootstrap POC. Toute personne qui extrait l’APK/IPA ou le bundle
JS peut récupérer la clé. Avant une diffusion hors POC, déplacer l’appel
Mistral derrière un backend/proxy avec authentification applicative, quotas,
rotation de clé et journalisation serveur.

## Relation avec `mcp-leclerc-drive`

| | `mcp-leclerc-drive` (référence) | `drive-assistant-mobile` (ce projet) |
| -- | -- | -- |
| Cible | Extension Chrome + WebMCP + MCP stdio | App mobile native |
| Session Leclerc | Onglet Chrome connecté (fetch de la page) | WebView Leclerc dans l’app |
| IA | Transformers.js / ONNX (Qwen3 0.6B) | API Mistral (`mistral-small-latest`) |
| MCP | Pont WebMCP vers client stdio | Runtime MCP interne à l’app |
| Statut | Inchangé (lecture seule) | Nouveau, isolé |
