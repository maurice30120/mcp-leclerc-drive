# Ne publier aucun binaire npm — ponte vers les clients stdio via le relay local

v0.x publiait un serveur stdio `bin.mcp-leclerc-drive` (tu le `npx`ais). v1.0
ne publie rien d'exécutable : le package contient l'extension buildée + les
types ; le client MCP `npx`e `@mcp-b/webmcp-local-relay` (une dev dependency
ici), et l'utilisateur charge `dist/extension/` dans Chrome. `server.json`
garde `transport: stdio` mais porte un `transportHint` qui l'explique.

Pourquoi : les outils vivent dans l'onglet navigateur, donc il n'y a rien
qu'un binaire stdio aurait à *faire* sauf être le relay — et le relay est déjà
publié comme son propre package. Publier notre propre binaire no-op ne ferait
qu'induire en erreur les consommateurs du registry.

```mermaid
flowchart LR
    subgraph Registry["npm registry"]
        Pkg["mcp-leclerc-drive<br/>(extension buildée + types)"]
        Relay["@mcp-b/webmcp-local-relay<br/>(paquet séparé, devDep)"]
    end
    subgraph Client["Client MCP stdio"]
        CLI["opencode / Claude Code"]
    end
    subgraph Browser["Chrome utilisateur"]
        Ext["dist/extension/<br/>chargé manuellement"]
        Tab["onglet Leclerc (outils enregistrés)"]
    end

    CLI -->|npx| Relay
    CLI -->|config MCP| Pkg
    Pkg -->|install/livraison| Ext
    Ext -->|injecte MAIN world| Tab
    Relay <-->|WebSocket loopback| Tab
    note le package ne publie PAS de binaire : le client npx-e le relay connu
```

**Conséquence.** Les instructions d'install doivent couvrir deux artefacts
(extension + config client) au lieu d'une seule ligne `npx` ; le README et
`server.json` portent ce poids.