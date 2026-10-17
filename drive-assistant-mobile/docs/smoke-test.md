# Smoke test manuel (iOS / Android)

Procédure à exécuter sur device/émulateur pour valider le MVP réel (hors
tests unitaires de logique pure, déjà automatisés via `npm test`).

## Pré-requis

- Projet natif généré (`npx react-native init …`) avec `src/`, configs et
  `index.js` reportés.
- `react-native-webview` et `react-native-fs` linkés.
- `.env` présent, puis `npm run prepare:env` exécuté avant le bundle Metro.
- Ouvrir **Réglages Mistral** au moins une fois si besoin pour importer,
  remplacer ou tester la clé dans le SecureStore applicatif
  (Keychain/Keystore via `react-native-keychain`).
- POC assumé : la clé `.env` de bootstrap est embarquée dans le JS mobile
  généré. Ne pas distribuer cette build hors POC sans backend/proxy.

## Scénario

1. **Accueil / Réglages** : API Mistral `idle/loading` → état `ready`, ou
   ouvrir Réglages Mistral pour enregistrer/tester la clé.
2. **WebView Leclerc** :
   - Ouvrir la WebView → naviguer vers un drive, se connecter officiellement.
   - Vérifier : `Connexion Leclerc : ✅ connectée` sur l'accueil, host/storeId
     corrects (`fdN-courses.leclercdrive.fr` / magasin-053701…).
   - Aucun mot de passe demandé par l'app. Panier réel visible dans la WebView.
3. **Assistant** :
   - Saisir « lait demi-écrémé 1L, pâtes, tomates x3 ».
   - Vérifier : un Plan JSON est produit, des `search_products` remontent des
     produits **réels** (productId issus uniquement de la recherche).
   - Sélectionner un produit par item, ajuster la quantité.
4. **Validation mutation** :
   - Cliquer **Valider les ajouts** → ajout panier effectué (ticket de
     confirmation consommé, anti-rejeu).
   - Vérifier dans la **WebView** (panier.aspx) que les lignes apparaissent.
5. **Historique** :
   - Ouvrir l'écran Historique : actions MCP journalisées, ajout visible,
   - Cliquer **Annuler l’ajout** → `remove_from_cart` (mutation confirmée) ;
     panier mis à jour côté WebView.

## Invariants à vérifier (échec = bug)

- ❌ L'API IA ne touche jamais la WebView.
- ❌ Aucun productId de l'IA n’arrive jusqu’à `add_to_cart`
  (test `e2e-mock : refus d’un productId absent des résultats`).
- ❌ Aucune mutation sans clic Valider
  (test `runner : mutation refusée sans ticket`).
- ❌ Aucun paiement / checkout / validation de commande (intent bloquée).
- ❌ Aucun stockage de mot de passe / CB.

## Rollback

L'écran Historique propose l'annulation des ajouts de session tant que la
session WebView le permet (`remove_from_cart`).
