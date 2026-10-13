import { describe, expect, it } from "vitest"

import { deriveRecipeUnit } from "./recipe-unit-label"
import type { RawRecipeRow } from "./recipe-csv-parser"

function makeRow(overrides: Partial<RawRecipeRow>): RawRecipeRow {
  return {
    recipeId: "id",
    name: "Test",
    dietPrefRaw: "VEGETARIAN",
    allergenRaw: "",
    seasonRaw: "All Season",
    category: "Bread",
    macroCategoryRaw: "",
    heavyLightRaw: "Light",
    cuisineRaw: "General",
    consistencyRaw: "Solid",
    commonalityRaw: "1",
    quantityPerServingRaw: "",
    maximumQuantityRaw: "1",
    minQuantityRaw: "1",
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

describe("deriveRecipeUnit", () => {
  it("derives a discrete piece unit for a Numbers-measured item (Roti: 2 roti = 80gm)", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "2 roti", isMeasuredInRaw: "Numbers", wtOfMeasuredAmtRaw: "80gm" }))
    expect(unit).toEqual({ unitLabel: "piece", perUnitGrams: 40 })
  })

  it("derives a vessel unit, using the LAST word not the first (adjective-then-noun)", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "1 medium bowl (200 ml)", isMeasuredInRaw: "Medium Bowl", wtOfMeasuredAmtRaw: "200ml" }))
    expect(unit).toEqual({ unitLabel: "bowl", perUnitGrams: 200 })
  })

  it("derives 'glass' from 'small shot glass', not 'small'", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "1 small shot glass", isMeasuredInRaw: "glass", wtOfMeasuredAmtRaw: "150gm" }))
    expect(unit).toEqual({ unitLabel: "glass", perUnitGrams: 150 })
  })

  it("derives 'potato' from '3 baby potato', not 'baby'", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "3 baby potato", isMeasuredInRaw: "Medium Bowl", wtOfMeasuredAmtRaw: "150gm" }))
    expect(unit).toEqual({ unitLabel: "potato", perUnitGrams: 50 })
  })

  it("falls back to Is Measured In? when Quantity per serving has no noun (bare '1')", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "1", isMeasuredInRaw: "bowl", wtOfMeasuredAmtRaw: "150gm" }))
    expect(unit).toEqual({ unitLabel: "bowl", perUnitGrams: 150 })
  })

  it("returns null when the item is explicitly gram-measured (real weight-based portion)", () => {
    expect(deriveRecipeUnit(makeRow({ quantityPerServingRaw: "100 gm cooked Chicken", isMeasuredInRaw: "Grams", wtOfMeasuredAmtRaw: "100gm" }))).toBeNull()
  })

  it("counts pieces for a Numbers-measured bare count with no noun (Mooli Paratha: '1', 65gm)", () => {
    expect(deriveRecipeUnit(makeRow({ quantityPerServingRaw: "2", isMeasuredInRaw: "Numbers", wtOfMeasuredAmtRaw: "30gm" }))).toEqual({ unitLabel: "piece", perUnitGrams: 15 })
  })

  it("reads a Numbers-measured serving that is only the noun as one piece (Singhare Ki Roti: 'roti', 85gm)", () => {
    expect(deriveRecipeUnit(makeRow({ quantityPerServingRaw: "roti", isMeasuredInRaw: "Numbers", wtOfMeasuredAmtRaw: "85gm" }))).toEqual({ unitLabel: "piece", perUnitGrams: 85 })
  })

  it("still returns null for a bare count measured in a non-vessel, non-piece unit", () => {
    expect(deriveRecipeUnit(makeRow({ quantityPerServingRaw: "2", isMeasuredInRaw: "", wtOfMeasuredAmtRaw: "30gm" }))).toBeNull()
  })

  it("returns null for an unparseable quantity ('-')", () => {
    expect(deriveRecipeUnit(makeRow({ quantityPerServingRaw: "-", isMeasuredInRaw: "Katori", wtOfMeasuredAmtRaw: "150gm" }))).toBeNull()
  })

  it("handles a range in the leading count (uses the first number)", () => {
    const unit = deriveRecipeUnit(makeRow({ quantityPerServingRaw: "7-10 almonds", isMeasuredInRaw: "Numbers", wtOfMeasuredAmtRaw: "8gm" }))
    expect(unit).toEqual({ unitLabel: "piece", perUnitGrams: 8 / 7 })
  })
})
