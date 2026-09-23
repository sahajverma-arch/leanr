import { describe, expect, it } from "vitest"

import { recipeDietViolations } from "./recipe-diet-gate"
import { makeRecipe } from "./test-fixtures"
import type { GroundedRecipeDay } from "./recipe-types"

function day(names: { name: string; allergenTags?: string[] }[]): GroundedRecipeDay {
  return {
    dayIndex: 0,
    meals: [
      {
        slot: "lunch",
        items: names.map((n) => ({ recipe: makeRecipe({ name: n.name, allergenTags: n.allergenTags ?? [] }), grams: 100 })),
      },
    ],
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
    cappedRecipeNames: [],
    unknownRecipeNames: [],
  }
}

describe("recipeDietViolations — the final write gate", () => {
  it("rejects a fish dish labelled vegetarian (the Dhruti bug)", () => {
    // makeRecipe's default label is every diet type — exactly the wrong CSV label.
    const v = recipeDietViolations([day([{ name: "Goan Fish Curry", allergenTags: ["fish", "seafood"] }])], "vegetarian")
    expect(v).toHaveLength(1)
    expect(v[0]).toContain("Goan Fish Curry")
  })

  it("rejects on the allergen tag alone when the name gives nothing away", () => {
    expect(recipeDietViolations([day([{ name: "Muri Ghonto", allergenTags: ["fish"] }])], "vegetarian")).toHaveLength(1)
  })

  it("passes a genuinely vegetarian day", () => {
    expect(recipeDietViolations([day([{ name: "Dal Tadka" }, { name: "Jeera Rice" }])], "vegetarian")).toEqual([])
  })

  it("lets a non-vegetarian client have the fish", () => {
    expect(recipeDietViolations([day([{ name: "Goan Fish Curry", allergenTags: ["fish"] }])], "non_vegetarian")).toEqual([])
  })
})
