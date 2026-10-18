# MCP Leclerc Drive

Vocabulaire du domaine des recettes et des courses préparées avec le plugin MCP Leclerc Drive.

## Recettes

**Recette** : Préparation culinaire complète, avec un nombre de portions, des ingrédients et leurs quantités, ainsi que des étapes de préparation.
_À éviter_ : Plat, idée de repas (quand il s’agit d’une recette détaillée)

**Adaptation légère** : Ajustement temporaire d’une recette pour les courses, comme changer le nombre de portions ou remplacer un ingrédient par un équivalent proche qui préserve l’identité du plat. La recette de référence reste inchangée ; toute transformation plus importante demande une instruction de l’utilisateur.
_À éviter_ : Nouvelle recette enregistrée (pour une adaptation faite uniquement pour une commande)

**Page de recette capturée** : URL et extrait local du contenu de la page sauvegardés par l’utilisateur, en attente de conversion par le modèle du client MCP en recette structurée. Elle ne fait pas encore partie de la bibliothèque personnelle.
_À éviter_ : Recette (avant validation de sa structure)

**Portions** : Nombre de personnes auquel correspondent les quantités d’ingrédients d’une recette.
_À éviter_ : Personnes (comme champ ambigu sans préciser qu’il s’agit de portions)

**Catalogue intégré** : Recettes livrées avec le plugin, déjà converties dans le format commun et disponibles dès son installation.
_À éviter_ : Base externe (pour désigner les recettes livrées avec le plugin)

**Bibliothèque personnelle** : Recettes structurées et validées, créées à partir des pages capturées par l’utilisateur et conservées localement pour ses recherches et ses commandes.
_À éviter_ : Catalogue intégré (les deux collections ont des origines différentes)

**Digest de nouveautés** : Notification à usage unique des nouvelles recettes personnelles après leur structuration, qui restent ensuite disponibles dans la bibliothèque. Les pages capturées ne sont pas encore des recettes, et les recettes du catalogue intégré ne sont pas des nouveautés.
_À éviter_ : Résumé de tout le catalogue

**Agent de courses** : Modèle du client MCP qui aide à composer les courses et peut s’appuyer sur les recettes lorsqu’elles sont pertinentes pour la demande.
_À éviter_ : Modèle local de l’extension (il normalise uniquement des listes de produits explicites)

**Regroupement des ingrédients** : Consolidation par un outil MCP des quantités calculées selon les portions retenues, uniquement lorsque le nom normalisé de l’ingrédient et son unité sont identiques. L’agent de courses choisit les recettes et tranche les équivalences ambiguës ; l’outil expose le détail par recette et le total regroupé.
_À éviter_ : Déduction automatique d’équivalences sémantiques ou conversion d’unités non prévues

**Validation de la liste de courses** : Vérification humaine effectuée sur le site Leclerc Drive, hors du périmètre de la bibliothèque de recettes MCP.
_À éviter_ : Étape de confirmation ajoutée aux outils MCP de recettes

## Choix des produits

**Sélection de produit** : Choix d'un produit du magasin pour satisfaire un ingrédient d'une recette, ses quantités et les contraintes exprimées par l'utilisateur.
_À éviter_ : Choix d'ingrédient (lorsqu'il s'agit de choisir le produit à acheter)

**Choix étayé** : Sélection appuyée par les données disponibles sur l'adéquation à la recette, le respect des contraintes et la quantité à acheter. Une information importante manquante constitue une incertitude à résoudre.
_À éviter_ : Choix certain, confiance déclarée par le modèle

**Produit favori** : Produit explicitement préféré par l'utilisateur, prioritaire entre produits d'adéquation comparable même s'il est un peu plus cher. Cette préférence ne suffit pas à rendre un produit adapté à la recette.
_À éviter_ : Produit automatiquement adapté, produit habituel (sans préférence explicitement établie)

**Produit habituel** : Produit signalé par le magasin comme faisant partie des habitudes d'achat de l'utilisateur. Il renseigne ses habitudes sans établir à lui seul une préférence explicite ou l'adéquation à une recette.
_À éviter_ : Produit favori (sans préférence explicitement établie)

**Clarification de produit** : Choix demandé à l'utilisateur lorsqu'une incertitude importante persiste sur le produit à acheter. Elle présente au maximum trois propositions, une recommandation lorsqu'elle est justifiable et la raison précise du doute.
_À éviter_ : Validation globale du panier

**Substitution compatible** : Changement de marque ou de conditionnement qui satisfait le même besoin sans modifier la préparation ni les contraintes exprimées. Un remplacement qui modifie la préparation nécessite l'accord de l'utilisateur.
_À éviter_ : Équivalence automatique (pour un remplacement qui modifie la préparation)

**Révision des choix** : Étape regroupant les clarifications des ingrédients encore incertains pendant que les produits déjà vérifiés remplissent le panier. Chaque réponse de l'utilisateur permet d'ajouter le produit choisi.
_À éviter_ : Validation globale avant ajout

**Autorisation de préparation** : Autorisation donnée par la demande de préparation des courses pour ajouter progressivement les produits dont le choix et les quantités sont vérifiés. Les choix incertains nécessitent une réponse de l'utilisateur.
_À éviter_ : Approbation globale préalable du panier

**Contribution du parcours** : Quantité effectivement ajoutée par l'agent pour un besoin, confirmée dans le panier, diminuée des suppressions confirmées de ce même ajout. Elle exclut les quantités déjà présentes avant le parcours.
_À éviter_ : Quantité totale du produit dans le panier

**Révision finale du panier** : Vérification du panier déjà rempli et du bilan du parcours, avec possibilité de supprimer les contributions non désirées. « Terminer la vérification » clôt cette révision sans ajouter de produit.
_À éviter_ : Autorisation d'ajout, aperçu avant approbation
