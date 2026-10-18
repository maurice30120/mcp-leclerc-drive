/** Natural-language routing shared by the popup and recipe assistant. */
export function requestedServings(message: string, fallback = 4): number {
  const match = message.match(/\b(\d+)\s*(?:personnes?|pers\.?|convives?|portions?)\b/i)
    ?? message.match(/\bpour\s+(\d+)\b/i);
  return match ? Number(match[1]) : fallback;
}

export function isRecipeRequest(message: string): boolean {
  const text = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return /\b(recette|cuisiner|cuisine|preparer|prepare|faire|fais|fait|menu|repas)\b/.test(text)
    || /\b\d+\s*(personnes?|pers\.?|convives?|portions?)\b/.test(text);
}

/** Only extract unambiguous packaging printed in a catalogue label. */
export function packagingFromLabel(label: string): string | undefined {
  const multipack = label.match(/\b(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
  if (multipack) return `${Number(multipack[1]) * Number(multipack[2].replace(",", "."))} ${multipack[3].toLowerCase()}`;
  const measure = label.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\s*$/i);
  const count = label.match(/\bx\s*(\d+)\b/i);
  if (measure) return `${measure[1].replace(",", ".")} ${measure[2].toLowerCase()}${count ? ` / ${count[1]} pièce` : ""}`;
  return count ? `${count[1]} pièce` : undefined;
}
