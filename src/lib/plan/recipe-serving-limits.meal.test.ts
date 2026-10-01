import { describe, expect, it } from "vitest"

import { getMealServingLimitsG, MIN_ROTIS_AS_ONLY_STAPLE } from "./recipe-serving-limits"
import { makeRecipe } from "./test-fixtures"

const roti = makeRecipe({ name: "Roti", category: "Roti", unitLabel: "piece", perUnitGrams: 40, minGrams: 40, idealGrams: 80, maxGrams: 120 })
const rice = makeRecipe({ name: "Jeera Rice", category: "Rice", minGrams: 200, idealGrams: 200, maxGrams: 400 })
const dal = makeRecipe({ name: "Arhar Dal", category: "Dal" })

describe("getMealServingLimitsG", () => {
  it("serves at least two rotis when roti is the lunch/dinner's only staple", () => {
    expect(getMealServingLimitsG(roti, "lunch", [roti, dal]).min).toBe(MIN_ROTIS_AS_ONLY_STAPLE * 40)
  })

  it("keeps the authored minimum when rice is also on the plate", () => {
    expect(getMealServingLimitsG(roti, "dinner", [roti, rice, dal]).min).toBe(40)
  })

  it("does not touch breakfast or snacks", () => {
    expect(getMealServingLimitsG(roti, "breakfast", [roti]).min).toBe(40)
  })

  it("never raises the minimum past the dish's own maximum", () => {
    const small = makeRecipe({ category: "Roti", unitLabel: "piece", perUnitGrams: 50, minGrams: 50, idealGrams: 50, maxGrams: 75 })
    expect(getMealServingLimitsG(small, "lunch", [small, dal]).min).toBe(75)
  })

  it("leaves a sandwich or non-piece bread alone", () => {
    const wrap = makeRecipe({ category: "Wrap", unitLabel: null, perUnitGrams: null, minGrams: 30 })
    expect(getMealServingLimitsG(wrap, "lunch", [wrap, dal]).min).toBe(30)
  })
})
