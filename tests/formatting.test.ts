/**
 * Formatting helpers — formatProduct / formatCart (tool return text).
 */
import { test, assert, formatProduct, formatCart } from "./helpers.ts";

test("formatProduct: joins label, brand, price, [pricePerUnit], nutri, availability, id", () => {
  const out = formatProduct({
    id: "111",
    label: "Lait",
    brand: "Marque Repère",
    price: 1.29,
    pricePerUnit: "1,29 €/L",
    nutriScore: "A",
    available: true,
  });
  assert.equal(out, "Lait (Marque Repère) — 1.29 € [1,29 €/L] Nutri-Score A id=111");
});

test("formatProduct: omits optional bits, flags unavailable", () => {
  const out = formatProduct({ id: "9", label: "X", price: 2, available: false });
  assert.equal(out, "X — 2.00 € ⚠️ indisponible id=9");
});

test("formatCart: empty cart message", () => {
  const out = formatCart({ items: [], itemCount: 0, total: 0, storeId: "1" });
  assert.equal(out, "Panier vide.");
});

test("formatCart: lists lines + total + article count", () => {
  const out = formatCart({
    storeId: "053701",
    itemCount: 3,
    total: 4.08,
    items: [
      { product: { id: "111", label: "Lait", price: 1.29, available: true }, quantity: 2, lineTotal: 2.58 },
      { product: { id: "222", label: "Pain", price: 1.5, available: true }, quantity: 1, lineTotal: 1.5 },
    ],
  });
  assert.equal(
    out,
    [
      "Panier (magasin 053701) — 3 article(s) :",
      "• 2× Lait — 2.58 € (id=111)",
      "• 1× Pain — 1.50 € (id=222)",
      "",
      "Total : 4.08 €",
    ].join("\n"),
  );
});