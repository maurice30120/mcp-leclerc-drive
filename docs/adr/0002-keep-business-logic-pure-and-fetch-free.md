# Garder la logique métier Leclerc pure et sans fetch dans `src/leclerc/api.ts`

Toute la construction d'URLs, le parsing HTML/JSON, l'assemblage du panier, les
helpers du store-finder et le formatage vivent dans `src/leclerc/api.ts` comme
des **fonctions pures** — pas de `fetch`, pas d'API Node, pas de `localStorage`.
Le seul endroit où `fetch` est appelé est `extension/inject.ts`, en utilisant
le fetch de la page.

Pourquoi : la même logique doit se bundler dans un content script MV3 *et*
rester unit-testable en isolation. Mélanger le fetch dans la logique force
soit un test navigateur-only, soit un harnais de fetch mocké ; la garder pure
signifie que le parsing et l'assemblage peuvent être testés avec de simples
fixtures de chaînes, et le chemin fetch est une seule couture. C'est la règle
que CONTRIBUTING.md impose à tout nouvel outil.

```mermaid
flowchart LR
    subgraph Test["Unit tests (Node pur)"]
        Fix["string fixtures"]
        A2["api.ts (pure)"]
        Fix --> A2
    end
    subgraph Runtime["Runtime (onglet Chrome)"]
        I["inject.ts (MAIN world)"]
        A1["api.ts (pure)"]
        F["fetch de la page"]
        I -->|construit URLs / parse| A1
        I -->|appelle| F
    end
    A1 --- A2
    note la même api.ts sert les deux contextes :<br/>testée en isolation, bundlée dans le content script
```