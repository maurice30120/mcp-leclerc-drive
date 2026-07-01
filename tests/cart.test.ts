/**
 * Cart assembly — cartFromHtml (scrape a no-match page) and cartFromEvents
 * (mutation response), plus the cartMutationBody payload builder.
 */
import { test, assert, cartFromHtml, cartFromEvents, cartMutationBody, ACTION_ADD, ACTION_SUB, STORE_PAGE_MARKER, type CartEvent, type RawProduct } from "./helpers.ts";

/**
 * A realistic Leclerc no-match page snippet: a JSON `lstProduits` array + total.
 * extractArrayNamed looks for the exact `"lstProduits":[` JSON key (NOT a JS
 * `var lstProduits =` assignment), and extractCartTotal reads sTotalAPayer
 * within ~1500 chars of the first `lstProduitsLight` marker.
 */
const NO_MATCH_HTML =
  `${STORE_PAGE_MARKER} ... "sTotalAPayer":"4,08 €" ... ` +
  `"lstProduits":` +
  JSON.stringify([
    { iIdProduit: 111, sLibelleLigne1: "Lait", nrPVUnitaireTTC: 1.29, iQuantitePanier: 2, rTotalAPayer: 2.58, sType: "Produit" },
    { iIdProduit: 222, sLibelleLigne1: "Pain", sPrixUnitaire: "1,50 \u20ac", iQuantitePanier: 1, sTotalAPayer: "1,50 \u20ac", sType: "Produit" },
    { iIdProduit: 333, sLibelleLigne1: "Oubli", iQuantitePanier: 0, sType: "Produit" }, // qty 0 → dropped
  ]);

// ---- cartFromHtml ---------------------------------------------------------

test("cartFromHtml: builds items for qty>0 only, dedupes, maps totals", () => {
  const cart = cartFromHtml(NO_MATCH_HTML, "053701");
  assert.equal(cart.storeId, "053701");
  assert.equal(cart.items.length, 2); // qty-0 record dropped
  assert.equal(cart.items[0].product.id, "111");
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.items[0].lineTotal, 2.58); // numeric rTotalAPayer preferred
  assert.equal(cart.items[1].product.id, "222");
  assert.equal(cart.items[1].quantity, 1);
  assert.equal(cart.items[1].lineTotal, 1.5); // sTotalAPayer "1,50 €" → 1.5
  assert.equal(cart.itemCount, 3); // 2 + 1
});

test("cartFromHtml: grand total prefers the embedded sTotalAPayer string", () => {
  const cart = cartFromHtml(NO_MATCH_HTML, "053701");
  assert.equal(cart.total, 4.08);
});

test("cartFromHtml: falling back to sum of line totals when no total string", () => {
  const html = `${STORE_PAGE_MARKER}{"lstProduits":[{"iIdProduit":1,"nrPVUnitaireTTC":2,"iQuantitePanier":3,"sType":"Produit"}]}`;
  const cart = cartFromHtml(html, "1");
  assert.equal(cart.total, 6); // 2 * 3
  assert.equal(cart.itemCount, 3);
});

test("cartFromHtml: empty cart when lstProduits absent", () => {
  const html = `${STORE_PAGE_MARKER} nothing parseable here`;
  const cart = cartFromHtml(html, "1");
  assert.equal(cart.items.length, 0);
  assert.equal(cart.itemCount, 0);
  assert.equal(cart.total, 0);
});

test("cartFromHtml: dedupes repeated product ids keeping the first", () => {
  const html =
    STORE_PAGE_MARKER +
    JSON.stringify({
      lstProduits: [
        { iIdProduit: 1, sLibelleLigne1: "A", nrPVUnitaireTTC: 1, iQuantitePanier: 2, sType: "Produit" },
        { iIdProduit: 1, sLibelleLigne1: "A DUPE", nrPVUnitaireTTC: 9, iQuantitePanier: 5, sType: "Produit" },
      ],
    });
  const cart = cartFromHtml(html, "1");
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].product.label, "A"); // first wins
  assert.equal(cart.items[0].quantity, 2);
});

