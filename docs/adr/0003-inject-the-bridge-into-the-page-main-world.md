# Injecter le pont d'outils dans le MAIN world de la page, pas un monde isolé

`background.ts` utilise `chrome.scripting.executeScript({ world: "MAIN" })`
pour mettre `inject.js` (et le `embed.js` du relay) dans le **MAIN** world de
l'onglet Leclerc, pour que les outils enregistrés appellent le propre `fetch`
de la page avec ses cookies live et son empreinte DataDome. Une injection en
monde isolé ne partagerait pas le contexte fetch de la page et devrait forwarder
les fetchs à travers l'extension — réintroduisant un hop credentialé.

```mermaid
flowchart LR
    subgraph MAIN["MAIN world de la page (retenu ✅)"]
        I1["inject.ts"]
        F1["fetch de la page<br/>cookies + datadome live"]
        I1 -->|fetch direct| F1
    end
    subgraph ISO["Monde isolé (rejeté)"]
        I2["inject.ts"]
        Ext2["extension (background)"]
        F2["fetch côté ext<br/>(re-émet les credentials)"]
        I2 -->|forward| Ext2
        Ext2 -->|fetch| F2
    end
    note le MAIN world partage fetch/cookies de la page ;<br/>le monde isolé force un hop credentialé via l'extension
```

**Conséquences.** Les scripts MAIN world ne peuvent pas utiliser les API
`chrome.*`, donc le relay embed doit être piloté purement via l'ordre de la liste
d'injection (`["inject.js","embed.js"]`) plutôt que depuis `inject.ts` lui-même.
Leclerc ne sert actuellement aucun CSP page ; s'ils en ajoutent un qui bloque
les scripts MAIN world, le repli documenté (non implémenté) est un user-script
runner `chrome.scripting` exempt de CSP — l'isolation de `api.ts` rend ce swap
~1 fichier.