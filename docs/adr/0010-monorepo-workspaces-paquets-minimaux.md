# 0010 — Refactoriser progressivement en monorepo npm workspaces, avec un minimum de packages

Date : 2026-10-18
Statut : accepté
Tickets : #40 (spécification), #41 (préfactorisation)
Contexte : cahier des charges « Assistant de recettes et courses » (GrillMe Q1–Q36), amendement §9.

## Contexte

Le dépôt était un package unique : application d'extension Chrome (`src/`, `extension/`),
application mobile séparée (`drive-assistant-mobile/`), tests `node --test`. Le nouveau
travail de l'agent de courses exige des frontières partagées entre Chrome et un harnais
Node : un registre de contrats d'outils unique, un schéma de recette validé identiquement
partout, et un moteur d'agent indépendant du fournisseur de modèle. Ces frontières n'ont
pas d'intérêt à vivre dans le package de l'extension, dont le paquet publié doit rester
léger.

## Décision

Le dépôt devient un monorepo npm workspaces (`packages/*`), refactorisé par lots
« expand » : le code existant garde son comportement et ses tests verts à chaque lot, et
le nouveau code atterrit directement dans ses packages définitifs. Nous créons le plus
petit nombre raisonnable de packages, chacun justifié par une frontière de dépendances
réelle :

- `@leclerc/contracts` — domaine pur, registre des neuf capacités Leclerc (schémas,
  métadonnées lecture/session/mutation, validation d'entrée typée, erreurs normalisées)
  et schéma versionné de la recette générée. **Aucune** dépendance à `chrome.*`,
  `window`, `document`, `node:*`, aux SDK MCP ou aux bibliothèques de modèles.
- `@leclerc/agent` — seam `ModelProvider`, moteur d'agent, garde-fou d'approbation,
  orchestration déterministe de la tranche « recette → panier ». Pur également :
  utilisable tel quel dans Chrome et dans Node.
- `@leclerc/harness` — harnais Node : mocks déterministes des neuf capacités,
  injection de fautes, scénarios versionnés, campagne et rapports sanitisés.

L'application d'extension reste à la racine (src/, extension/, scripts/, tests/ legacy)
et migre vers les packages au fil des tickets ; `drive-assistant-mobile/` reste hors
workspaces (contraintes React Native d'hoisting). Les versions de dépendances restent
épinglées par le lockfile racine.

## Conséquences

- Les scripts racine parcourent les workspaces (`npm run build/test/typecheck -ws`) ;
  les tests legacy `node --test` restent la référence de non-régression de l'app.
- Le paquet de l'extension n'embarque aucun nouveau poids : les packages sont du code
  TypeScript compilé, bundlé par esbuild comme avant.
- Toute future capacité est définie une seule fois dans `@leclerc/contracts` et
  projetée vers WebMCP (ADR-0011) et le harnais.
