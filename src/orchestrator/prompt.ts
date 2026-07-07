/**
 * System prompt + chat-message builder for the local shopping-list normalizer.
 *
 * Extracted from the offscreen runtime so the prompt is pure, fetch-free and
 * chrome-free — and can be reused by Node inference tests (which run the same
 * `@huggingface/transformers` pipeline as the extension, against the locally
 * downloaded model) without pulling in the offscreen document's `chrome.*`
 * environment.
 *
 * Keep this in sync with the rules enforced by `plan.ts` (validation) and
 * `workflow.ts` (search/add_to_cart calls). Any change to the prompt contract
 * should be reflected by the shopping-list inference tests in
 * `tests/model-inference.test.ts`.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The system prompt that turns an explicit shopping list into a validated
 * `Plan` (see `plan.ts`). The model is *never* allowed to emit a `product_id`
 * — those only come from real Leclerc `search_products` results.
 */
export const SYSTEM_PROMPT = [
  "TACHE: convertir le texte USER en JSON de liste de courses.",
  "IMPORTANT: copie seulement les produits explicitement écrits par USER.",
  "INTERDIT: inventer des ingrédients, compléter une recette, proposer un produit absent de USER.",
  "SORTIE: uniquement JSON valide, sans markdown, sans explication.",
  "FORMAT: {\"items\":[{\"query\":\"nom du produit\",\"quantity\":1,\"constraints\":\"poids volume format si indiqué\"}],\"questions\":[]}",
  "REGLES:",
  "- Un produit écrit par USER devient un item.",
  "- query = mots du produit dans USER, sans poids, volume ni quantité.",
  "- quantity = nombre d'unités explicite: x6 => 6, 2 paquets => 2. Sinon 1.",
  "- constraints = poids, volume ou format explicite: 500 g, 1L, 1 kg, boite de 6.",
  "- Sépare les listes avec virgules, points-virgules, retours ligne, tirets ou puces.",
  "- Supprime les verbes comme achète, prends, ajoute.",
  "- Jamais product_id. Jamais id.",
  "- Si USER est seulement un plat ou une recette sans produits listés, retourne exactement {\"items\":[],\"questions\":[\"Donne-moi les ingrédients à acheter pour cette recette.\"]}.",
  "- Les mots carbonara, ratatouille, bolognaise, crêpes désignent des plats: ne les transforme pas en ingrédients.",
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

/**
 * Build a plain text prompt instead of relying on tokenizer.chat_template.
 *
 * Some local ONNX repos ship without a tokenizer chat template. Passing
 * ChatMessage[] then makes Transformers.js call apply_chat_template() and fail
 * before generation. The explicit prompt keeps the same contract while working
 * for text-prompt models.
 */
export function buildPrompt(userText: string): string {
  return [
    "SYSTEM:",
    SYSTEM_PROMPT,
    "",
    "USER:",
    userText,
    "",
    "ASSISTANT:",
  ].join("\n");
}
