# Intégrer une bibliothèque de recettes au flux MCP de courses

**Statut : accepté**

## Décision

- Le plugin fournit un catalogue intégré de recettes françaises déjà structurées et une bibliothèque personnelle conservée localement. Les deux utilisent le même format JSON ; le catalogue est disponible dès l’installation et ne produit pas de digest de nouveautés.
- L’utilisateur déclenche explicitement la capture d’une page de recette. La capture conserve l’URL et un extrait local borné. Au prochain échange MCP approprié, le modèle du client transforme cet extrait en recette JSON complète. Une recette doit avoir un nombre de portions, des ingrédients quantifiés et des étapes ; catégorie, temps de préparation et temps de cuisson sont facultatifs. Si le modèle ne peut pas produire une recette complète, la capture est supprimée.
- Le digest signale une seule fois chaque recette personnelle après sa structuration. Les recettes structurées restent ensuite consultables ; une capture en attente n’est pas encore une recette.
- Les capacités sont exposées par des outils MCP portables, avec leurs descriptions et schémas. Aucun skill ni document à installer sur le poste du client MCP n’est requis.
- L’agent de courses choisit s’il suit une recette, lesquelles et pour combien de portions. Il peut ajuster les portions ou faire des substitutions proches qui préservent l’identité du plat. La recette enregistrée reste inchangée et une variante n’est pas sauvegardée automatiquement ; une transformation plus importante demande une instruction de l’utilisateur.
- Un outil MCP calcule les quantités ajustées et regroupe uniquement les ingrédients ayant le même nom normalisé et la même unité. Il retourne les détails par recette et le total. L’agent décide des équivalences sémantiques et utilise ensuite les outils Leclerc existants pour composer les achats.
- La validation humaine de la liste se fait sur le site Leclerc Drive et reste hors du périmètre de cette fonctionnalité.
- Le catalogue initial vise environ 500 recettes françaises issues de Wikilivres. Les données conservent leur attribution, leur provenance et leurs notices de licence séparément de la licence du code, comme décrit dans l’[ADR 0007](0007-license-the-recipe-catalogue-separately.md).

## Conséquences

- L’extension doit permettre de capturer une page choisie, de transmettre les captures en attente au client MCP, puis de stocker et rechercher les recettes structurées localement.
- La création d’une recette personnelle dépend du modèle du client MCP ; elle ne dépend pas d’un service de recettes externe.
- Le calcul arithmétique et l’agrégation exacte sont déterministes. La sélection des recettes, les adaptations culinaires et les équivalences ambiguës restent à la charge de l’agent.
- Les pages capturées sont des données externes non fiables. Le flux MCP doit transmettre un extrait borné et les recettes structurées doivent être validées avant stockage.
