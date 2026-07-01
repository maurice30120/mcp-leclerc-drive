/**
 * assertStorePage — DataDome / session-expiry guard on fetched HTML.
 */
import { test, assert, assertStorePage, STORE_PAGE_MARKER } from "./helpers.ts";

test("assertStorePage: returns silently when the marker is present", () => {
  assert.doesNotThrow(() => assertStorePage(`<html>${STORE_PAGE_MARKER}</html>`));
});

test("assertStorePage: throws a DataDome message when marker is missing", () => {
  assert.throws(
    () => assertStorePage("<html>some interstitial</html>"),
    /DataDome/,
  );
});

test("assertStorePage: throws an expired-session message for the session page", () => {
  assert.throws(
    () => assertStorePage("<html>votre session a expiree</html>"),
    /Session Leclerc Drive expir/i,
  );
  assert.throws(
    () => assertStorePage("<html>SessionExpiree</html>"),
    /Session Leclerc Drive expir/i,
  );
});