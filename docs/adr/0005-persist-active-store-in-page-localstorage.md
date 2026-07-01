# Persister le magasin actif dans le `localStorage` de la page, pas dans un fichier de config Node

v0.x écrivait le magasin sélectionné dans `~/.mcp-leclerc-drive/config.json` sur
disque. v1.0 le stocke dans
`localStorage["mcp-leclerc-drive:active-store"]`, scopé à l'hôte Leclerc, et
préfère le segment `magasin-{id}-{id}` de l'URL courante de l'onglet quand
présent.

Pourquoi : il n'y a plus de process Node pour posséder la config — les outils
vivent dans l'onglet — donc la sélection de magasin appartient à l'onglet. La
garder dans `localStorage` la fait survivre aux reloads du même onglet drive ;
préférer l'URL garde les outils honnêtes sur le drive où la session est
réellement (Leclerc lie une session à un seul drive).

```mermaid
flowchart TD
    URL["URL de l'onglet<br/>(préféré)"]
    LS["localStorage<br/>mcp-leclerc-drive:active-store"]
    Err["erreur: aucun drive"]

    loadStore -->|présent magasin-X-Y| URL
    loadStore -->|"sinon"| LS
    loadStore -->|"sinon"| Err
    setStore -->|"persiste"| LS
    note URL = vérité courante ; localStorage = persistance inter-reloads
```

**Conséquence.** Le premier run exige que l'onglet soit ouvert sur une page
magasin ou qu'il y ait eu un `set_store` préalable ; il n'y a plus de défaut
par variable d'env.