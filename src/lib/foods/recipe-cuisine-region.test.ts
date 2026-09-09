import { describe, expect, it } from "vitest"

import { cuisineForTemplateRegion, templateRegionForCuisine, RECIPE_CUISINES } from "./recipe-cuisine-mapping"

describe("cuisineForTemplateRegion", () => {
  it("maps each region the UI can send back to its own cuisine", () => {
    expect(cuisineForTemplateRegion("north_indian")).toBe("North Indian")
    expect(cuisineForTemplateRegion("punjabi")).toBe("Punjabi")
    expect(cuisineForTemplateRegion("bengali")).toBe("Bengali")
    expect(cuisineForTemplateRegion("hyderabadi")).toBe("Hyderabadi")
  })

  it("round-trips every cuisine that has a region of its own", () => {
    for (const cuisine of RECIPE_CUISINES) {
      if (cuisine === "General") continue
      expect(cuisineForTemplateRegion(templateRegionForCuisine(cuisine))).toBe(cuisine)
    }
  })

  it("falls back to General rather than throwing, so a pool is never empty", () => {
    // "General" has no region of its own; anything unmapped must land here.
    expect(cuisineForTemplateRegion(templateRegionForCuisine("General"))).toBe("North Indian")
  })
})
