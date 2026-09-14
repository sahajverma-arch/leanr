import { describe, expect, it } from "vitest"

import { normalizeRecipeSeason, recipeSeasonMatches, seasonNarrowsRecipePool } from "./recipe-season-mapping"

describe("normalizeRecipeSeason", () => {
  it("maps the three real values the CSV actually carries", () => {
    expect(normalizeRecipeSeason("Winter")).toEqual({ season: "winter", unrecognized: false })
    expect(normalizeRecipeSeason("Summer")).toEqual({ season: "summer", unrecognized: false })
    expect(normalizeRecipeSeason("All Season")).toEqual({ season: "all_year", unrecognized: false })
  })

  it("falls back to all_year and flags anything else", () => {
    expect(normalizeRecipeSeason("Monsoon")).toEqual({ season: "all_year", unrecognized: true })
  })
})

describe("seasonNarrowsRecipePool", () => {
  it("is false for monsoon — no recipe in this dataset can carry that tag", () => {
    expect(seasonNarrowsRecipePool("monsoon")).toBe(false)
  })

  it("is true for the seasons the data can actually make a claim about", () => {
    expect(seasonNarrowsRecipePool("winter")).toBe(true)
    expect(seasonNarrowsRecipePool("summer")).toBe(true)
  })
})

describe("recipeSeasonMatches", () => {
  it("always accepts an all_year recipe", () => {
    expect(recipeSeasonMatches("all_year", "winter")).toBe(true)
    expect(recipeSeasonMatches("all_year", "summer")).toBe(true)
    expect(recipeSeasonMatches("all_year", "monsoon")).toBe(true)
  })

  it("narrows normally when the derived season is one the data expresses", () => {
    expect(recipeSeasonMatches("winter", "winter")).toBe(true)
    expect(recipeSeasonMatches("winter", "summer")).toBe(false)
    expect(recipeSeasonMatches("summer", "winter")).toBe(false)
  })

  it("does NOT narrow during monsoon — the regression this function exists for", () => {
    // season.ts calls July-October monsoon. No recipe row is ever tagged
    // monsoon, so the old `r.season === season` test could only ever match
    // all_year and hid 599 of 1015 eligible dishes on a real plan — including
    // Acuri Eggs and Acv Chicken Sandwich, both Winter, both otherwise fine.
    expect(recipeSeasonMatches("winter", "monsoon")).toBe(true)
    expect(recipeSeasonMatches("summer", "monsoon")).toBe(true)
  })
})
