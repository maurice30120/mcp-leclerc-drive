import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecipeRequest, requestedServings, packagingFromLabel } from "../src/sidepanel-protocol/shopping-request.ts";

test("recipe requests accept the user's spelling and natural serving counts", () => {
  for (const text of ["je veux faire un casoulet 5 personne", "un cassoulet pour 5 personnes", "fais moi un cassoulet pour 5"]) {
    assert.equal(isRecipeRequest(text), true);
    assert.equal(requestedServings(text), 5);
  }
  assert.equal(isRecipeRequest("Je veux préparer une ratatouille"), true);
  assert.equal(isRecipeRequest("lait 1L, œufs x6, farine 1 kg"), false);
  assert.equal(requestedServings("un cassoulet", 6), 6);
  assert.equal(requestedServings("un plat pour 0"), 0, "invalid counts reach validation instead of silently changing the request");
});

test("catalogue packaging uses weights, volumes, multipacks and explicit counts", () => {
  assert.equal(packagingFromLabel("Haricots blancs secs - 500g"), "500 g");
  assert.equal(packagingFromLabel("Saucisses de Toulouse - 1,2kg"), "1.2 kg");
  assert.equal(packagingFromLabel("Lait - 6 x 1L"), "6 l");
  assert.equal(packagingFromLabel("Haricots - 2×400 g"), "800 g");
  assert.equal(packagingFromLabel("Œufs plein air x6"), "6 pièce");
  assert.equal(packagingFromLabel("Saucisses x4 - 300g"), "300 g / 4 pièce");
  assert.equal(packagingFromLabel("Saucisses de Toulouse"), undefined);
});
