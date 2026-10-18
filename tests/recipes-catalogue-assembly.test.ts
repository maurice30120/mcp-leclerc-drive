/**
 * Catalogue assembly (ticket 32): the whole shipped catalogue — witness set +
 * imported Wikilivres lot — validates with the same public contract as
 * personal recipes, identifiers are unique and unambiguous, and every
 * imported entry carries its provenance and licence notice (ADR 0007).
 */
import { test, assert } from "./helpers.ts";
import { parseRecipe } from "../src/recipes/contract.ts";
import { loadCatalogue } from "../src/recipes/catalogue.ts";
import wikilivres from "../src/recipes/catalogue-wikilivres.json" with { type: "json" };

const catalogue = loadCatalogue(parseRecipe);

test("assembly: the whole shipped catalogue validates with the public contract", () => {
  // loadCatalogue throws on the first invalid entry: reaching here means the
  // entire delivered catalogue (witness + Wikilivres) passes the contract.
  assert.ok(catalogue.recipes.length >= 50, `catalogue livré trop petit : ${catalogue.recipes.length}`);
  const ids = catalogue.recipes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "identifiants uniques");
});

test("assembly: catalogue ids never collide with the personal namespace", () => {
  for (const r of catalogue.recipes) {
    assert.doesNotMatch(r.id, /^pers-/, `identifiant personnel dans le catalogue : ${r.id}`);
  }
});

test("assembly: every shipped recipe carries provenance and a licence notice", () => {
  for (const r of catalogue.recipes) {
    assert.equal(r.provenance.origin, "catalogue", `origine catalogue requise : ${r.id}`);
    if (r.provenance.origin === "catalogue") {
      assert.ok(r.provenance.licence.length > 0, `notice de licence requise : ${r.id}`);
      assert.ok(r.provenance.source.length > 0, `source requise : ${r.id}`);
    }
  }
});

test("assembly: the Wikilivres lot ships with its licence, attribution and adaptations", () => {
  const file = wikilivres as {
    licence?: string;
    source?: string;
    notice?: string;
    recipes: Array<{
      id: string;
      provenance: {
        origin: string;
        source: string;
        url: string;
        licence: string;
        attribution: string;
        adaptations: string;
      };
    }>;
  };
  assert.match(file.licence ?? "", /CC BY-SA 4\.0/, "licence CC BY-SA du lot");
  assert.ok((file.notice ?? "").length > 0, "notice de licence distincte du code (ADR 0007)");
  assert.ok(file.recipes.length > 0, "lot non vide");
  for (const r of file.recipes) {
    assert.equal(r.provenance.source, "Wikilivres");
    assert.ok(r.provenance.url.startsWith("https://fr.wikibooks.org/wiki/"), `URL source : ${r.id}`);
    assert.match(r.provenance.licence, /CC BY-SA 4\.0/);
    assert.match(r.provenance.attribution, /Contributeurs de Wikilivres/, `attribution : ${r.id}`);
    assert.ok(r.provenance.adaptations.length > 0, `adaptations documentées : ${r.id}`);
    // The shipped entry itself passes the contract (validated via the loader).
    assert.ok(catalogue.byId.has(r.id), `entrée du lot indexée : ${r.id}`);
  }
});

test("assembly: witness set and Wikilivres lot coexist without id overlap", () => {
  const witnessIds = ["crepes-classiques", "gratin-dauphinois", "omelette-au-fromage"];
  for (const id of witnessIds) assert.ok(catalogue.byId.has(id), `recette témoin absente : ${id}`);
});
