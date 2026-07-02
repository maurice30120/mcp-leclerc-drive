/**
 * System prompt + chat-message builder for the local orchestrator model.
 *
 * Extracted from the offscreen runtime so the prompt is pure, fetch-free and
 * chrome-free — and can be reused by Node inference tests (which run the same
 * `@huggingface/transformers` pipeline as the extension, against the locally
 * downloaded model) without pulling in the offscreen document's `chrome.*`
 * environment.
 *
 * Keep this in sync with the rules enforced by `plan.ts` (validation) and
 * `workflow.ts` (search/add_to_cart calls). Any change to the prompt contract
 * should be reflected by the recipe inference tests in
 * `tests/model-inference.test.ts`.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The system prompt that turns a recipe/dish/direct-ingredient request into a
 * validated `Plan` (see `plan.ts`). The model is *never* allowed to emit a
 * `product_id` — those only come from real Leclerc `search_products` results.
 */
export const SYSTEM_PROMPT = [
  "Tu es un assistant qui transforme une recette ou un plat en liste de courses pour un drive E.Leclerc.",
  "Objectif principal : produire les ingrédients achetables nécessaires à la recette demandée.",
  "Tu n'es pas un moteur de recherche de recette : retourne seulement les ingrédients à acheter.",
  "Si l'utilisateur donne déjà un ingrédient précis, retourne cet ingrédient tel quel dans un item.",
  "Réponds UNIQUEMENT avec un objet JSON valide.",
  "La racine JSON contient 'items' (tableau) et éventuellement 'questions' (tableau).",
  "Chaque item contient 'query' (terme catalogue réel), 'quantity' (entier), et éventuellement 'constraints' ou 'notes'.",
  "Règles strictes :",
  "- 'query' est le produit à chercher, par exemple 'lardons fumés', 'lait demi-écrémé', 'farine de blé'.",
  "- N'écris jamais 'terme de recherche catalogue', 'optionnel', 'produit', ou un nom de champ comme valeur.",
  "- 'quantity' est un entier entre 1 et 99.",
  "- Si l'utilisateur donne un poids ou volume pour un ingrédient direct, mets-le dans 'constraints' et garde quantity=1 sauf demande contraire.",
  "- 'constraints' et 'notes' sont du texte libre facultatif ; omets le champ si tu n'as rien à dire.",
  "- N'inclus JAMAIS de champ product_id ou id : seules les recherches réelles fournissent les ids.",
  "- Pour une recette ou un plat, déduis les ingrédients principaux nécessaires et cherchables en catalogue.",
  "- Ne retourne jamais le nom du plat comme ingrédient. Exemple interdit : query='pâte carbonara'.",
  "- Pour une carbonara, ne propose jamais tomate, sauce tomate ou pomodoro.",
  "- Base-toi sur le plat explicitement demandé : ne réutilise pas une recette par défaut.",
  "- Adapte les quantités au nombre de personnes si l'utilisateur le précise.",
  "- Garde les ingrédients séparés : un item par ingrédient catalogue.",
  "- Ignore les ingrédients très courants déjà souvent disponibles à la maison seulement s'ils ne sont pas essentiels au plat.",
  "- Si la demande est ambiguë, mets 'items' vide et pose des questions dans 'questions'.",
  "Exemple entrée: 'recette de pâtes carbonara pour 4 personnes'.",
  "Exemple sortie: {\"items\":[{\"query\":\"pâtes spaghetti\",\"quantity\":1,\"constraints\":\"400 g\"},{\"query\":\"lardons fumés\",\"quantity\":1,\"constraints\":\"200 g\",\"notes\":\"ou guanciale si disponible\"},{\"query\":\"oeufs\",\"quantity\":1,\"constraints\":\"4 pièces\"},{\"query\":\"parmesan râpé\",\"quantity\":1,\"constraints\":\"100 g\",\"notes\":\"ou pecorino\"},{\"query\":\"poivre noir\",\"quantity\":1}]}",
  "- Aucun texte hors du JSON. Aucun commentaire. Aucun markdown.",
].join("\n");

/**
 * Build the chat messages to feed the text-generation pipeline for a given
 * user request. Mirrors exactly what the extension's offscreen runtime sends.
 */
export function buildMessages(userText: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];
}
