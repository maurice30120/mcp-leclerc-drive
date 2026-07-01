/**
 * URL builders — store path, search, cart, and store-finder endpoints.
 */
import { test, assert, storePath, buildSearchUrl, cartUrl, NO_MATCH_QUERY, autocompleteUrl, coordinatesUrl, nearbyUrl, STORE_FINDER_API_BASE } from "./helpers.ts";

test("storePath: drives have storeId==noPR (default), relays differ", () => {
  assert.equal(storePath("053701"), "magasin-053701-053701");
  assert.equal(storePath("018201", "018202"), "magasin-018201-018202");
});

test("searchUrl: builds the recherche.aspx URL with encoded query", () => {
  assert.equal(
    buildSearchUrl("fd9-courses.leclercdrive.fr", "053701", "053701", "lait bio"),
    "https://fd9-courses.leclercdrive.fr/magasin-053701-053701/recherche.aspx?TexteRecherche=lait%20bio",
  );
});

test("searchUrl: preserves the no-match sentinel verbatim (no special chars)", () => {
  const u = buildSearchUrl("fd9-courses.leclercdrive.fr", "1", "1", NO_MATCH_QUERY);
  assert.ok(u.endsWith(`TexteRecherche=${NO_MATCH_QUERY}`));
});

test("searchUrl: special query chars are URL-encoded", () => {
  const u = buildSearchUrl("fd9-courses.leclercdrive.fr", "1", "1", "a&b=c?d");
  assert.ok(u.includes("TexteRecherche=a%26b%3Dc%3Fd"));
});

test("cartUrl: builds the panier.aspx op=1 endpoint with the store path", () => {
  assert.equal(
    cartUrl("fd9-courses.leclercdrive.fr", "053701", "053701"),
    "https://fd9-courses.leclercdrive.fr/magasin-053701-053701/panier.aspx?op=1",
  );
});

test("autocompleteUrl: encodes the search query, pins provider=Woosmap", () => {
  assert.equal(
    autocompleteUrl("Nantes"),
    `${STORE_FINDER_API_BASE}/autocomplete?search=Nantes&provider=Woosmap`,
  );
  // Verify the origin is the constant API host, not a user-supplied one (ADR 0004 carve-out).
  assert.ok(autocompleteUrl("anything").startsWith("https://api-recherchemagasins.leclercdrive.fr/"));
  assert.equal(
    autocompleteUrl("a&b"),
    `${STORE_FINDER_API_BASE}/autocomplete?search=a%26b&provider=Woosmap`,
  );
});

test("coordinatesUrl: encodes the place id", () => {
  assert.equal(
    coordinatesUrl("pl_123"),
    `${STORE_FINDER_API_BASE}/autocomplete/coordinates?id=pl_123&provider=Woosmap`,
  );
});

test("nearbyUrl: encodes coordinates and postal code", () => {
  const u = nearbyUrl(47.21, -1.55, "44000");
  assert.equal(
    u,
    `${STORE_FINDER_API_BASE}/MapPoint/nearby?latitude=47.21&longitude=-1.55&postalCode=44000`,
  );
  assert.ok(nearbyUrl(0, 0, "c&d").endsWith("postalCode=c%26d"));
});