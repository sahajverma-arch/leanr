import { describe, expect, it } from "vitest"

import { computeServingLimits } from "./recipe-quantity-normalize"
import type { RawRecipeRow } from "./recipe-csv-parser"

function makeRow(overrides: Partial<RawRecipeRow>): RawRecipeRow {
  return {
    recipeId: "id",
    name: "Test Recipe",
    dietPrefRaw: "VEGETARIAN",
    allergenRaw: "",
    seasonRaw: "All Season",
    category: "Sabzi",
    macroCategoryRaw: "",
    heavyLightRaw: "Light",
    cuisineRaw: "General",
    consistencyRaw: "Solid",
    commonalityRaw: "1",
    quantityPerServingRaw: "",
    maximumQuantityRaw: "",
    minQuantityRaw: "",
    mainOrMidRaw: "MAIN",
    mustHaveCategoryRaw: "",
    goodToHaveCategoryRaw: "",
    mustHaveRecipeRaw: "",
    goodToHaveRecipeRaw: "",
    isMeasuredInRaw: "",
    wtOfMeasuredAmtRaw: "",
    proteinPer100G: 5,
    carbsPer100G: 10,
    fatPer100G: 2,
    fiberPer100G: 1,
    priorityRaw: "Primary",
    ...overrides,
  }
}

describe("computeServingLimits", () => {
  it("computes min/max/ideal grams from a clean row (Roasted Chicken-shaped: 1 unit = 100-120g)", () => {
    const row = makeRow({ quantityPerServingRaw: "1", minQuantityRaw: "1", maximumQuantityRaw: "1.2", wtOfMeasuredAmtRaw: "100gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("computed")
    expect(limits.minGrams).toBe(100)
    expect(limits.maxGrams).toBe(120)
    expect(limits.idealGrams).toBe(100)
  })

  it("computes a cup-based recipe correctly (1.5 cups = 200g -> 133.3g/cup)", () => {
    const row = makeRow({ quantityPerServingRaw: "1.5 Cup", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "200gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("computed")
    expect(limits.minGrams).toBeCloseTo(133, 0)
    expect(limits.maxGrams).toBeCloseTo(267, 0)
  })

  it("uses the midpoint of a range in Quantity per serving", () => {
    const row = makeRow({ quantityPerServingRaw: "2-3 egg whites", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "50gm" })
    const limits = computeServingLimits(row)
    expect(limits.flags.some((f) => f.includes("Quantity per serving"))).toBe(true)
  })

  it("treats a Min/Max Quantity cell with a stray unit suffix as already-grams (the real Bel Fruit case)", () => {
    const row = makeRow({ minQuantityRaw: "100", maximumQuantityRaw: "150gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("computed")
    expect(limits.minGrams).toBe(100)
    expect(limits.maxGrams).toBe(150)
    expect(limits.flags.some((f) => f.includes("unit suffix"))).toBe(true)
  })

  it("falls back to the category default when Quantity per serving is unparseable ('-')", () => {
    const row = makeRow({ category: "Heavy Meal", quantityPerServingRaw: "-", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "300gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("fallback_category_default")
    expect(limits.minGrams).toBe(250)
    expect(limits.maxGrams).toBe(450)
  })

  it("falls back to the category default when Quantity per serving is blank", () => {
    const row = makeRow({ category: "Dessert", quantityPerServingRaw: "", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "50gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("fallback_category_default")
  })

  it("falls back when the computed range is implausible (e.g. exceeds 1000g)", () => {
    const row = makeRow({ category: "Snack", quantityPerServingRaw: "1", minQuantityRaw: "1", maximumQuantityRaw: "50", wtOfMeasuredAmtRaw: "100gm" })
    const limits = computeServingLimits(row)
    expect(limits.source).toBe("fallback_category_default")
  })

  it("swaps min/max if they arrive inverted", () => {
    const row = makeRow({ quantityPerServingRaw: "1", minQuantityRaw: "2", maximumQuantityRaw: "1", wtOfMeasuredAmtRaw: "100gm" })
    const limits = computeServingLimits(row)
    expect(limits.minGrams).toBeLessThanOrEqual(limits.maxGrams)
  })

  it("reads a katori-measured dish served as '3/4 cup' as one katori = the authored serving (Paneer Bhurji)", () => {
    const row = makeRow({ isMeasuredInRaw: "Katori", quantityPerServingRaw: "3/4 cup", minQuantityRaw: "1", maximumQuantityRaw: "1.5", wtOfMeasuredAmtRaw: "150gm" })
    const limits = computeServingLimits(row)
    expect(limits.minGrams).toBe(150)
    expect(limits.maxGrams).toBe(225)
    expect(limits.idealGrams).toBe(150)
  })

  it("reads a fraction properly when the serving names the measuring vessel", () => {
    const row = makeRow({ isMeasuredInRaw: "Cup", quantityPerServingRaw: "1/2 cup", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "100gm" })
    const limits = computeServingLimits(row)
    expect(limits.minGrams).toBe(200)
    expect(limits.maxGrams).toBe(400)
  })

  it("leaves count-measured rows on the original reading (a '1/2 fruit' mango is not 500-1000 g)", () => {
    const row = makeRow({ category: "Fruit", isMeasuredInRaw: "Numbers", quantityPerServingRaw: "1/2 fruit", minQuantityRaw: "1", maximumQuantityRaw: "2", wtOfMeasuredAmtRaw: "250gm" })
    const limits = computeServingLimits(row)
    expect(limits.minGrams).toBe(250)
    expect(limits.maxGrams).toBe(500)
  })

  it("keeps the typical portion inside its own range", () => {
    const row = makeRow({ isMeasuredInRaw: "Numbers", quantityPerServingRaw: "4 small idli", minQuantityRaw: "2", maximumQuantityRaw: "3", wtOfMeasuredAmtRaw: "135gm" })
    const limits = computeServingLimits(row)
    expect(limits.idealGrams).toBeLessThanOrEqual(limits.maxGrams)
    expect(limits.idealGrams).toBeGreaterThanOrEqual(limits.minGrams)
  })
})
