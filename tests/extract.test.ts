/**
 * Tolerant extraction from Leclerc's JS literals:
 *   extractArrayNamed, smallestEnclosingObject, scanProductRecords, extractCartTotal.
 */
import { test, assert, extractArrayNamed, smallestEnclosingObject, scanProductRecords, extractCartTotal, STORE_PAGE_MARKER } from "./helpers.ts";

// ---- extractArrayNamed ----------------------------------------------------

test("extractArrayNamed: returns the balanced [...] after \"name\":[", () => {
  const html = 'x "lstProduits":[{"iIdProduit":1},{"iIdProduit":2}] y';
  assert.equal(extractArrayNamed(html, "lstProduits"), '[{"iIdProduit":1},{"iIdProduit":2}]');
});

test("extractArrayNamed: exact key match — lstProduitsLight is NOT matched by lstProduits", () => {
  const html = '"lstProduitsLight":[{"iIdProduit":1}]';
  assert.equal(extractArrayNamed(html, "lstProduits"), null);
  assert.equal(extractArrayNamed(html, "lstProduitsLight"), '[{"iIdProduit":1}]');
});

test("extractArrayNamed: handles brackets inside strings (no false close)", () => {
  const html = '"a":[{"k":"v]w"},{"k":"x"}]';
  // The ']' inside the string must not end the array.
  assert.equal(extractArrayNamed(html, "a"), '[{"k":"v]w"},{"k":"x"}]');
});

test("extractArrayNamed: handles escaped quotes inside strings", () => {
  const html = String.raw`"a":[{"k":"v\"w]"}]`;
  assert.equal(extractArrayNamed(html, "a"), String.raw`[{"k":"v\"w]"}]`);
});

test("extractArrayNamed: returns null when key absent", () => {
  assert.equal(extractArrayNamed("no arrays here", "lstProduits"), null);
});

test("extractArrayNamed: returns null for an unbalanced array", () => {
  const html = '"a":[{"k":"v"';
  assert.equal(extractArrayNamed(html, "a"), null);
});

// ---- smallestEnclosingObject ---------------------------------------------

test("smallestEnclosingObject: returns the nearest enclosing object", () => {
  const raw = '{"outer":{"iIdProduit":1,"nested":{"x":1}}}';
  const at = raw.indexOf('"iIdProduit"');
  assert.equal(smallestEnclosingObject(raw, at), '{"iIdProduit":1,"nested":{"x":1}}');
});

test("smallestEnclosingObject: returns null when no enclosing brace", () => {
  const raw = 'foo "iIdProduit":1 bar';
  assert.equal(smallestEnclosingObject(raw, raw.indexOf('"iIdProduit"')), null);
});

test("smallestEnclosingObject: ignores braces inside strings", () => {
  const raw = '{"iIdProduit":1,"label":"{not a brace}"}';
  const at = raw.indexOf('"iIdProduit"');
  assert.equal(smallestEnclosingObject(raw, at), raw); // whole object
});

// ---- scanProductRecords ---------------------------------------------------

test("scanProductRecords: parses all valid iIdProduit objects", () => {
  const raw = '{"iIdProduit":1,"sLibelleLigne1":"A"}{"iIdProduit":2,"sLibelleLigne1":"B"}';
  const recs = scanProductRecords(raw);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.iIdProduit), [1, 2]);
});

test("scanProductRecords: skips objects that fail to JSON.parse (function members)", () => {
  // An object containing a JS function is not valid JSON; it must be skipped.
  const raw = '{"iIdProduit":1,"fn":function(){}}{"iIdProduit":2,"ok":true}';
  const recs = scanProductRecords(raw);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].iIdProduit, 2);
});

test("scanProductRecords: returns [] for empty input", () => {
  assert.deepEqual(scanProductRecords(""), []);
});

// ---- extractCartTotal -----------------------------------------------------

test("extractCartTotal: reads sTotalAPayer near lstProduitsLight within its window", () => {
  const html = `${STORE_PAGE_MARKER} ... "sTotalAPayer":"18,18 €" ...`;
  assert.equal(extractCartTotal(html), "18,18 €");
});

test("extractCartTotal: only looks within ~1500 chars of the marker", () => {
  const far = STORE_PAGE_MARKER + "x".repeat(1600) + '"sTotalAPayer":"9,99 €"';
  assert.equal(extractCartTotal(far), undefined);
});

test("extractCartTotal: undefined when no total present", () => {
  assert.equal(extractCartTotal(STORE_PAGE_MARKER + "nothing here"), undefined);
});