/**
 * Versioned deterministic fixtures for the mock Leclerc environment (issue #42).
 *
 * Approximate but stable catalogue, stores and habitual-product lists used by
 * the in-memory mocks and the scenario suite (#44/#45). Prices are frozen per
 * fixture version: scenario expectations (packaging ceil rule, cart totals,
 * ambiguous P-1003/P-2001 match, excluded P-1007 cream, unavailable P-1009)
 * are all pinned to CATALOGUE_VERSION 1.
 */

import type { DriveStore, Product } from "@leclerc/contracts";

/** Bump when any fixture data changes; scenario assertions pin this value. */
export const CATALOGUE_VERSION = 1;

/**
 * The scenario catalogue, in fixture order (also the stable search ranking).
 * P-2001 sits next to P-1003 on purpose: "lait de coco" is ambiguous (A09).
 * P-1009 is unavailable on purpose (PRODUCT_UNAVAILABLE fault family).
 */
export const FIXTURE_PRODUCTS: readonly Product[] = [
  {
    id: "P-1001",
    label: "Filets de poulet 600 g",
    brand: "Marque Repère",
    price: 7.2,
    pricePerUnit: "12,00 €/kg",
    nutriScore: "A",
    available: true,
    packaging: "600 g",
  },
  {
    id: "P-1002",
    label: "Poudre de curry 100 g",
    price: 2.85,
    pricePerUnit: "28,50 €/kg",
    nutriScore: "B",
    available: true,
    packaging: "100 g",
  },
  {
    id: "P-1003",
    label: "Lait de coco 400 ml",
    price: 1.95,
    pricePerUnit: "4,88 €/L",
    nutriScore: "D",
    available: true,
    packaging: "400 ml",
  },
  {
    id: "P-2001",
    label: "Lait de coco 200 ml",
    price: 1.35,
    pricePerUnit: "6,75 €/L",
    nutriScore: "D",
    available: true,
    packaging: "200 ml",
  },
  {
    id: "P-1004",
    label: "Riz basmati 1 kg",
    price: 3.4,
    pricePerUnit: "3,40 €/kg",
    nutriScore: "A",
    available: true,
    packaging: "1 kg",
  },
  {
    id: "P-1005",
    label: "Oignons 1 kg",
    price: 1.6,
    pricePerUnit: "1,60 €/kg",
    nutriScore: "A",
    available: true,
    packaging: "1 kg",
  },
  {
    id: "P-1006",
    label: "Ail 200 g",
    price: 1.1,
    pricePerUnit: "5,50 €/kg",
    nutriScore: "A",
    available: true,
    packaging: "200 g",
  },
  {
    id: "P-1007",
    label: "Crème fraîche épaisse 30 cl",
    price: 1.79,
    pricePerUnit: "5,97 €/L",
    nutriScore: "D",
    available: true,
    packaging: "30 cl",
  },
  {
    id: "P-1008",
    label: "Gingembre frais 100 g",
    price: 1.2,
    pricePerUnit: "12,00 €/kg",
    nutriScore: "A",
    available: true,
    packaging: "100 g",
  },
  {
    id: "P-1009",
    label: "Mangue fraîche",
    price: 2.5,
    pricePerUnit: "2,50 €/pièce",
    nutriScore: "B",
    available: false,
    packaging: "1 pièce",
  },
];

/** The two scenario drives (find_stores matches name, city and postal code). */
export const FIXTURE_STORES: readonly DriveStore[] = [
  {
    id: "053701",
    name: "Leclerc Drive La Ville-aux-Dames",
    city: "Tours",
    postalCode: "37200",
  },
  {
    id: "066900",
    name: "Leclerc Drive Perpignan",
    city: "Perpignan",
    postalCode: "66000",
  },
];

/**
 * Habitual-product ids in stable order. P-1007 (crème fraîche) is
 * deliberately absent: scenario A02 asserts the exclusion is never violated.
 */
export const FIXTURE_HABITUAL_PRODUCT_IDS: readonly string[] = [
  "P-1004",
  "P-1005",
  "P-1006",
];
