import { describe, expect, it } from "vitest";
import {
  buildRepairPrompt,
  GENERATED_RECIPE_UNITS,
  MAX_RECIPE_REPAIRS,
  parseRecipeText,
  validateRecipeObject,
  type GeneratedRecipe,
} from "../src/index.js";

const validRecipe: GeneratedRecipe = {
  schemaVersion: 1,
  title: "Poulet au curry sans crème",
  servings: 4,
  ingredients: [
    { name: "filets de poulet", quantity: 800, unit: "g" },
    { name: "poudre de curry", quantity: 2, unit: "cuillère à soupe" },
    { name: "lait de coco", quantity: 400, unit: "ml" },
  ],
  steps: [
    "Émincer les oignons et faire revenir le poulet.",
    "Ajouter le curry puis le lait de coco, laisser mijoter 20 minutes.",
  ],
};

const validJson = JSON.stringify({
  title: validRecipe.title,
  servings: 4,
  ingredients: validRecipe.ingredients,
  steps: validRecipe.steps,
});

describe("generated recipe contract v1", () => {
  it("accepts a valid recipe with only the allowed root fields", () => {
    const res = parseRecipeText(validJson);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.recipe.servings).toBe(4);
      expect(res.recipe.ingredients).toHaveLength(3);
      expect(res.recipe.steps).toHaveLength(2);
      expect(res.repairs).toBe(0);
    }
  });

  it("accepts the optional indicative durations and category", () => {
    const res = parseRecipeText(
      JSON.stringify({
        title: "Tarte",
        servings: 6,
        ingredients: [{ name: "pâte feuilletée", quantity: 1, unit: "pièce" }],
        steps: ["Étaler la pâte."],
        prepMinutes: 15,
        cookMinutes: 30,
        category: "dessert",
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.recipe.prepMinutes).toBe(15);
      expect(res.recipe.cookMinutes).toBe(30);
      expect(res.recipe.category).toBe("dessert");
    }
  });

  it("rejects Markdown-fenced JSON (strict parse, no fence stripping)", () => {
    const res = parseRecipeText("```json\n" + validJson + "\n```");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe("NOT_JSON");
    }
  });

  it("rejects JSON surrounded by prose", () => {
    const res = parseRecipeText("Voici la recette : " + validJson + " Bon appétit !");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "NOT_JSON")).toBe(true);
    }
  });

  it("rejects a non-object JSON payload", () => {
    const res = parseRecipeText("[1, 2, 3]");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe("NOT_OBJECT");
    }
  });

  it("rejects an empty title", () => {
    const res = parseRecipeText(
      JSON.stringify({ ...JSON.parse(validJson), title: "   " }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "EMPTY_TITLE")).toBe(true);
    }
  });

  it("rejects invalid servings (zero, negative, fractional)", () => {
    for (const servings of [0, -2, 2.5]) {
      const res = parseRecipeText(JSON.stringify({ ...JSON.parse(validJson), servings }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === "INVALID_SERVINGS")).toBe(true);
      }
    }
  });

  it("rejects empty ingredients", () => {
    const res = parseRecipeText(JSON.stringify({ ...JSON.parse(validJson), ingredients: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "EMPTY_INGREDIENTS")).toBe(true);
    }
  });

  it("rejects non-positive quantities", () => {
    const base = JSON.parse(validJson);
    base.ingredients[0].quantity = 0;
    base.ingredients[1].quantity = -3;
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const qtyIssues = res.issues.filter((i) => i.code === "INVALID_QUANTITY");
      expect(qtyIssues).toHaveLength(2);
    }
  });

  it("rejects units outside the controlled list", () => {
    const base = JSON.parse(validJson);
    base.ingredients[0].unit = "pincées";
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "UNKNOWN_UNIT")).toBe(true);
    }
  });

  it("normalizes accepted unit casing and whitespace", () => {
    const base = JSON.parse(validJson);
    base.ingredients[2].unit = " ML ";
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.recipe.ingredients[2]?.unit).toBe("ml");
    }
  });

  it("rejects empty or non-string steps", () => {
    const base = JSON.parse(validJson);
    base.steps = ["Étape une.", "  "];
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "EMPTY_STEPS" && i.path === "steps[1]")).toBe(true);
    }
  });

  it("rejects forbidden root fields (no additional-fields tolerance)", () => {
    const base = JSON.parse(validJson);
    base.sourceUrl = "https://example.invalid/recette";
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "FORBIDDEN_ROOT_FIELD")).toBe(true);
    }
  });

  it("rejects extra fields on an ingredient", () => {
    const base = JSON.parse(validJson);
    base.ingredients[0].note = "bio";
    const res = parseRecipeText(JSON.stringify(base));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === "FORBIDDEN_INGREDIENT_FIELD")).toBe(true);
    }
  });

  it("rejects any product identifier inside an ingredient", () => {
    for (const field of ["id", "product_id", "productId", "ean", "ref"]) {
      const base = JSON.parse(validJson);
      base.ingredients[0][field] = "P-123";
      const res = parseRecipeText(JSON.stringify(base));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === "INGREDIENT_REFERENCE")).toBe(true);
      }
    }
  });

  it("collects several issues at once rather than stopping at the first", () => {
    const res = parseRecipeText(
      JSON.stringify({ title: "", servings: 0, ingredients: [], steps: [] }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("builds a repair prompt listing the issues and the rules", () => {
    const res = parseRecipeText("```json\n{}\n```");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const prompt = buildRepairPrompt(res.raw, res.issues);
      expect(prompt).toContain("NOT_JSON");
      expect(prompt).toContain("Renvoie uniquement l'objet JSON corrigé");
      expect(prompt).toContain(GENERATED_RECIPE_UNITS.join(", "));
    }
  });

  it("allows at most one guided repair round", () => {
    expect(MAX_RECIPE_REPAIRS).toBe(1);
  });

  it("validateRecipeObject tracks the repair round count", () => {
    const res = validateRecipeObject(JSON.parse(validJson), validJson, 1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repairs).toBe(1);
    }
  });
});
