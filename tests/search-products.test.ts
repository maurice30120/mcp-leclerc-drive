/**
 * productsFromHtml — search-page product extraction, deduped + typed filter.
 */
import { test, assert, productsFromHtml } from "./helpers.ts";

test("productsFromHtml: extracts Produit records, dedupes, drops non-Produit", () => {
  const html = `
    "lstProduits":[
      {"iIdProduit":1,"sLibelleLigne1":"A","nrPVUnitaireTTC":1,"sType":"Produit"},
      {"iIdProduit":1,"sLibelleLigne1":"A DUPE","nrPVUnitaireTTC":9,"sType":"Produit"},
      {"iIdProduit":2,"sLibelleLigne1":"B","nrPVUnitaireTTC":2,"sType":"Categorie"},
      {"iIdProduit":3,"sLibelleLigne1":"C","nrPVUnitaireTTC":3}
    ]`;
  const products = productsFromHtml(html);
  assert.equal(products.length, 2); // dup dropped, sType!=Produit dropped
  assert.deepEqual(products.map((p) => p.id), ["1", "3"]); // C has no sType → kept
  assert.equal(products[0].label, "A"); // first wins on dedupe
});

test("productsFromHtml: empty input → []", () => {
  assert.deepEqual(productsFromHtml(""), []);
});