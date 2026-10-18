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
