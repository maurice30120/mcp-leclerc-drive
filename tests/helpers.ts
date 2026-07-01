/**
 * Shared imports + fixtures for the api.ts unit tests.
 *
 * Each feature file re-exports from here so the test surface (the seam we
 * cross) is declared once, in one place — and adding a new export to api.ts
 * that needs testing only requires touching this file's import list.
 */

export { test, describe } from "node:test";
export { strict as assert } from "node:assert";

export {
  ACTION_ADD,
  ACTION_SUB,
  RETRYABLE_STATUSES,
  STORE_PAGE_MARKER,
  NO_MATCH_QUERY,
  STORE_FINDER_API_BASE,
  autocompleteUrl,
  assertStorePage,
  cartFromEvents,
  cartFromHtml,
  cartMutationBody,
  cartUrl,
  coordinatesUrl,
  decodeEntities,
  extractArrayNamed,
  extractCartTotal,
  formatCart,
  formatProduct,
  hostOf,
  isLeclercHost,
  isRetryableStatus,
  mapProduct,
  nearbyUrl,
  num,
  parseEuro,
  productsFromHtml,
  round2,
  scanProductRecords,
  searchUrl as buildSearchUrl,
  smallestEnclosingObject,
  storePath,
  STORE_PAGE_MARKER as MARKER,
} from "../src/leclerc/api.ts";

export type { Cart, CartEvent, NearbyResponse, RawProduct } from "../src/leclerc/api.ts";