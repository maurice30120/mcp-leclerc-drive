# Un registre unique des capacités Leclerc, exécuté contre des mocks déterministes

**Statut :** accepté (ticket #42, spec #40).

Les neuf capacités historiques (trouver/sélectionner/consulter un drive,
rechercher un article, consulter les habituels, lire/ajouter/modifier/retirer
du panier) sont définies **une seule fois** dans `@leclerc/contracts`
(`src/capabilities.ts`) : nom, description, schémas d'entrée/sortie, métadonnée
lecture/session/mutation, `validateInput` et codes d'erreur. L'extension
WebMCP (projection, #50) et le harnais Node projettent ce registre au lieu de
redéclarer leurs outils ; aucun champ inventé en dehors des contrats ne peut
franchir la frontière capacité.

L'exécution hors navigateur passe par un environnement mock en mémoire
(`@leclerc/harness`, #42) : catalogue et drives versionnés
(`CATALOGUE_VERSION`), état frais par `createMockLeclerc()`, recherches
déterministes insensibles aux accents, mutations qui mettent à jour quantités
et totaux relisibles par `get_cart`. Chaque appel passe par le registre —
`validateInput` d'abord, puis exécution — et produit soit une sortie structurée
soit une `ToolError` normalisée ; les exceptions brutes ne traversent jamais la
frontière. Les sept familles de fautes s'injectent au niveau outil
(`faults.ts`) avec des prédicats par capacité, par identifiant produit et par
nième appel.

**Options envisagées.** Redéclarer les neuf outils dans chaque surface
(extension + harnas), ou un registre de contrats partagé. La duplication
diverge silencieusement (un outil ajouté côté extension mais pas côté harnas,
des erreurs non normalisées côté Node) ; le registre unique impose le
contraire : une seule définition, deux projections.

**Conséquences.** `@leclerc/contracts` reste pur (aucune dépendance Chrome,
Node, MCP ou modèle) et devient la source de vérité des deux surfaces. Toute
évolution d'une capacité (schéma, erreur, sémantique) se fait dans le registre
et se propage. Les attentes de scénarios (#44/#45) sont épinglées à la version
du catalogue : changer une donnée de fixture bump `CATALOGUE_VERSION` et casse
explicitement les tests concernés, jamais silencieusement. Le harnas est
Node-only ; il ne remplace jamais l'adaptateur Chrome réel, il le simule au
niveau contrat.
