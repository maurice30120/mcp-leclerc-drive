# 0012 — Seam `ModelProvider` unique, orchestration déterministe en premier parcours

Date : 2026-10-18
Statut : accepté
Tickets : #40 (spécification), #44 (agent), #47 (POC tool calling), #48 (Mistral BYOK),
#49 (WebGPU exclusif).

## Contexte

Le cahier des charges exige un agent commun Chrome/Node derrière une interface
`ModelProvider` unique, avec quatre configurations comparables : Mistral BYOK, petit
modèle de base, le même après fine-tuning LoRA, et un modèle simulé pour les tests.
Le cahier prévoit le moteur Vercel AI SDK ; le ticket #47 impose un **POC borné** avant
tout travail lourd (tool calling réel `@browser-ai/transformers-js` ↔ AI SDK,
sélection du modèle de base sur preuve ONNX/WebGPU).

## Décision

1. **L'orchestrateur ne connaît que l'interface `ModelProvider`** (identité, capacités,
   `generate(messages, tools?, params, signal)`). Les détails Mistral/ONNX/WebGPU
   restent dans les providers ; l'orchestrateur ignore s'il parle à un script simulé
   ou à un modèle réel.
2. **Premier parcours = orchestration déterministe des recherches** après génération de
   la recette : le modèle produit la recette JSON (avec au plus une réparation guidée),
   puis le code détermine les demandes de produits, les recherches, la règle de
   correspondance et les quantités d'achat à partir des conditionnements des outils.
   Les traces distinguent `source: "model" | "deterministic"` pour chaque décision ;
   ce parcours n'est jamais qualifié de « tool calling réussi ».
3. **Le branchement du moteur Vercel AI SDK est différé au POC #47** : le seam est
   conçu pour qu'un adaptateur `LanguageModel` puisse envelopper n'importe quel
   provider sans toucher à l'orchestrateur. Aucun travail de fine-tuning ne démarre
   avant la conclusion du POC (gates bloquantes de la spécification).
4. **Aucun repli CPU/WASM et aucune bascule cloud implicite** : un provider local
   WebGPU indisponible lève `ProviderUnavailableError` avec un diagnostic et, au
   maximum, une **proposition** consentie de Mistral — jamais un appel automatique
   (scénario A10).

## Conséquences

- Les scénarios du harnais tournent hors ligne en CI avec le provider simulé, sans
  GPU ni clé ; les providers réels sont opt-in (`test:harness:local`, campagne
  Mistral avec clé explicite).
- La sélection explicite du fournisseur est une propriété structurelle : aucune
  configuration n'est construite implicitement par une autre.
