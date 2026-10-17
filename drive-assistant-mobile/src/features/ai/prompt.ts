/**
 * Prompt système + constructeur de messages pour le normaliseur local de
 * liste de courses. Port isolé et fidèle de mcp-leclerc-drive
 * (src/orchestrator/prompt.ts).
 *
 * Le modèle ne produit JAMAIS de product_id : ceux-ci ne viennent que des
 * résultats réels de search_products. Le prompt énonce cette règle ; plan.ts
 * la défend en rejetant/nettoyant tout id halluciné.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const SYSTEM_PROMPT = [
  'TACHE: convertir le texte USER en JSON de liste de courses.',
  'IMPORTANT: copie seulement les produits explicitement écrits par USER.',
  'INTERDIT: inventer des ingrédients, compléter une recette, proposer un produit absent de USER.',
  'SORTIE: uniquement JSON valide, sans markdown, sans explication.',
  'FORMAT: {"items":[{"query":"nom du produit","quantity":1,"constraints":"poids volume format si indiqué"}],"questions":[]}',
  'REGLES:',
  '- Un produit écrit par USER devient un item.',
  '- query = mots du produit dans USER, sans poids, volume ni quantité.',
  '- quantity = nombre d\'unités explicite: x6 => 6, 2 paquets => 2. Sinon 1.',
  '- constraints = poids, volume ou format explicite: 500 g, 1L, 1 kg, boite de 6.',
  '- Sépare les listes avec virgules, points-virgules, retours ligne, tirets ou puces.',
  '- Supprime les verbes comme achète, prends, ajoute.',
  '- Jamais product_id. Jamais id.',
  '- Si USER est seulement un plat ou une recette sans produits listés, retourne exactement {"items":[],"questions":["Donne-moi les ingrédients à acheter pour cette recette."]}',
  '- Les mots carbonara, ratatouille, bolognaise, crêpes désignent des plats: ne les transforme pas en ingrédients.',
].join('\n');

/** Format chat envoyé à l'API Mistral. */
export function buildMessages(userText: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ];
}

/** Format texte explicite (repli si pas de chat template). */
export function buildPrompt(userText: string): string {
  return ['SYSTEM:', SYSTEM_PROMPT, '', 'USER:', userText, '', 'ASSISTANT:'].join('\n');
}
