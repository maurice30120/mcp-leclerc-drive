/**
 * mapProduct — raw backend record (RawProduct) → Product exposed to the model.
 */
import { test, assert, mapProduct, type RawProduct } from "./helpers.ts";

test("mapProduct: maps the canonical fields, decodes label entities", () => {
  const rp: RawProduct = {
    iIdProduit: 123456,
    sLibelleLigne1: "Lait&nbsp;demi-&#233;cr&#233;m&#233; bio",
    sLibelleLigne2: "1L",
    nrPVUnitaireTTC: 1.29,
    sPrixParUniteDeMesure: "1,29 €/L",
    iQteDisponible: 5,
    sUrlVignetteProduit: "https://img/x.png",
  };
  const p = mapProduct(rp);
  assert.equal(p.id, "123456");
  assert.equal(p.label, "Lait demi-écrémé bio 1L");
  assert.equal(p.price, 1.29);
  assert.equal(p.pricePerUnit, "1,29 €/L");
  assert.equal(p.available, true);
  assert.equal(p.imageUrl, "https://img/x.png");
});

test("mapProduct: price falls back to sPrixUnitaire string when numeric missing", () => {
  const p = mapProduct({ iIdProduit: 1, sPrixUnitaire: "2,49 €" });
  assert.equal(p.price, 2.49);
});

test("mapProduct: price defaults to 0 when nothing parseable, falls back to 'Produit <id>' label", () => {
  const p = mapProduct({ iIdProduit: 9 });
  assert.equal(p.price, 0);
  assert.equal(p.label, "Produit 9");
  assert.equal(p.available, false); // iQteDisponible missing → 0 → not available
});

test("mapProduct: string iIdProduit is coerced to string id", () => {
  assert.equal(mapProduct({ iIdProduit: "abc", nrPVUnitaireTTC: 1 }).id, "abc");
});