// ---- cartFromEvents -------------------------------------------------------

const ADD_EVENTS: CartEvent[] = [
  // A product line: sIdUnique starts with "Produit", sType "Produit"
  {
    sIdUnique: "Produit_111",
    objElement: {
      sType: "Produit",
      iIdProduit: 111,
      sLibelleLigne1: "Lait",
      nrPVUnitaireTTC: 1.29,
      iQuantitePanier: 2,
      rTotalAPayer: 2.58,
    },
  },
  // The Panier summary line: sIdUnique starts with "Panier"
  {
    sIdUnique: "Panier",
    objElement: { rTotalAPayer: 2.58, iQuantitePanier: 2 },
  },
];

test("cartFromEvents: assembles items + total from a mutation response", () => {
  const cart = cartFromEvents(ADD_EVENTS, "053701");
  assert.equal(cart.storeId, "053701");
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].product.id, "111");
  assert.equal(cart.items[0].quantity, 2);
  assert.equal(cart.items[0].lineTotal, 2.58);
  assert.equal(cart.total, 2.58);
  assert.equal(cart.itemCount, 2);
});

test("cartFromEvents: ignores Produit-* events whose sType isn't 'Produit'", () => {
  const events: CartEvent[] = [
    { sIdUnique: "Produit_x", objElement: { sType: "Promo", iIdProduit: 9 } },
    { sIdUnique: "Panier", objElement: { rTotalAPayer: 0, iQuantitePanier: 0 } },
  ];
  const cart = cartFromEvents(events, "1");
  assert.equal(cart.items.length, 0);
  assert.equal(cart.total, 0);
});

test("cartFromEvents: drops qty<=0 product lines (removed from cart)", () => {
  const events: CartEvent[] = [
    {
      sIdUnique: "Produit_111",
      objElement: { sType: "Produit", iIdProduit: 111, sLibelleLigne1: "X", nrPVUnitaireTTC: 1, iQuantitePanier: 0 },
    },
    { sIdUnique: "Panier", objElement: { rTotalAPayer: 0, iQuantitePanier: 0 } },
  ];
  const cart = cartFromEvents(events, "1");
  assert.equal(cart.items.length, 0);
});

test("cartFromEvents: empty array → empty cart", () => {
  const cart = cartFromEvents([], "1");
  assert.deepEqual(cart, { items: [], itemCount: 0, total: 0, storeId: "1" });
});

test("cartFromEvents: line total falls back to unit price * qty when missing", () => {
  const events: CartEvent[] = [
    {
      sIdUnique: "Produit_1",
      objElement: { sType: "Produit", iIdProduit: 1, sLibelleLigne1: "Y", nrPVUnitaireTTC: 2.5, iQuantitePanier: 3 },
    },
    { sIdUnique: "Panier", objElement: { rTotalAPayer: 7.5, iQuantitePanier: 3 } },
  ];
  const cart = cartFromEvents(events, "1");
  assert.equal(cart.items[0].lineTotal, 7.5); // 2.5 * 3
});

// ---- cartMutationBody -----------------------------------------------------

test("cartMutationBody: ADD encodes action + ids + quantity", () => {
  const body = cartMutationBody("111", 2, ACTION_ADD, "053701");
  assert.ok(body.startsWith("d="));
  const payload = JSON.parse(decodeURIComponent(body.slice(2)));
  assert.deepEqual(payload, {
    eTypeAction: 1,
    iIdProduit: "111",
    iQuantite: 2,
    sNoPointLivraison: "053701",
  });
});

test("cartMutationBody: SUB/removal uses action 2", () => {
  const payload = JSON.parse(decodeURIComponent(cartMutationBody("9", 0, ACTION_SUB, "1").slice(2)));
  assert.equal(payload.eTypeAction, 2);
  assert.equal(payload.iQuantite, 0);
});

test("cartMutationBody: productId is stringified (numeric or string input)", () => {
  const a = JSON.parse(decodeURIComponent(cartMutationBody(123, 1, ACTION_ADD, "1").slice(2)));
  assert.equal(a.iIdProduit, "123");
});