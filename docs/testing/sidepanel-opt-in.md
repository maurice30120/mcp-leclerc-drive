# Test navigateur du panneau latéral — opt-in (ticket #51)

Statut : **opt-in, jamais exécuté en CI.** Ce protocole passe par le vrai chemin
de bout en bout — extension chargée dans Chrome, onglet Leclerc Drive connecté,
panier réel du drive — ce que la CI ne peut pas fournir (et ne doit pas : aucune
session ne sort jamais de l'onglet, cf. ADR-0001/ADR-0004). Les tests
automatisés du dépôt couvrent la partie pure (`tests/sidepanel-protocol.test.ts` :
machine à états, intentions de mutation, clarifications regroupées,
sémantique session-only de l'historique) ; ce document décrit la vérification
humaine du panneau latéral.

## Prérequis

- Chrome (profil avec une session Leclerc Drive active).
- L'extension chargée non empaquetée depuis `dist/extension/`
  (`chrome://extensions` → « Charger l'extension non empaquetée »), après
  `npm run build:extension`.
- Un onglet ouvert sur TON drive Leclerc
  (ex. `https://fd9-courses.leclercdrive.fr/magasin-XXXXXX-XXXXXX-.../`) :
  c'est l'onglet qui exécute réellement les recherches et les mutations du
  panier via le pont WebMCP existant. Le panneau latéral ne modifie jamais
  l'interface du site Leclerc.
- Ouvrir le panneau depuis le popup : sélectionner Mistral, saisir par exemple
  « je veux faire un casoulet 5 personne », puis **Préparer mes courses**.
  Les demandes de recette sont dirigées vers l'assistant ; **Préparer une
  recette** permet aussi de lui envoyer un simple nom de plat. La clé et le
  modèle choisis dans le popup sont repris pour la session, sans nouvelle saisie.
  Les listes explicites de produits conservent leur parcours dans le popup.
- On peut aussi ouvrir le panneau via l'icône « panneau latéral » de Chrome →
  sélectionner **mcp-leclerc-drive**, puis choisir un fournisseur dans Réglages.

## Fournisseurs

La sélection du fournisseur est **explicite et manuelle** (menu Réglages) :

- **Scénario simulé** — script déterministe hors ligne : la recette est
  générée sans réseau, mais les recherches et le panier sont réels. Le script de recette seul ne fournit pas d'évaluation des produits : ils sont alors soumis au choix humain.
- **Modèle local (WebGPU)** — génération via le document offscreen (le seul
  contexte avec accès WebGPU) ; exclusif WebGPU, aucun repli CPU/WASM.
- **Mistral (clé personnelle)** — uniquement si une clé est enregistrée
  (Réglages → Clé Mistral). La clé, le modèle et le fournisseur choisi sont conservés localement puis restaurés après fermeture du navigateur. La clé n'est jamais affichée en retour ; **Supprimer** efface ses copies locale et de session.

## P1 — demande → vérifications → ajouts progressifs → révision finale

1. Choisir explicitement Mistral avec sa clé, ou le modèle local disponible.
2. Noter les quantités du panier initial. Envoyer « un cassoulet pour 5 personnes ».
3. Vérifier les recherches et la consultation des habitudes d'achat, puis les
   états par ingrédient : recherche, vérification, ajouté, choix nécessaire, échec.
4. Dès qu'un choix est étayé, vérifier son ajout dans le panier réel sans clic
   d'approbation globale et sans attendre les autres ingrédients. La quantité
   doit couvrir le besoin selon le conditionnement réel.
5. Vérifier les doutes regroupés, trois propositions maximum par ingrédient.
   Si trois choix restent plausibles, aucun ne doit être ajouté automatiquement.
6. Choisir un produit ou passer chaque ingrédient. Un conditionnement inconnu
   exige le nombre de paquets explicite. « Ajouter les produits choisis » ajoute
   les seuls produits choisis, puis le panier est relu.
7. La révision finale présente le panier déjà rempli. « Terminer la vérification »
   clôt la révision et ne déclenche aucune mutation.

## P2 — suppression d'une contribution avec produit préexistant

1. Placer au préalable deux unités d'un produit qui sera sélectionné.
2. Préparer la recette et noter le nombre de paquets ajoutés par le parcours.
3. Cliquer « Supprimer l'ajout de l'agent ». Vérifier que les deux unités
   préexistantes restent et que seule la contribution du parcours est supprimée.
4. Un nouvel essai de la même suppression ne doit rien retirer de plus. Pour deux
   ingrédients utilisant le même produit, supprimer l'un préserve l'autre.

## P3 — mutation échouée ou réponse perdue, reprise sans doublon

1. Couper le réseau pendant un ajout ou sa relecture.
2. Vérifier le bilan : ajouts confirmés, échec ou résultat à vérifier, besoins
   restant à traiter. Une réponse perdue ne doit pas être annoncée comme un ajout confirmé.
3. Rétablir la connexion et cliquer « Reprendre le parcours restant ».
4. La reprise relit le panier avant toute mutation et ne régénère pas la recette.
   Un ajout déjà appliqué n'est pas doublé. Un ajout non appliqué utilise la même
   quantité cible absolue. Une suppression interrompue reprend comme suppression.
5. En cas de quantité externe incompatible ou de changement de magasin, vérifier
   le diagnostic et l'absence d'écriture automatique risquant d'altérer le panier.

## P4 — suspension du service worker

1. Suspendre le worker pendant une vérification, une mutation ou un choix humain.
2. Rouvrir le panneau : le journal de session et les quantités confirmées restent
   visibles ; une mutation en attente conserve sa référence et sa cible.
3. Reprendre et vérifier que l'intention est réconciliée avec le panier réel avant
   de continuer. Aucun besoin déjà ajouté n'est ajouté une deuxième fois.

## P5 — fermeture du navigateur et journal local

Le journal des contributions et la configuration Mistral sont conservés séparément dans `chrome.storage.local`. La conversation reste en `chrome.storage.session`.

1. Fermer entièrement le navigateur pendant un parcours, puis rouvrir le panneau.
2. Vérifier que le bilan et l'intention en attente sont retrouvés, avec le fournisseur Mistral et le modèle précédemment choisis. « Clé enregistrée » est affiché, sans réafficher la clé elle-même.
3. Si la recette nécessite encore une évaluation, reprendre sans nouvelle saisie de la clé. La reprise réutilise la recette enregistrée. Vérifier ensuite **Supprimer**, fermer et rouvrir : la clé supprimée ne doit pas réapparaître.
4. Une réconciliation ou suppression après sélection complète ne doit pas exiger
   de nouveau modèle. Terminer la vérification avant de commencer un autre parcours.

## P6 — boucle bornée et doutes humains

Vérifier deux tours d'évaluation, un troisième uniquement si une recherche peut
encore apporter une information utile, et trois recherches distinctes maximum
par ingrédient. Les habitudes ne rendent pas un produit inadapté acceptable.
Des haricots cuits à la place de secs nécessitent un choix humain ; un changement
de marque ou de taille de paquet compatible peut être automatique.

## P7 — Mistral BYOK (optionnel, nécessite une clé)

1. Réglages → Clé Mistral : saisir la clé → Enregistrer. Attendu : « Clé
   enregistrée (jamais affichée) » — la clé n'est jamais renvoyée vers l'UI,
   ni dans les messages d'erreur, ni dans l'historique.
2. Sélectionne « Mistral », lance une demande : la recette est générée par
   l'API, le reste du parcours est identique.
3. « Supprimer » → un nouveau parcours Mistral est refusé avec le message
   « Aucune clé Mistral enregistrée. » Aucun appel réseau Mistral n'a lieu
   sans clé ni sans sélection explicite.

### P7b — recette depuis le popup, nombre de personnes en langage naturel

1. Dans le popup, garder Mistral sélectionné avec sa clé enregistrée.
2. Saisir « je veux faire un casoulet 5 personne » → **Préparer mes courses**.
3. Vérifier l'ouverture automatique du panneau, une recette de cassoulet pour
   **5 personnes**, puis les recherches des ingrédients (et non de la phrase
   complète). Les ambiguïtés proposent des produits réels à choisir.
4. Vérifier l'aperçu : produits, quantités selon les conditionnements reconnus,
   prix et ajouts progressifs. Les choix incertains attendent une réponse humaine ; la révision finale permet les suppressions.
5. Dans le panneau, « un cassoulet pour 5 » doit également cibler 5 personnes,
   même si le champ Convives affichait précédemment 4.

## P8 — modèle local WebGPU (optionnel)

1. Réglages → « Modèle local (WebGPU) » puis lance une demande.
2. WebGPU disponible : la génération passe par le document offscreen
   (`offscreen_generate`), phases identiques au parcours simulé.
3. WebGPU indisponible : le modèle local **n'est pas lancé** ; le panneau
   affiche le diagnostic (sonde de session réelle via le document offscreen,
   aucun repli CPU/WASM) et la proposition Mistral — qui ne s'exécute que si
   tu la sélectionnes explicitement.

## P9 — téléchargement du modèle local avec consentement explicite (optionnel, ~933 Mo)

1. Réglages → « Télécharger le modèle (consentement explicite) » → confirme.
2. Attendu : progression fichier par fichier, puis « prêt » ; chaque fichier
   est vérifié contre le manifeste versionné (taille + sha256). Aucun octet
   n'est récupéré sans le clic explicite. Le chemin livré avec l'extension
   (`dist/extension/models`) reste le chemin hors-ligne privilégié du
   document offscreen.
3. « Vider le cache » repasse l'état à « non téléchargé ».

## Ce qui n'est PAS vérifiable automatiquement

- Le respect du site Leclerc (throttle DataDome du pont, aucune modification
  du DOM du site).
- Le comportement réel des prix/disponibilités du catalogue (données non
  garanties, affichées avec l'avertissement dédié).
- La stabilité WebGPU selon les machines (crash possible du processus GPU
  Chrome sur certains setups macOS, cf. notes de `src/orchestrator/models.ts`).
