# Bibliothèque universelle de recettes pour l’agent de courses MCP

État : publiée comme [spécification #4](https://github.com/maurice30120/mcp-leclerc-drive/issues/4), avec le label `ready-for-agent` et 33 sous-issues.

## Problem Statement

L’utilisateur veut aider son agent de courses à composer des repas et à acheter leurs ingrédients chez Leclerc Drive. Les outils actuels recherchent des produits et manipulent le panier, mais ne fournissent aucune bibliothèque de recettes réutilisable. Les découvertes culinaires faites pendant la navigation restent dispersées sur leurs sites d’origine.

L’utilisateur veut disposer immédiatement de recettes françaises et enrichir cette base avec ses propres découvertes, sans service de recettes externe. Il veut laisser à l’agent le choix de suivre ces recettes et de les adapter légèrement. Il veut aussi fiabiliser les calculs de portions et les additions d’ingrédients sans construire un moteur de raisonnement culinaire dans le plugin. La validation humaine des courses se fait directement sur le site Leclerc Drive.

## Solution

Fournir un catalogue intégré de recettes déjà structurées et une bibliothèque personnelle locale, partageant un même format JSON. L’utilisateur peut sauvegarder une page depuis l’extension sur tout site dont le contenu accessible permet de reconstituer une recette complète. La capture contient son URL et un extrait borné du contenu utile.

Au prochain appel MCP, les captures en attente sont signalées au modèle du client. Celui-ci peut consulter leur contenu, les convertir en recettes JSON et les enregistrer par un outil MCP. Une capture inexploitable est abandonnée ; aucune recette incomplète n’entre dans la bibliothèque. Chaque nouvelle recette personnelle est signalée une seule fois après sa structuration, puis reste disponible pour les recherches suivantes.

Les outils MCP permettent à l’agent de rechercher et consulter les recettes des deux collections. L’agent décide des recettes retenues, des portions et des adaptations légères. Un outil de calcul applique les facteurs de portions et additionne les ingrédients dont le nom normalisé et l’unité sont identiques. Il restitue les contributions de chaque recette et les totaux. L’agent utilise ensuite les outils Leclerc existants pour composer les achats. Le mode d’emploi nécessaire est fourni par les descriptions et schémas MCP, sans skill à installer chez le client.

## User Stories

1. As an utilisateur du plugin, I want un catalogue de recettes disponible dès l’installation, so that je puisse préparer des courses sans constituer d’abord ma propre bibliothèque.
2. As an utilisateur du plugin, I want des recettes françaises dans le catalogue initial, so that les plats et les ingrédients correspondent à mon usage habituel.
3. As an utilisateur du plugin, I want utiliser les recettes sans clé d’API de service culinaire externe, so that leur consultation reste simple et locale.
4. As an utilisateur, I want sauvegarder une page depuis l’extension pendant ma navigation, so that je puisse retrouver une découverte culinaire lors de mes prochaines courses.
5. As an utilisateur, I want pouvoir sauvegarder une recette provenant de différents sites, so that ma bibliothèque ne dépende pas d’une plateforme particulière.
6. As an utilisateur, I want que la capture soit déclenchée par mon action sur la page choisie, so that je maîtrise les contenus conservés.
7. As an utilisateur, I want conserver l’URL et un extrait utile de la page, so that l’agent dispose de matière pour structurer la recette même sans relire immédiatement le site.
8. As an utilisateur, I want que les captures et recettes personnelles restent stockées localement, so that je puisse les conserver entre mes sessions sans serveur supplémentaire.
9. As an utilisateur, I want éviter les doublons quand je sauvegarde plusieurs fois la même page, so that ma bibliothèque et les notifications restent lisibles.
10. As an agent de courses, I want découvrir les captures en attente dans les échanges MCP, so that je puisse les traiter pendant mon utilisation habituelle du plugin.
11. As an agent de courses, I want récupérer le contenu utile d’une capture, so that je puisse produire une recette structurée dans le format attendu.
12. As an utilisateur, I want que la conversion soit réalisée par le modèle de mon client MCP, so that je profite de ses capacités sans ajouter de modèle de recettes au plugin.
13. As an agent de courses, I want un contrat JSON commun au catalogue intégré et à la bibliothèque personnelle, so that je puisse réutiliser les recettes de la même manière.
14. As an utilisateur, I want que chaque recette indique ses portions de référence, so that les quantités puissent être adaptées correctement.
15. As an utilisateur, I want que chaque recette contienne des ingrédients quantifiés et des étapes de préparation, so that elle soit utilisable pour cuisiner et acheter les ingrédients.
16. As an utilisateur, I want que les portions ou quantités manquantes ne soient pas inventées, so that une recette enregistrée reste fidèle aux informations disponibles.
17. As an agent de courses, I want pouvoir abandonner une capture impossible à transformer en recette complète, so that les contenus inutilisables soient supprimés.
18. As an utilisateur, I want que seules les recettes complètes entrent dans ma bibliothèque, so that je n’aie pas à trier des fiches partielles.
19. As an utilisateur, I want conserver la catégorie et les temps de préparation ou cuisson lorsqu’ils sont disponibles, so that l’agent puisse s’en servir pour choisir des repas.
20. As an utilisateur, I want recevoir une notification unique après la structuration d’une nouvelle recette personnelle, so that je sache ce qui vient d’enrichir ma bibliothèque.
21. As an utilisateur, I want que les recettes intégrées ne soient pas annoncées comme des nouveautés personnelles, so that le digest reste pertinent.
22. As an utilisateur, I want retrouver une recette déjà annoncée lors des sessions suivantes, so that le digest ne conditionne pas sa disponibilité.
23. As an agent de courses, I want rechercher dans les deux collections et connaître l’origine des résultats, so that je puisse sélectionner les recettes adaptées à la demande.
24. As an agent de courses, I want consulter une recette complète à partir de son identifiant, so that je puisse lire ses ingrédients, portions, étapes et source.
25. As an utilisateur, I want que l’agent reste libre de suivre ou non les recettes, so that elles enrichissent mon usage habituel de préparation des courses.
26. As an agent de courses, I want sélectionner plusieurs recettes et leurs portions cibles, so that je puisse préparer les achats pour plusieurs repas ensemble.
27. As an utilisateur, I want que l’agent puisse faire des substitutions proches qui préservent l’identité d’un plat, so that il puisse adapter les courses à ma demande et aux produits disponibles.
28. As an utilisateur, I want que les adaptations faites pour une commande laissent la recette enregistrée intacte, so that je conserve une référence stable.
29. As an utilisateur, I want réserver les transformations plus importantes à une instruction de ma part, so that l’agent respecte le plat que j’ai choisi.
30. As an agent de courses, I want obtenir les quantités ajustées par un calcul déterministe, so that je puisse éviter les erreurs répétitives de multiplication des portions.
31. As an agent de courses, I want regrouper les quantités ayant le même nom normalisé et la même unité, so that plusieurs recettes produisent une liste d’ingrédients consolidée.
32. As an agent de courses, I want que les ingrédients aux noms ou unités différents restent distincts, so that je puisse décider des équivalences ambiguës avec le contexte culinaire.
33. As an utilisateur, I want voir le détail des quantités par recette et leur total, so that je puisse comprendre l’origine des besoins calculés.
34. As an agent de courses, I want utiliser la liste calculée avec les outils Leclerc déjà disponibles, so that je puisse chercher les produits et composer le panier dans le flux habituel.
35. As an utilisateur, I want que l’agent choisisse le nombre minimal de conditionnements couvrant le besoin lorsque leur contenu est clair, so that les courses correspondent aux quantités nécessaires.
36. As an utilisateur, I want que l’agent demande une précision lorsqu’un conditionnement ou une équivalence est ambigu, so that il évite de prendre une décision injustifiée.
37. As an utilisateur, I want vérifier les courses directement sur le site Leclerc Drive, so that cette validation reste dans mon processus habituel.
38. As an utilisateur d’un client MCP, I want comprendre et utiliser les outils grâce à leurs descriptions et schémas, so that je n’aie aucun skill ni document obligatoire à installer sur mon poste.
39. As an utilisateur, I want retrouver la source originale d’une recette, so that je puisse consulter son contexte et son attribution.
40. As an personne maintenant le projet, I want conserver les notices de provenance et de licence du catalogue intégré, so that le contenu puisse être distribué selon ses conditions propres.

## Implementation Decisions

- Respecter le vocabulaire du glossaire et les décisions d’architecture sur la bibliothèque de recettes et la licence du catalogue. La fonctionnalité vise l’extension Chrome et ses outils MCP.
- Créer une capacité cohérente de gestion des recettes couvrant le catalogue intégré, les captures en attente, la bibliothèque personnelle, le digest et le calcul des ingrédients. Les adaptations de stockage, de capture Chrome et de transport servent cette capacité sans exposer leurs détails aux clients MCP.
- Définir un contrat JSON commun et versionné. Une recette comporte un identifiant stable, un titre, des portions de référence positives, une liste non vide d’ingrédients quantifiés avec nom normalisé et unité explicite, des étapes non vides et sa provenance. Une recette personnelle conserve l’URL source et sa date de sauvegarde. Catégorie, temps de préparation et temps de cuisson sont facultatifs. Les valeurs numériques doivent être finies et valides pour leur usage.
- Une recette structurée n’est admise que si ses informations obligatoires sont fiables. Le client ne doit pas inventer des portions ou quantités absentes. Les captures et les recettes structurées ont des états distincts ; aucune fiche partielle n’est retournée comme une recette valide.
- Livrer un catalogue initial visant environ 500 recettes françaises de Wikilivres, préparées dans le contrat commun avant distribution. Utiliser la même validation que pour les recettes personnelles. Conserver attribution, URL source, notices de licence et indication des adaptations. La cible de volume ne justifie pas de compléter artificiellement une recette incomplète.
- Conserver les données personnelles dans le profil local de l’extension, hors du dépôt et du catalogue livré. Les captures, les recettes et l’état du digest doivent survivre à une relance de l’extension ou du navigateur. Le choix du mécanisme local doit prendre en compte les quotas et la taille bornée des captures.
- Déclencher la capture sur une action explicite dans l’extension avec l’accès temporaire à la page choisie. Exploiter, lorsqu’elles existent, les données structurées de recette de la page et le contenu visible pour constituer un extrait utile. La structuration finale appartient au modèle du client MCP. Ne pas demander un accès permanent à toute la navigation pour cette fonctionnalité.
- Conserver une URL et un extrait borné ; ne pas stocker ou transmettre la page HTML entière. Ne pas inclure scripts, champs de formulaire ou autres contenus privés sans rapport avec la recette. Traiter le contenu du site comme des données non fiables, jamais comme des instructions à suivre ou du HTML à exécuter.
- Dédupliquer une sauvegarde répétée de la même source et rendre les opérations d’enregistrement idempotentes. Une nouvelle tentative sur la même capture ne doit pas créer plusieurs recettes ni plusieurs notifications. La déduplication ne cherche pas à fusionner automatiquement des recettes similaires provenant de sites différents.
- Prévoir une communication validée entre le stockage de l’extension et les outils MCP exécutés dans la page Leclerc. L’accès aux données doit rester borné aux opérations de recettes autorisées et les réponses doivent être corrélées aux demandes. Préserver la restriction actuelle du relais aux pages Leclerc.
- Fournir des capacités MCP pour signaler et consulter les captures en attente, enregistrer une recette complète à partir d’une capture, abandonner une capture inexploitable, rechercher les recettes, consulter une recette complète et calculer une liste d’ingrédients. Les noms précis des outils sont un choix d’implémentation ; leurs schémas et descriptions constituent l’interface portable.
- Lors d’un appel MCP ordinaire, joindre un signalement borné des captures en attente et permettre de récupérer leur contenu par identifiant. Cela doit permettre au modèle de les structurer par un appel d’enregistrement ultérieur. Aucun appel MCP ne lance implicitement un modèle de langage dans le relais ou dans l’extension.
- L’enregistrement réussi valide le contrat, conserve la recette complète et termine la capture correspondante. Le digest de cette nouvelle recette est fourni une seule fois après sa structuration, avec un état de diffusion local persistant. L’enregistrement et son changement d’état doivent éviter les doublons lors d’appels répétés ou concurrents. Un échec technique de stockage ne doit pas être confondu avec l’abandon volontaire d’une capture inexploitable.
- Le digest indique au minimum le nombre de nouvelles recettes, leur identifiant, leur titre et leurs portions. Le catalogue intégré en est exclu. La taille des notifications et des résultats doit être bornée ou paginée pour respecter la limite de transport existante de 1 Mio, enveloppe MCP comprise.
- La recherche couvre catalogue intégré et bibliothèque personnelle avec un résultat compact incluant identifiant, titre, portions et origine. La consultation par identifiant renvoie la recette complète et sa provenance. Les identifiants des deux collections doivent être non ambigus. Les données personnelles ne sont pas copiées dans le catalogue distribué.
- Les descriptions des outils expliquent que les recettes sont une aide facultative pour l’agent de courses. L’agent choisit les recettes, portions, équivalences d’ingrédients, produits et conditionnements selon la demande de l’utilisateur.
- Les adaptations légères sont temporaires pour la commande. Elles peuvent ajuster les portions et remplacer un ingrédient par un équivalent proche qui préserve l’identité du plat. Elles n’altèrent pas la recette enregistrée et ne créent pas automatiquement une variante persistante. Les transformations plus importantes demandent une instruction de l’utilisateur.
- L’outil de calcul reçoit en un appel les recettes retenues, leurs portions cibles et les éventuelles adaptations temporaires. Les quantités d’une adaptation doivent être exprimées explicitement pour les portions de référence avant application du facteur de portions ; leur interprétation ne doit pas dépendre d’une déduction du calculateur.
- Le calcul multiplie les quantités par le rapport entre portions cibles et portions de référence, puis additionne uniquement les lignes ayant le même nom normalisé et la même unité. La normalisation superficielle doit être déterministe et ne pas assimiler des synonymes ou des mots culinaires différents. Les unités différentes restent séparées, même lorsqu’une conversion serait possible. Aucune conversion masse-volume ni équivalence sémantique n’est déduite par l’outil.
- Le résultat du calcul contient, pour chaque ligne regroupée, son ingrédient, son unité, la quantité totale et les contributions identifiées de chaque recette. Les décimales sont traitées de manière stable, sans arrondi prématuré des quantités culinaires ni confusion avec un nombre entier de produits vendus.
- La correspondance aux produits et le nombre de conditionnements restent des décisions de l’agent avec les informations issues des outils Leclerc. Si le conditionnement est explicite, l’agent couvre le besoin avec le nombre minimal de paquets entiers ; s’il est ambigu, il demande une précision. Le calculateur ne devient pas un moteur de correspondance commerciale.
- La validation humaine de la liste et du panier se déroule sur le site Leclerc Drive. Cette fonctionnalité n’ajoute pas de nouvelle étape obligatoire de confirmation aux outils MCP.

## Testing Decisions

- **Point principal :** tester la capacité recettes à travers les contrats publics des outils MCP et l’entrée publique de capture, avec les adaptateurs Chrome, stockage et transport remplacés par des doubles. Observer les réponses, les données consultables et les transitions visibles depuis ces entrées. Conserver un seul harnais d’intégration principal pour le workflow, sans tests liés aux fonctions privées ou à l’organisation interne.
- Réutiliser le lanceur Node existant et son approche de fixtures JSON et de sorties de modèle simulées. Les tests du workflow d’orchestration sont le précédent pour enchaîner plusieurs opérations publiques avec des données de modèle contrôlées ; les tests actuels de recherche et de panier montrent comment vérifier les résultats métier sur des fixtures réalistes.
- Le parcours de référence couvre capture explicite, découverte de la capture par MCP, structuration simulée par le client, enregistrement valide, digest unique, recherche, consultation, calcul de portions pour plusieurs recettes puis nouvelle instance sur les mêmes données locales. Vérifier que les recettes et l’état de diffusion persistent après cette relance.
- Couvrir les captures sans données structurées, les extraits contenant des instructions malveillantes, les limites de taille et l’absence d’exécution du contenu capturé. Utiliser des fixtures locales de pages aux structures différentes ; aucun test automatisé ne dépend de la disponibilité de Jow, Marmiton ou d’un autre site réel.
- Vérifier les refus de recettes sans portions, sans quantités fiables, sans ingrédients ou sans étapes ; vérifier l’abandon explicite et l’absence de recette partielle dans les résultats. Une erreur technique de persistance doit rester visible et ne doit pas annoncer une sauvegarde réussie.
- Vérifier la déduplication, les répétitions d’appels et les opérations concurrentes pertinentes : une capture finalisée produit une seule recette et un seul événement de nouveauté dans le fonctionnement normal. Les recettes du catalogue ne sont jamais des nouveautés personnelles.
- Vérifier la recherche et la consultation sur les deux collections, les identifiants inconnus, les résultats vides, la provenance et les réponses bornées ou paginées. Valider tout le catalogue livré avec le même contrat public que les recettes personnelles et contrôler la présence des notices de provenance et de licence.
- Vérifier les calculs avec portions réduites ou augmentées, plusieurs recettes partageant un ingrédient, décimales, unités différentes et ingrédients aux noms voisins. Vérifier les totaux et leur détail par recette. Les équivalences non explicites doivent rester distinctes.
- Vérifier qu’une adaptation temporaire influence uniquement le calcul demandé et laisse la recette consultable intacte. Tester la validation des entrées d’adaptation et de calcul ; ne pas tenter de tester le jugement culinaire d’un modèle par une comparaison textuelle figée.
- Conserver les tests existants des outils Leclerc comme couverture de leur contrat. La nouvelle capacité ne doit pas requérir une modification de leur comportement pour gérer les recettes.
- Compléter par une vérification ciblée dans Chrome pour les éléments que les doubles ne démontrent pas : action sur une page non Leclerc, accès temporaire, capture, persistance réelle et accès via le pont depuis une page Leclerc. Cette vérification observe le même parcours utilisateur ; elle ne nécessite pas de créer une collection de tests de composants internes.
- Les tests déterministes utilisent une sortie de modèle simulée ; ils ne prétendent pas garantir la qualité culinaire de toutes les sorties d’un modèle réel. La validation sur le site Drive reste extérieure aux critères automatisés de cette fonctionnalité.

## Out of Scope

- Service de recettes externe, clé d’API culinaire, synchronisation distante et compte supplémentaire.
- Surveillance de la navigation, collecte massive automatique et accès permanent à tous les sites.
- Archive de la page HTML entière, sauvegarde de recette partielle et sélection manuelle de texte comme solution de secours.
- Modèle local ou service de langage dédié à la structuration des recettes dans le plugin.
- Skill à installer ou document obligatoire à lire sur le poste du client MCP.
- Planificateur de menus imposé, obligation de suivre une recette et moteur culinaire de substitutions ou de transformations automatiques.
- Sauvegarde automatique des variantes faites pour une commande.
- Conversion d’unités dans le calculateur, rapprochement automatique de synonymes, déduction de densités et moteur de correspondance automatique aux conditionnements commerciaux.
- Nouvelle interface de validation humaine, nouveau verrou de confirmation du panier, paiement et passage de commande.
- Modification du modèle local existant de normalisation des listes explicites ou extension de la fonctionnalité à l’application mobile.
- Export/import JSON, partage de bibliothèque et interface complète de gestion éditoriale : ces compléments ne font pas partie des critères de livraison définis dans cette conversation.

## Further Notes

- Cette spécification synthétise les décisions de l’entretien et les ADR sur la bibliothèque de recettes et la licence du catalogue. Les modules, formats de transport internes et choix d’interface qui ne changent pas les comportements décrits restent des choix d’implémentation.
- MCP ne peut pas provoquer une lecture spontanée dans le client. La découverte des captures et le digest sont transportés par les réponses d’outils effectivement appelés. Une notification émise ne garantit pas que le client ou l’utilisateur l’a lue ; la recette reste consultable dans la bibliothèque.
- La compatibilité avec un site dépend du contenu accessible lors de la capture. Un site fermé, une page tronquée ou une recette dépourvue d’informations obligatoires peut conduire à l’abandon de la capture. Le support universel décrit une méthode indépendante du site, sans garantir l’extraction de toutes les pages.
- Le suivi GitHub, le vocabulaire des labels, le point de test principal et le découpage en 33 tickets ont été validés pour publication.
