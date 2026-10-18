# Test navigateur du panneau latéral — opt-in (ticket #51)

Statut : **opt-in, jamais exécuté en CI.** Ce protocole passe par le vrai chemin
de bout en bout — extension chargée dans Chrome, onglet Leclerc Drive connecté,
panier réel du drive — ce que la CI ne peut pas fournir (et ne doit pas : aucune
session ne sort jamais de l'onglet, cf. ADR-0001/ADR-0004). Les tests
automatisés du dépôt couvrent la partie pure (`tests/sidepanel-protocol.test.ts` :
machine à états, portail d'approbation, aller-retour de clarification,
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
- Ouvrir le panneau : icône « panneau latéral » de la barre d'outils Chrome →
  sélectionner **mcp-leclerc-drive**. (Le clic sur l'icône de l'extension
  ouvre toujours le popup existant, inchangé.)

## Fournisseurs

La sélection du fournisseur est **explicite et manuelle** (menu Réglages) :

- **Scénario simulé** — script déterministe hors ligne : la recette est
  générée sans réseau, mais les recherches produits, l'aperçu, l'approbation
  et le panier sont RÉELS. C'est le chemin recommandé pour ce protocole.
- **Modèle local (WebGPU)** — génération via le document offscreen (le seul
  contexte avec accès WebGPU) ; exclusif WebGPU, aucun repli CPU/WASM.
- **Mistral (clé personnelle)** — uniquement si une clé est enregistrée
  (Réglages → Clé Mistral). La clé reste en mémoire de session
  (`chrome.storage.session`), n'est jamais affichée en retour et disparaît à
  la fermeture du navigateur.

## P1 — parcours complet : demande → recette → recherche → aperçu → approbation → panier réel

1. Réglages : sélectionne « Scénario simulé ».
2. Sans envoyer de demande, vérifie que le bouton d'approbation n'existe pas
   encore et note l'état du panier Leclerc (nombre de lignes).
3. Saisis « un poulet au curry pour 4, sans crème », convives 4, exclusion
   « crème » → **Envoyer**.
4. Attendu, dans l'ordre :
   - phase « Génération de la recette… », puis la **recette** (titre, convives,
     ingrédients, étapes ; durées affichées « indicatives, non vérifiées ») ;
   - phase « Recherche produits… » avec une ligne d'activité par recherche
     (nombre de produits trouvés, aperçu des libellés) ;
   - l'**aperçu du panier** (articles, quantités, prix unitaires, totaux,
     avertissement « données du catalogue Leclerc non garanties »). Sans
     conditionnement structuré dans l'extraction réelle, la quantité par
     défaut documentée (1 unité) s'applique et est signalée ;
   - la **validation globale** avec les deux boutons « Approuver et ajouter au
     panier » / « Refuser ».
5. CRITIQUE : à ce stade, le panier Leclerc doit être **inchangé** — aucune
   écriture n'a lieu avant l'approbation.
6. Clique « Approuver et ajouter au panier ». Attendu : phase « Ajout au
   panier… », puis résultat « Parcours terminé » ; les articles apparaissent
   dans le panier réel de l'onglet Leclerc (les quantités sont arrondies au
   nombre de conditionnements, cf. règle du plafond documentée).

## P2 — refus : le panier reste inchangé

Recommence P1 avec une autre demande, mais clique **Refuser** à la validation.
Attendu : message « Ajout au panier refusé : aucun article n'a été ajouté »,
parcours arrêté (phase « Prêt »), panier Leclerc strictement identique à
l'état d'avant la demande.

## P3 — échec partiel : arrêt, relecture du panier, reprise après accord

1. Déclenche une mutation qui échoue en cours d'ajout : le plus simple est de
   fermer l'onglet Leclerc (ou couper le réseau) après l'approbation, pendant
   la phase « Ajout au panier… ».
2. Attendu : la parcours s'arrête au premier échec, relit l'état réel du
   panier, affiche le rapport d'écart (ajoutés / en échec / non tentés) et
   propose « Reprendre le parcours restant ».
3. Rouvre l'onglet Leclerc, reconnecte-toi si besoin, puis « Reprendre le
   parcours restant » → une **nouvelle validation globale** est demandée
   (l'approbation précédente ne porte jamais sur la reprise). Après accord,
   les articles restants sont ajoutés.

## P4 — survie à une suspension du service worker MV3

1. Lance une demande et attends la validation globale SANS cliquer.
2. Force la suspension du service worker : `chrome://extensions` →
   mcp-leclerc-drive → « Service worker » → dans les DevTools ouverts, bouton
   « Terminate », ou attends le délai d'inactivité (ferme le panneau pour
   couper le keep-alive).
3. Attends la relance (rouvre le panneau : le `get_state` initial réveille le
   worker).
4. Attendu :
   - l'historique de la conversation est **intact** (chrome.storage.session) ;
   - l'approbation en attente est toujours là, et « Approuver et ajouter au
     panier » fonctionne : l'aperçu stocké est appliqué via le chemin de
     reprise (le clic EST la décision) ;
   - si la suspension a eu lieu pendant une phase d'exécution (génération,
     recherche, ajout), un message explicite signale le parcours interrompu ;
     aucune écriture orpheline n'est émise.

## P5 — historique de session uniquement

1. Ferme entièrement Chrome, rouvre-le, recharge l'extension si nécessaire,
   rouvre le panneau.
2. Attendu : conversation vide (rien ne survit à la fermeture du navigateur ;
   l'historique ne va jamais dans `chrome.storage.local`). Seule la sélection
   de fournisseur — un réglage — est conservée dans l'instantané de session.
3. En cours de session, « Réinitialiser la conversation » vide l'historique et
   l'état du parcours en gardant les réglages.

## P6 — clarification (produit ambigu)

Si la règle de correspondance déterministe ne peut pas trancher entre deux
produits ex æquo (par ex. deux conditionnements de lait de coco), une
**question** apparaît avec un bouton par candidat (libellé, prix,
conditionnement) et « Ne pas ajouter cet ingrédient ». Répondre par un clic
poursuit le parcours avec le produit choisi ; passer ajoute l'ingrédient à la
liste des exclus du panier, sans jamais inventer d'identifiant.

## P7 — Mistral BYOK (optionnel, nécessite une clé)

1. Réglages → Clé Mistral : saisir la clé → Enregistrer. Attendu : « Clé
   enregistrée (jamais affichée) » — la clé n'est jamais renvoyée vers l'UI,
   ni dans les messages d'erreur, ni dans l'historique.
2. Sélectionne « Mistral », lance une demande : la recette est générée par
   l'API, le reste du parcours est identique.
3. « Supprimer » → un nouveau parcours Mistral est refusé avec le message
   « Aucune clé Mistral enregistrée. » Aucun appel réseau Mistral n'a lieu
   sans clé ni sans sélection explicite.

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
