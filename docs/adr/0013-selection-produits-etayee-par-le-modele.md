# 0013 — Sélection des produits étayée par le modèle

Date : 2026-10-18
Statut : accepté — remplace la validation globale préalable pour le parcours recette

Le parcours actuel choisit les produits par correspondance de mots et sollicite
l'utilisateur en cas d'ex æquo. Un résultat unique peut pourtant être inadapté,
et de nombreux ex æquo imposent des choix inutiles à l'utilisateur.

La sélection des produits devient une boucle assistée par le modèle, commune au
parcours réel et aux évaluations du harnais. Elle sélectionne automatiquement un
produit lorsque les données disponibles étayent son adéquation à la recette,
le respect des contraintes exprimées et une quantité d'achat cohérente. Si une
information importante manque, elle peut reformuler la recherche avant de
demander une clarification de produit. Un score de confiance déclaré par le
modèle ne constitue pas à lui seul une justification du choix.

La boucle dispose de deux tours d'évaluation pour l'ensemble des ingrédients,
avec un troisième tour facultatif si une vérification utile reste possible.
Ce budget concerne la sélection après génération de la recette, et non trois
tours par ingrédient. Les produits habituels sont chargés une seule fois par
parcours ; chaque ingrédient dispose au maximum de trois recherches distinctes,
recherche initiale comprise.

Le premier tour évalue les résultats du catalogue et les produits habituels.
Les suivants réévaluent uniquement les ingrédients incertains après des
recherches ciblées. Les points à vérifier comprennent notamment la nature du
produit (par exemple haricots secs ou cuits), son conditionnement et sa présence
parmi les produits habituels de l'utilisateur. La boucle s'arrête dès que le
choix est étayé ou qu'aucune vérification utile ne reste ; les limites sont des
plafonds, pas des objectifs à atteindre.

Les outils actuels exposent une recherche catalogue et les produits habituels,
sans outil dédié à la fiche détaillée. Une information importante qui reste
absente des résultats est signalée comme incertaine. Le harnais mesure les
erreurs de sélection, les questions évitables, le nombre d'appels et la durée
afin d'ajuster ce budget sur des cas concrets.

Les favoris départagent les produits d'adéquation comparable, même s'ils sont
un peu plus chers ; ils ne justifient pas un produit inadapté. Une clarification
présente au maximum trois produits par ingrédient incertain, avec une
recommandation lorsqu'elle est justifiable et la raison précise du doute.
Tant qu'une réponse manque, la carte de choix reste amenée à l'écran : le
défilement ne peut pas la masquer derrière le journal de progression.

Les changements de marque et de conditionnement compatibles peuvent être
sélectionnés automatiquement : deux paquets de 500 g peuvent ainsi couvrir
un besoin de 1 kg. Les unités de cuisine de la recette (cuillère à soupe,
cuillère à café, pincée…) sont converties par des équivalences fixes vers la
famille du conditionnement concerné, et un besoin compté (pièces, gousses…)
accepte un conditionnement pesé ou mesuré plus grand comme un seul paquet :
deux cuillères d'huile achètent une seule bouteille de 1,5 l sans question.
Un remplacement qui modifie la préparation demande l'accord de
l'utilisateur, notamment des haricots cuits à la place de haricots secs.
Les contraintes exprimées restent prioritaires sur ces substitutions.

La demande de préparation autorise le remplissage progressif du panier. Dès
qu'un choix est étayé et ses vérifications terminées, sa quantité est ajoutée,
sans attendre la résolution des autres ingrédients et sans validation globale
préalable. L'interface expose recherche, vérification, ajouté, choix nécessaire
et échec. Les ingrédients incertains attendent une étape unique regroupant au
maximum trois propositions chacun, une recommandation justifiée lorsqu'elle
est possible et la possibilité de passer. Si trois choix restent plausibles,
l'humain tranche ; aucune sélection arbitraire n'est ajoutée. Le choix humain
déclenche ensuite l'ajout du produit concerné.

La révision finale présente le panier déjà rempli et les contributions du
parcours. Elle permet de supprimer uniquement les quantités effectivement
ajoutées par l'agent, en préservant les quantités présentes auparavant. Son
bouton final est « Terminer la vérification » ; il ne déclenche aucun ajout.

Chaque mutation utilise une quantité cible absolue, une intention enregistrée
avant l'appel et une relecture du panier après l'appel. Le journal distingue
quantités ajoutées confirmées, quantités supprimées, échecs, résultats restant
à vérifier et ingrédients restant à traiter. Une réponse HTTP positive ne
suffit pas à confirmer l'ajout. Une reprise réconcilie l'intention enregistrée
avec le panier réel avant toute écriture, puis réutilise la même cible si le
panier est resté inchangé. Un changement de magasin ou une modification externe
ambiguë bloque la mutation. Deux besoins utilisant le même produit gardent des
contributions distinctes.

Le journal et les recherches déjà consommées sont conservés localement dans
`chrome.storage.local`, séparément de la configuration Mistral. À la demande
explicite de l'utilisateur, la clé Mistral, le modèle et le fournisseur choisi
sont également conservés localement et restaurés à l'ouverture. La clé ne figure
jamais dans le journal des contributions, les états UI, les traces ou les
rapports. « Supprimer » efface la clé des stockages local et de session, ainsi
que l'ancienne copie du popup pour empêcher sa restauration par migration.
La conversation reste limitée à la session. L'intention doit être enregistrée avant chaque mutation ; si cette
écriture échoue, la mutation n'est pas émise. La suspension du service worker
ou la fermeture du navigateur conserve ainsi le bilan. La reprise recharge ce
journal sans régénérer la recette ni doubler un besoin. Un journal invalide est
signalé et bloque les mutations plutôt que d'être effacé silencieusement.

Cette décision remplace la sélection exclusivement déterministe du point 2 de
l'ADR-0012 et la décision précédente de validation globale avant ajout.
L'interface commune `ModelProvider` et la sélection explicite du fournisseur
restent applicables. La garde autorise uniquement la référence et la quantité
cible de l'intention vérifiée du parcours ; les contrôles de catalogue, de
quantité et de mutation restent en place. Les scénarios historiques A01–F01
conservent explicitement leur mode déterministe pour les comparaisons ; les
scénarios S et les tests progressifs évaluent le nouveau fonctionnement.
Le coût d'appels au modèle augmente en échange d'un
choix plus pertinent et de moins de sollicitations humaines ; le harnais
devra permettre d'évaluer ce compromis sur la même boucle que l'extension.

Une panne du fournisseur, une réponse tronquée ou un document JSON illisible
constitue un échec technique récupérable, pas une incertitude de produit à
transférer à l'utilisateur. Les ajouts confirmés restent journalisés et les
références ne sont jamais déduites d'un JSON partiel. Le parcours demande le
mode JSON natif aux fournisseurs compatibles ; une enveloppe Markdown complète
peut être retirée avant la validation stricte des décisions. Une reprise
conserve les recherches et le plafond de trois évaluations. Les anciens
journaux ayant transformé une évaluation entièrement invalide en choix humains
peuvent reprendre l'évaluation dans le budget restant.
