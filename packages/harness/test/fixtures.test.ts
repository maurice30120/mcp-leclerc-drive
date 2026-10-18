import { describe, expect, it } from "vitest";
import {
  CATALOGUE_VERSION,
  FIXTURE_HABITUAL_PRODUCT_IDS,
  FIXTURE_PRODUCTS,
  FIXTURE_STORES,
} from "../src/index.js";
import type { Product } from "@leclerc/contracts";

describe("versioned harness fixtures (issue #42)", () => {
  it("versions the catalogue so scenario expectations can be pinned to it", () => {
    expect(typeof CATALOGUE_VERSION).toBe("number");
    expect(CATALOGUE_VERSION).toBe(1);
  });

  it("exposes the ten scenario products verbatim, prices stable per fixture", () => {
    expect(FIXTURE_PRODUCTS.map((p) => p.id)).toEqual([
      "P-1001",
      "P-1002",
      "P-1003",
      "P-2001",
      "P-1004",
      "P-1005",
      "P-1006",
      "P-1007",
      "P-1008",
      "P-1009",
    ]);
    const byId = new Map(FIXTURE_PRODUCTS.map((p) => [p.id, p]));
    const expected: Record<string, [string, number, string | undefined, boolean]> = {
      "P-1001": ["Filets de poulet 600 g", 7.2, "600 g", true],
      "P-1002": ["Poudre de curry 100 g", 2.85, "100 g", true],
      "P-1003": ["Lait de coco 400 ml", 1.95, "400 ml", true],
      "P-2001": ["Lait de coco 200 ml", 1.35, "200 ml", true],
      "P-1004": ["Riz basmati 1 kg", 3.4, "1 kg", true],
      "P-1005": ["Oignons 1 kg", 1.6, "1 kg", true],
      "P-1006": ["Ail 200 g", 1.1, "200 g", true],
      "P-1007": ["Crème fraîche épaisse 30 cl", 1.79, "30 cl", true],
      "P-1008": ["Gingembre frais 100 g", 1.2, "100 g", true],
      "P-1009": ["Mangue fraîche", 2.5, "1 pièce", false],
    };
    for (const [id, [label, price, packaging, available]] of Object.entries(expected)) {
      const p = byId.get(id);
      expect(p, id).toBeDefined();
      if (!p) continue;
      expect(p.label, id).toBe(label);
      expect(p.price, id).toBe(price);
      expect(p.packaging ?? undefined, id).toBe(packaging);
      expect(p.available, id).toBe(available);
    }
  });

  it("gives every product a plausible Nutri-Score letter and unique ids", () => {
    for (const p of FIXTURE_PRODUCTS as readonly Product[]) {
      expect(p.nutriScore).toMatch(/^[A-E]$/);
    }
    expect(new Set(FIXTURE_PRODUCTS.map((p) => p.id)).size).toBe(FIXTURE_PRODUCTS.length);
  });

  it("exposes the two scenario drives", () => {
    expect(FIXTURE_STORES.map((s) => s.id)).toEqual(["053701", "066900"]);
    const tours = FIXTURE_STORES[0];
    expect(tours.name).toBe("Leclerc Drive La Ville-aux-Dames");
    expect(tours.city).toBe("Tours");
    expect(tours.postalCode).toBe("37200");
    const perpignan = FIXTURE_STORES[1];
    expect(perpignan.name).toBe("Leclerc Drive Perpignan");
    expect(perpignan.city).toBe("Perpignan");
    expect(perpignan.postalCode).toBe("66000");
  });

  it("lists exactly the three habitual products, never the excluded cream", () => {
    expect(FIXTURE_HABITUAL_PRODUCT_IDS).toEqual(["P-1004", "P-1005", "P-1006"]);
    expect(FIXTURE_HABITUAL_PRODUCT_IDS).not.toContain("P-1007");
  });
});
