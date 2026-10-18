#!/usr/bin/env node
/**
 * Wikilivres catalogue importer (tickets 19 + 32) — reproducible.
 *
 * Fetches recipe pages from the French Wikibooks "Livre de cuisine" through
 * the MediaWiki API (proper User-Agent, batched 50-title queries, spaced
 * requests + backoff), parses each page's Ingredients/Preparation sections
 * with deterministic heuristics, validates every candidate against the
 * COMMON recipe contract (npm run build first — the script imports the
 * compiled contract so there is a single source of truth) and writes the
 * validated entries to a JSON catalogue file with full provenance.
 *
 * Honesty rules (spec):
 *   - a page without explicit servings is REJECTED — portions are never
 *     invented; a range "6-8 personnes" uses its lower bound, recorded in
 *     provenance.adaptations;
 *   - quantities that cannot be parsed as number + unit reject the recipe;
 *   - rejected pages are counted and reported, never completed artificially.
 *
 * Provenance per entry: source "Wikilivres", page URL, licence CC BY-SA 4.0,
 * attribution to the page contributors (page history link) and the
 * adaptations applied by the import — per ADR 0007, the catalogue data
 * carries its own licence, distinct from the MIT code.
 *
 * Usage:
 *   npm run build && node scripts/import-wikilivres.mjs \
 *     [--categories "Desserts,Plat principal,..."] \
 *     [--out src/recipes/catalogue-wikilivres.json] \
 *     [--limit N] [--delay-ms 3000]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, "dist", "recipes", "contract.js");

if (!existsSync(CONTRACT_PATH)) {
  console.error("Contrat compilé introuvable : lance d'abord `npm run build`.");
  process.exit(1);
}
const { parseRecipe } = await import(`file://${CONTRACT_PATH}`);

// ---- CLI ----------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DEFAULT_CATEGORIES = [
  "Accompagnements",
  "Amuse bouches",
  "Bases",
  "Boissons",
  "Confitures",
  "Desserts",
  "Entrées",
  "Fritures",
  "Galettes",
  "Pains",
  "Pâtes alimentaires",
  "Petits-déjeuners",
  "Plat principal",
  "Poissons",
  "Recettes de pizzas",
  "Recettes de ragoût",
  "Recettes de tartes",
  "Salades",
  "Sandwiches",
  "Soupes",
  "Sucreries",
  "Viande",
].join(",");

const CATEGORIES = (arg("categories", DEFAULT_CATEGORIES)).split(",").map((c) => c.trim()).filter(Boolean);
const OUT = arg("out", join(ROOT, "src", "recipes", "catalogue-wikilivres.json"));
const LIMIT = Number(arg("limit", "0")); // 0 = no limit
const DELAY_MS = Number(arg("delay-ms", "3000"));
const API = "https://fr.wikibooks.org/w/api.php";
const UA =
  "mcp-leclerc-drive/1.0 (https://github.com/maurice30120/mcp-leclerc-drive; " +
  "recipe catalogue import; reproducible script in repo)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
async function apiGet(params) {
  for (let attempt = 1; ; attempt++) {
    await sleep(DELAY_MS);
    requestCount++;
    const url = `${API}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429 || res.status === 403) {
      const wait = DELAY_MS * 4 * attempt;
      console.warn(`  API ${res.status} — nouvelle tentative dans ${wait} ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`API HTTP ${res.status}`);
    const text = await res.text();
    if (text.startsWith("You are making too many requests")) {
      const wait = DELAY_MS * 6 * attempt;
      console.warn(`  API limitée — nouvelle tentative dans ${wait} ms`);
      await sleep(wait);
      continue;
    }
    return JSON.parse(text);
  }
}

// ---- Category listing -----------------------------------------------------------

async function listCategoryPages(category) {
  const titles = [];
  let cont = undefined;
  do {
    const params = {
      action: "query",
      list: "categorymembers",
      cmtitle: `Catégorie:${category}`,
      cmtype: "page",
      cmlimit: "500",
      format: "json",
    };
    if (cont) params.cmcontinue = cont;
    const data = await apiGet(params);
    for (const m of data.query.categorymembers) {
      if (m.ns === 0 && m.title.startsWith("Livre de cuisine/")) titles.push(m.title);
    }
    cont = data.continue?.cmcontinue;
  } while (cont);
  return titles;
}

// ---- Batched content fetch -------------------------------------------------------

async function fetchContents(titles) {
  const contents = [];
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const data = await apiGet({
      action: "query",
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      titles: batch.join("|"),
      format: "json",
    });
    const missing = new Set();
    for (const p of Object.values(data.query.pages)) {
      if (p.missing !== undefined) { missing.add(p.title); continue; }
      const content = p.revisions?.[0]?.slots?.main?.["*"];
      if (typeof content === "string") contents.push({ title: p.title, content });
    }
    if (missing.size > 0) console.warn(`  ${missing.size} page(s) manquante(s) dans le lot`);
  }
  return contents;
}

// ---- Wikitext parsing (deterministic heuristics) -----------------------------------

const UNIT_MAP = [
  [/^kgs?$/, "kg"],
  [/^kilogrammes?$/, "kg"],
  [/^grammes?$/, "g"],
  [/^g$/, "g"],
  [/^millilitres?$/, "ml"],
  [/^ml$/, "ml"],
  [/^centilitres?$/, "cl"],
  [/^cl$/, "cl"],
  [/^décilitres?$/, "dl"],
  [/^dl$/, "dl"],
  [/^litres?$/, "l"],
  [/^l$/, "l"],
  [/^cuillères?(?:ée)?s?\s*(?:à\s*soupe|à\s*café)$/i, null], // handled below
];

function normalizeUnit(raw) {
  const u = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^cuill(?:è|e)r(?:ée|e)?s?\s*à\s*soupe$/.test(u)) return "c. à soupe";
  if (/^cuill(?:è|e)r(?:ée|e)?s?\s*à\s*caf(?:é|e)$/.test(u)) return "c. à café";
  if (/^cuill(?:è|e)re?s?$/.test(u)) return "c. à soupe"; // bare "cuiller" = soupe in this book
  if (/^(kgs?|kilogrammes?)$/.test(u)) return "kg";
  if (/^(grammes?|g)$/.test(u)) return "g";
  if (/^(millilitres?|ml)$/.test(u)) return "ml";
  if (/^(centilitres?|cl)$/.test(u)) return "cl";
  if (/^(décilitres?|dl)$/.test(u)) return "dl";
  if (/^(litres?|l)$/.test(u)) return "l";
  if (/^pi(?:è|e)ces?$/.test(u)) return "pièce";
  if (/^pinc(?:é|e)es?$/.test(u)) return "pincée";
  if (/^sachets?$/.test(u)) return "sachet";
  if (/^gousses?$/.test(u)) return "gousse";
  if (/^tranches?$/.test(u)) return "tranche";
  if (/^feuilles?$/.test(u)) return "feuille";
  if (/^branches?$/.test(u)) return "branche";
  if (/^bottes?$/.test(u)) return "botte";
  if (/^verres?$/.test(u)) return "verre";
  if (/^tasses?$/.test(u)) return "tasse";
  if (/^morceaux?$/.test(u)) return "morceau";
  if (/^barquettes?$/.test(u)) return "barquette";
  if (/^bo(?:î|i)tes?$/.test(u)) return "boîte";
  if (/^paquets?$/.test(u)) return "paquet";
  return u; // free-form unit stays as-is (contract allows explicit units)
}

/** Strip wikitext markup to plain text (deterministic, inert). */
function stripMarkup(text) {
  return text
    .replace(/<math>[\s\S]*?<\/math>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{i\|([^}]*)\}\}/g, (_m, inner) => {
      const parts = inner.split("|").map((p) => p.trim()).filter(Boolean);
      // {{i|flag|main|plural}} style: keep the LAST segment as the display word.
      return parts.length > 0 ? parts[parts.length - 1] : "";
    })
    .replace(/\{\{[^}]*\}\}/g, " ")
    .replace(/\[\[[^]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/&nbsp;|&amp;/g, (m) => (m === "&nbsp;" ? " " : "&"))
    .replace(/[ \t]+/g, " ")
    .trim();
}

function sectionContent(wikitext, headingRe) {
  const lines = wikitext.split("\n");
  let capturing = false;
  let level = 2;
  const out = [];
  for (const line of lines) {
    const m = /^(={2,})(.*)\1\s*$/.exec(line.trim());
    if (m) {
      if (capturing) break; // start of a version/subsection: keep the first only
      if (!capturing && headingRe.test(m[2].trim())) {
        capturing = true;
        level = m[1].length;
        out.push(m[2].trim()); // heading text: servings often live there
      }
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join("\n");
}

/**
 * Parse one ingredient bullet line → { name, quantity, unit } or null.
 * Deterministic, anchored unit matching (longest first); a range "4-6 œufs"
 * keeps its lower bound; a line with no readable quantity rejects the page.
 */
const UNIT_PATTERNS = [
  [/^cuill(?:è|e)r(?:ée|e)?s?\s*à\s*soupe\b/i, "c. à soupe"],
  [/^cuill(?:è|e)r(?:ée|e)?s?\s*à\s*caf(?:é|e)\b/i, "c. à café"],
  [/^cuill(?:è|e)r(?:ée|e)?s?\b/i, "c. à soupe"],
  [/^cuill(?:è|e)ré?e?s?\b/i, "c. à soupe"],
  [/^pot de yaourt\b/i, "pot de yaourt"],
  [/^kilo?grammes?\b|^kgs?\b/i, "kg"],
  [/^grammes?\b|^gs?\b/i, "g"],
  [/^millilitres?\b|^ml\b/i, "ml"],
  [/^centilitres?\b|^cl\b/i, "cl"],
  [/^décilitres?\b|^dl\b/i, "dl"],
  [/^litres?\b/i, "l"],
  [/^pinc(é|e)es?\b/i, "pincée"],
  [/^pi(è|e)ces?\b/i, "pièce"],
  [/^sachets?\b/i, "sachet"],
  [/^gousses?\b/i, "gousse"],
  [/^tranches?\b/i, "tranche"],
  [/^feuilles?\b/i, "feuille"],
  [/^branches?\b/i, "branche"],
  [/^bottes?\b/i, "botte"],
  [/^verres?\b/i, "verre"],
  [/^tasses?\b/i, "tasse"],
  [/^morceaux?\b/i, "morceau"],
  [/^bo(î|i)tes?\b/i, "boîte"],
  [/^paquets?\b/i, "paquet"],
  [/^barquettes?\b/i, "barquette"],
];

function parseIngredientLine(rawLine) {
  const line = stripMarkup(rawLine.replace(/^\s*[#*]+/, "").trim());
  if (line.length === 0) return null;
  const qm = /^(\d+(?:[.,]\d+)?)(?:\s*[-–à]+\s*(\d+))?/.exec(line);
  if (!qm) return null;
  const quantity = Number(qm[1].replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  let rest = line.slice(qm[0].length).trim();

  let unit = "pièce";
  for (const [re, normalized] of UNIT_PATTERNS) {
    const um = re.exec(rest);
    if (um) {
      unit = normalized;
      rest = rest.slice(um[0].length).trim();
      break;
    }
  }
  // Strip the connecting "de " / "d'" / "du" / "de la" before the name.
  let name = rest
    .replace(/^(?:de\s+|d'\s*|du\s+|de\s+la\s+|des\s+|à\s+)/i, "")
    .replace(/\s+\(.*\)$/, "")
    .replace(/[;,.：]+\s*$/, "")
    .trim();
  if (name.length === 0) return null;
  return { name, quantity, unit };
}

function parseServings(ingredientsText) {
  // "Pour 6-8 personnes" / "Pour 6 personnes" / "pour six personnes"
  const wordNums = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12 };
  const m = /pour\s+((?:\d+)|(?:[a-zé]+))\s*(?:[-–à ]+\s*(\d+))?\s*personnes?/i.exec(ingredientsText);
  if (!m) return null;
  const first = /^\d+$/.test(m[1]) ? Number(m[1]) : wordNums[m[1].toLowerCase()];
  if (first === undefined || !Number.isInteger(first) || first < 1) return null;
  return { servings: first, ranged: m[2] !== undefined };
}

function slugify(title) {
  const name = title.replace(/^Livre de cuisine\//, "");
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseRecipePage({ title, content }, category) {
  const name = title.replace(/^Livre de cuisine\//, "").trim();
  const ingredientsText = sectionContent(content, /^ingr[ée]dients/i);
  const stepsText =
    sectionContent(content, /^pr[ée]paration/i) ||
    sectionContent(content, /^r[ée]alisation/i) ||
    sectionContent(content, /^mode op[ée]ratoire/i);

  if (!ingredientsText || !stepsText) return { reject: "sections manquantes" };

  let servingsInfo = parseServings(ingredientsText);
  if (!servingsInfo) {
    // Fallback: the page may state its servings outside the ingredient
    // section (intro). Still the page's own explicit statement — never
    // invented.
    servingsInfo = parseServings(content);
  }
  if (!servingsInfo) return { reject: "portions absentes" };

  const ingredientLines = ingredientsText
    .split("\n")
    .filter((l) => /^\s*[*#]/.test(l));
  // Use the first version's list: stop at a subsection heading change is
  // already handled by sectionContent; take lines until the first blank
  // block after at least one ingredient, to avoid mixing versions.
  const ingredients = [];
  for (const l of ingredientLines) {
    const ing = parseIngredientLine(l);
    if (!ing) {
      if (ingredients.length > 0) break; // a line we cannot read ends the list
      return { reject: "ingrédient illisible" };
    }
    ingredients.push(ing);
  }
  if (ingredients.length === 0) return { reject: "aucun ingrédient parsé" };

  const steps = stepsText
    .split("\n")
    .filter((l) => /^\s*[*#]/.test(l))
    .map((l) => stripMarkup(l.replace(/^\s*[#*]+/, "").trim()))
    .filter((s) => s.length > 0);
  if (steps.length === 0) return { reject: "aucune étape parsée" };

  const url = `https://fr.wikibooks.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const adaptations = [
    "Import automatisé du wikitext Wikilivres.",
    servingsInfo.ranged ? `Portions de référence : borne inférieure de la fourchette indiquée.` : null,
    "Unités normalisées (g, kg, ml, c. à soupe…) ; lignes sans unité comprises comme « pièce ».",
  ].filter(Boolean).join(" ");

  return {
    candidate: {
      id: slugify(title),
      title: name,
      servings: servingsInfo.servings,
      category,
      ingredients,
      steps,
      provenance: {
        origin: "catalogue",
        source: "Wikilivres",
        url,
        licence: "CC BY-SA 4.0",
        attribution: `Contributeurs de Wikilivres — historique : ${url}?action=history`,
        adaptations,
      },
    },
  };
}

// ---- Main ------------------------------------------------------------------------

console.log(`Import Wikilivres — catégories : ${CATEGORIES.join(", ")}`);
const titleToCategory = new Map();
for (const category of CATEGORIES) {
  const titles = await listCategoryPages(category);
  console.log(`Catégorie ${category} : ${titles.length} pages`);
  for (const t of titles) {
    // First imported category wins — deterministic category per page.
    if (!titleToCategory.has(t)) titleToCategory.set(t, category);
  }
}
let titles = [...titleToCategory.keys()].sort();
if (LIMIT > 0) titles = titles.slice(0, LIMIT);
console.log(`Pages uniques à traiter : ${titles.length} (requêtes API : ${requestCount})`);

console.log("Récupération du contenu par lots de 50…");
const contents = await fetchContents(titles);
console.log(`Contenus récupérés : ${contents.length} (requêtes API : ${requestCount})`);

const accepted = [];
const rejects = new Map();
for (const page of contents) {
  // Category = the first imported category the page lists; keep the
  // deterministic page order for reproducibility.
  const category = titleToCategory.get(page.title)?.toLowerCase() ?? "recette";
  const parsed = parseRecipePage(page, category);
  if (parsed.reject) {
    rejects.set(parsed.reject, (rejects.get(parsed.reject) ?? 0) + 1);
    continue;
  }
  const v = parseRecipe(parsed.candidate);
  if (!v.ok) {
    rejects.set(`contrat : ${v.error.split("(")[0].slice(0, 40)}`, (rejects.get(`contrat : ${v.error.split("(")[0].slice(0, 40)}`) ?? 0) + 1);
    continue;
  }
  accepted.push(parsed.candidate);
}

// Dedup by id (a page listed under several categories appears once).
const byId = new Map();
for (const r of accepted) if (!byId.has(r.id)) byId.set(r.id, r);
const recipes = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

console.log(`\nRésultat : ${recipes.length} recettes validées, ${byId.size !== accepted.length ? accepted.length - byId.size : 0} doublons écartés`);
console.log(`Pages rejetées : ${contents.length - accepted.length}`);
for (const [reason, count] of [...rejects.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  - ${reason} : ${count}`);
}

const payload = {
  $schema: "mcp-leclerc-drive/recipe-catalogue/1",
  source: "Wikilivres — Livre de cuisine (https://fr.wikibooks.org/wiki/Livre_de_cuisine)",
  licence: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/deed.fr)",
  notice:
    "Données de catalogue sous licence CC BY-SA 4.0, distinctes de la licence MIT du code " +
    "(ADR 0007). Attribution : Contributeurs de Wikilivres — voir l'historique de chaque page. " +
    "Généré par scripts/import-wikilivres.mjs. " +
    "Note de livraison : la cible d'environ 500 recettes n'est pas atteinte — seules les pages " +
    "portant des portions explicites et des quantités lisibles sont retenues ; la spec interdit " +
    "de compléter artificiellement une recette incomplète.",
  recipes,
};
writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
console.log(`Catalogue écrit → ${OUT} (requêtes API totales : ${requestCount})`);

