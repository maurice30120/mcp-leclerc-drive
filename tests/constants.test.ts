/**
 * ADR invariants & exported constants of api.ts.
 */
import { test, assert, ACTION_ADD, ACTION_SUB, RETRYABLE_STATUSES, STORE_PAGE_MARKER, NO_MATCH_QUERY, STORE_FINDER_API_BASE, isRetryableStatus } from "./helpers.ts";

test("action discriminators are the documented integers", () => {
  assert.equal(ACTION_ADD, 1);
  assert.equal(ACTION_SUB, 2);
});

test("STORE_PAGE_MARKER / NO_MATCH_QUERY are the documented literals", () => {
  assert.equal(STORE_PAGE_MARKER, "lstProduitsLight");
  assert.equal(NO_MATCH_QUERY, "zzzznomatchzzz");
});

test("store finder base is the constant Leclerc API origin", () => {
  assert.equal(
    STORE_FINDER_API_BASE,
    "https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1",
  );
});

test("RETRYABLE_STATUSES contains exactly the DataDome/limit statuses", () => {
  assert.equal(RETRYABLE_STATUSES.size, 2);
  assert.ok(RETRYABLE_STATUSES.has(403));
  assert.ok(RETRYABLE_STATUSES.has(429));
});

test("isRetryableStatus: 403/429 retry, 200/500/0 don't", () => {
  assert.equal(isRetryableStatus(403), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(500), false);
  assert.equal(isRetryableStatus(0), false);
});