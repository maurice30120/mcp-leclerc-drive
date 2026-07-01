/**
 * Scalar coercion helpers — num / parseEuro / round2 / decodeEntities.
 */
import { test, assert, num, parseEuro, round2, decodeEntities } from "./helpers.ts";

test("num: number passthrough, numeric string coerced, else undefined", () => {
  assert.equal(num(42), 42);
  assert.equal(num("42"), 42);
  assert.equal(num("  7 "), 7);
  assert.equal(num(""), undefined);
  assert.equal(num("abc"), undefined);
  assert.equal(num(null), undefined);
  assert.equal(num(undefined), undefined);
  assert.equal(num(true), undefined);
});

test("parseEuro: French 'D,DD €' → number; rejects non-strings and empty", () => {
  assert.equal(parseEuro("11,88 €"), 11.88);
  assert.equal(parseEuro("1,99"), 1.99);
  assert.equal(parseEuro("18,18"), 18.18);
  assert.equal(parseEuro("not a price"), undefined);
  assert.equal(parseEuro(123), undefined); // non-string
  assert.equal(parseEuro("€"), undefined); // no digits → empty cleaned string
  assert.equal(parseEuro(""), undefined);
});

test("round2: rounds to two decimals (subject to float precision)", () => {
  // NOTE: 1.005 * 100 === 100.49999999999999 in IEEE-754, so round2(1.005) === 1,
  // not 1.01. This is the existing behaviour; we pin it so a future "fix" is
  // a deliberate change, not a silent drift.
  assert.equal(round2(1.005), 1);
  assert.equal(round2(2.3456), 2.35);
  assert.equal(round2(2.999), 3);
  assert.equal(round2(18.184999), 18.18);
});

test("decodeEntities: numeric, hex, named, and &nbsp;", () => {
  assert.equal(decodeEntities("Lait&nbsp;demi-&#233;cr&#233;m&#233;"), "Lait demi-écrémé");
  assert.equal(decodeEntities("&#x26;"), "&");
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&#39;&apos;"), "&<>\"''");
  assert.equal(decodeEntities("plain"), "plain");
});