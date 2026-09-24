import { describe, expect, it } from "vitest"

import { balanceDayToTargets } from "./recipe-balancer"
import { recipeCategoryBucket } from "./recipe-category"
import { formatRegionalSection } from "./recipe-prompt"
import { buildRepairPool, REGIONAL_DEVIATION_CEILING, repairDay, repairWeek, worstRelativeDeviation } from "./recipe-repair"
import type { ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { makeRecipe } from "./test-fixtures"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"
import { MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"

const constraints: ClientRecipeConstraints = { dietType: "vegetarian", eligibleCuisines: ["Gujarati", "General"], allergenTags: [] }

function pipeline(recipe: ReturnType<typeof makeRecipe>): RecipeForPipeline {
  const { rawCsvRow: _auditOnly, ...rest } = recipe
  return rest
}

// Same macros, so a swap between them costs nothing — the test is about the
// regional rule, not the macro search.
const macros = { proteinPer100G: 8, carbsPer100G: 25, fatPer100G: 5, minGrams: 50, maxGrams: 300, idealGrams: 150 }
const chaat = pipeline(makeRecipe({ name: "Sprouts Chaat", category: "Chaat", cuisine: "General", ...macros }))
const dhokla = pipeline(makeRecipe({ name: "Dhokla", category: "Snack", cuisine: "Gujarati", ...macros }))
const khandvi = pipeline(makeRecipe({ name: "Khandvi", category: "Snack", cuisine: "Gujarati", ...macros }))

// Exactly what 150 g of any of the three supplies.
const target: DailyRecipeTarget = { kcal: 265.5, proteinG: 12, carbsG: 37.5, fatG: 7.5, fiberG: 3 }

function eveningDay(dayIndex: number, recipe: RecipeForPipeline): GroundedRecipeDay {
  return balanceDayToTargets(
    {
      dayIndex,
      meals: [{ slot: "evening", items: [{ recipe, grams: recipe.idealGrams }] }],
      totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      cappedRecipeNames: [],
      unknownRecipeNames: [],
    },
    target
  )
}

describe("regional pass — every day gets a dish from the client's own cuisine", () => {
  it("swaps a generic snack for a same-bucket Gujarati one when the day has none", () => {
    const pool = buildRepairPool([chaat, dhokla, khandvi], "Gujarati")
    const result = repairDay(eveningDay(0, chaat), target, pool, constraints, new Map([["Sprouts Chaat", 1]]))
    expect(result.swaps).toHaveLength(1)
    expect(result.swaps[0].from).toBe("Sprouts Chaat")
    expect(["Dhokla", "Khandvi"]).toContain(result.swaps[0].to)
  })

  it("leaves a day alone that already has a Gujarati dish", () => {
    const pool = buildRepairPool([chaat, dhokla, khandvi], "Gujarati")
    expect(repairDay(eveningDay(0, dhokla), target, pool, constraints, new Map([["Dhokla", 1]])).swaps).toEqual([])
  })

  it("does nothing for a General client", () => {
    const pool = buildRepairPool([chaat, dhokla, khandvi], "General")
    expect(repairDay(eveningDay(0, chaat), target, pool, constraints, new Map()).swaps).toEqual([])
  })

  it("refuses a swap that would push the day's macros past the ceiling", () => {
    // A Gujarati snack that is almost pure fat: no serving of it keeps this day on target.
    const fatty = pipeline(makeRecipe({ name: "Fried Farsan", category: "Snack", cuisine: "Gujarati", proteinPer100G: 1, carbsPer100G: 5, fatPer100G: 40, minGrams: 140, maxGrams: 160, idealGrams: 150 }))
    const pool = buildRepairPool([chaat, fatty], "Gujarati")
    const result = repairDay(eveningDay(0, chaat), target, pool, constraints, new Map())
    expect(result.swaps).toEqual([])
    expect(worstRelativeDeviation(result.day.totals, target)).toBeLessThanOrEqual(REGIONAL_DEVIATION_CEILING)
  })

  it("macro repair never swaps a Gujarati dish out for a generic one, even to fix macros", () => {
    // A Gujarati snack that misses protein badly, and a generic one that would fix it.
    const lowProtein = pipeline(makeRecipe({ name: "Plain Khakhra", category: "Snack", cuisine: "Gujarati", proteinPer100G: 2, carbsPer100G: 30, fatPer100G: 5, minGrams: 100, maxGrams: 200, idealGrams: 150 }))
    const highProtein = pipeline(makeRecipe({ name: "Soya Tikki", category: "Snack", cuisine: "General", ...macros }))
    const pool = buildRepairPool([lowProtein, highProtein], "Gujarati")
    const result = repairDay(eveningDay(0, lowProtein), target, pool, constraints, new Map())
    expect(result.swaps.map((s) => s.to)).not.toContain("Soya Tikki")
    expect(result.day.meals[0].items[0].recipe.name).toBe("Plain Khakhra")
  })

  it("spreads the week across the region's dishes and never breaches the repeat cap", () => {
    const pool = buildRepairPool([chaat, dhokla, khandvi], "Gujarati")
    const week = Array.from({ length: 7 }, (_, i) => eveningDay(i, chaat))
    const result = repairWeek(week, target, pool, constraints)
    const names = result.days.map((d) => d.meals[0].items[0].recipe.name)
    const count = (n: string) => names.filter((x) => x === n).length
    expect(count("Dhokla")).toBeLessThanOrEqual(MAX_RECIPE_REPEATS_PER_WEEK)
    expect(count("Khandvi")).toBeLessThanOrEqual(MAX_RECIPE_REPEATS_PER_WEEK)
    // Two Gujarati dishes, each capped at twice a week: 4 days get one.
    expect(count("Dhokla") + count("Khandvi")).toBe(2 * MAX_RECIPE_REPEATS_PER_WEEK)
  })
})

describe("thepla and tikki buckets", () => {
  it("treats a thepla as bread, so it can stand in for a chilla or roti", () => {
    expect(recipeCategoryBucket("Thepla", "Methi Thepla")).toBe("bread")
    expect(recipeCategoryBucket("Chila", "Besan Chilla")).toBe("bread")
  })
  it("treats a tikki as a snack", () => {
    expect(recipeCategoryBucket("Tikki", "Bajra Methi Tikki/Dhebra")).toBe("snack")
  })
})

describe("formatRegionalSection", () => {
  const forPrompt = (r: RecipeForPipeline) => ({ ...r, mainOrMid: r.mainOrMid as "main" | "mid" })
  it("names the client's own dishes and asks for one every day", () => {
    const section = formatRegionalSection("Gujarati", [chaat, dhokla, khandvi].map(forPrompt))
    expect(section).toContain("Dhokla, Khandvi")
    expect(section).not.toContain("Sprouts Chaat")
    expect(section).toContain("EVERY day must include at least one")
    expect(section).toContain("rotli")
  })
  it("still describes the regional pattern when the pool has no native dishes", () => {
    const section = formatRegionalSection("Punjabi", [chaat].map(forPrompt))
    expect(section).not.toContain("EVERY day")
    expect(section).toContain("Punjabi home lunch")
  })
  it("adds nothing for a General client", () => {
    expect(formatRegionalSection("General", [chaat].map(forPrompt))).toBe("")
  })
})
