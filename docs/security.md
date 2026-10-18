# Modèle de sécurité

> Modèle de menaces pour l'architecture WebMCP (MCP-B), où les outils Leclerc
> Drive tournent dans un véritable onglet Chrome et sont pontés vers un client
> MCP stdio par `@mcp-b/webmcp-local-relay`.

## Frontières de confiance

```mermaid
flowchart TD
    Client["opencode (ou tout client MCP stdio)"]
    Relay["@mcp-b/webmcp-local-relay<br/>process Node local, 127.0.0.1:9333"]
    Ext["Extension Chrome MV3<br/>(background worker)"]
    Tab["Onglet Leclerc Drive (connecté)<br/>← SEULE surface d'identifiants"]

    Client -->|JSON-RPC sur stdio| Relay
    Relay -->|WebSocket, loopback uniquement<br/>--widget-origin bloqué sur Leclerc| Ext
    Ext -->|chrome.scripting.executeScript<br/>MAIN world| Tab
    Tab -.->|identifiants (cookies, datadome)<br/>jamais exfiltrés| Tab
```

Le **seul** endroit où vivent les identifiants est l'onglet Leclerc Drive sur
lequel l'utilisateur est connecté. L'extension, le relay et opencode ne voient
jamais de cookie, de token ou de valeur DataDome. Il n'y a rien à exfiltrer
depuis un fichier de config, un environnement de process ou le disque.

## Ce qu'on a retiré (et pourquoi)

L'ancienne architecture lisait les cookies de session Chrome de l'utilisateur
(y compris le cookie DataDome) depuis le profil Chrome local via
`chrome-cookies-secure`, ce qui tirait transitivement `sqlite3`/`better-sqlite3`
et plusieurs CVE transitives. Ce chemin est entièrement supprimé :

- Plus de permission Chrome `cookies`.
- Plus de `chrome-cookies-secure`, plus de `LECLERC_COOKIE`, plus de secret de
  config sur disque.
- Plus de `fetch` côté Node porteur d'un cookie volé.

Chaque `fetch` d'outil est désormais le **propre fetch de la page** dans l'onglet
connecté — cookies, fingerprint DataDome, et le rafraîchissement automatique du
DataDome par le navigateur sont tous gérés par le navigateur lui-même.

## Fermeture SSRF

`set_store` accepte un paramètre `host` pour que les utilisateurs visent leur
propre drive, mais chaque hôte est validé avec `isLeclercHost` :

```ts
export function isLeclercHost(host: string): boolean {
  return /^fd\d+-courses\.leclercdrive\.fr$/i.test(host);
}
```

Aucun outil n'émettra de requête vers un hôte qui n'est pas un backend Leclerc
Drive, donc la surface catalogue/panier ne peut pas être détournée comme
transitaire de requêtes côté serveur vers une origine arbitraire. Par défaut
l'hôte est dérivé du propre `window.location.hostname` de l'onglet, qui est
déjà une origine Leclerc par construction.

## Verrouillage du relay (`--widget-origin`)

Le flag `--widget-origin` du relay restreint quelles origines de page peuvent
enregistrer des outils sur le relay. La config d'exemple le cale sur une origine
Leclerc :

```jsonc
"command": ["npx","-y","@mcp-b/webmcp-local-relay@latest",
            "--widget-origin","https://fd9-courses.leclercdrive.fr"]
```

Une page non-Leclerc ouverte dans le navigateur ne peut donc **pas** pousser
d'outils vers le relay. Le relay est aussi bindé sur `127.0.0.1` par défaut, donc
seuls les process locaux peuvent se connecter indépendamment des vérifications
d'origine.

> Le préfixe `fdN` varie réellement par magasin (`fd8`, `fd9`, `fd14`…). Le
> relay ne supporte pas les wildcards DNS, donc les utilisateurs surchargent
> l'origine avec l'URL de leur propre drive. Lister plusieurs origines
> (séparées par virgule) fonctionne aussi. Laisser `--widget-origin` non défini
> (`*`) n'est **pas** recommandé : toute page ouverte pourrait alors enregistrer
> des outils.

## Durcissement contre l'injection de prompt

La sortie d'outils provenant de Leclerc (libellés produits, noms de magasins)
est traitée comme non fiable :

- Les descriptions de `search_product` et `find_stores` avertissent le modèle
  que les libellés côté Leclerc ne sont pas des instructions.
- Le texte retourné au LLM est épuré des séquences qui pourraient s'échapper
  d'un system prompt LLM ou mimer des frontières de résultat d'outil / de chat
  (`</system>`, `<|im_start|>`, `[system]`, etc.) avant envoi — voir
  `scrubUntrusted` dans `extension/inject.ts`.

## Permissions minimales (MV3)

L'extension ne demande que :

| Permission | Pourquoi |
| --- | --- |
| `scripting` | Injecter le pont dans l'onglet Leclerc (`MAIN` world). |
| `activeTab` | Cibler l'onglet où se trouve l'utilisateur. |
| `storage` | (Réservé pour de futures préférences par magasin.) |
| host `*://*.leclercdrive.fr/*` | Uniquement les pages Leclerc Drive — pas de `<all_urls>`. |

Pas de `cookies`, pas de `tabs`, pas de `webRequest`, pas de `<all_urls>`, pas
de `history`.

## Risques résiduels

- **DataDome 403** : toujours possible sur des rafales agressives. Le throttle
  in-page sérialise et espace les appels ; sur un 403 persistant l'outil
  retourne un message actionnable « recharge l'onglet Leclerc » et le
  navigateur ré-obtient son propre cookie DataDome à la prochaine navigation.
- **Éviction du service worker MV3** : le background worker peut être stoppé par
  Chrome. Il ne ré-injecte qu'à la navigation ; une fois injecté, le code outil
  tourne dans l'onglet, qui persiste.
- **CSP de page future** : Leclerc ne fournit actuellement aucun
  Content-Security-Policy. S'ils en ajoutent un bloquant les scripts injectés
  en `MAIN`-world, le repli est un user-script runner (exempt de CSP via
  `chrome.scripting`). Comme la logique métier est isolée dans
  `src/leclerc/api.ts`, ce swap représente ~1 fichier.
- **Maturité MCP-B** : `@mcp-b/global` et `@mcp-b/webmcp-local-relay` sont
  alignés sur `^6.0.3`. L'enregistrement WebMCP étant asynchrone, le service
  worker attend la promesse de démarrage avant d'injecter l'embed vendored de
  la même version majeure. Les adaptations restent dans `extension/inject.ts`,
  `extension/background.ts` et le script de build.
