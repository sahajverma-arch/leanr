import { describe, expect, it } from "vitest"

import { balanceDayToTargets } from "./recipe-balancer"
import {
  describeMealBalanceProblems,
  effectiveProteinRichSlot,
  equalMainMealKcal,
  mealShapeScore,
  PROTEIN_RICH_SHARE,
} from "./recipe-meal-balance"
import { formatMealBalanceSection } from "./recipe-prompt"
import { makeRecipe } from "./test-fixtures"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"

function pipeline(recipe: ReturnType<typeof makeRecipe>): RecipeForPipeline {
  const { rawCsvRow: _auditOnly, ...rest } = recipe
  return rest
}

function day(meals: GroundedRecipeDay["meals"]): GroundedRecipeDay {
  return { dayIndex: 0, meals, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }, cappedRecipeNames: [], unknownRecipeNames: [] }
}

// 100 kcal per 100 g, 10 g protein per 100 g (Atwater: 10*4 + 15*4 + 0 = 100).
const plain = pipeline(makeRecipe({ name: "Plain", category: "Dal", proteinPer100G: 10, carbsPer100G: 15, fatPer100G: 0, minGrams: 50, idealGrams: 200, maxGrams: 1000 }))
const lean = pipeline(makeRecipe({ name: "Lean", category: "Sabzi", proteinPer100G: 2, carbsPer100G: 23, fatPer100G: 0, minGrams: 50, idealGrams: 200, maxGrams: 1000 }))
const snack = pipeline(makeRecipe({ name: "Snack", category: "Snack", proteinPer100G: 2, carbsPer100G: 23, fatPer100G: 0, minGrams: 50, idealGrams: 100, maxGrams: 100 }))

describe("equalMainMealKcal", () => {
  it("splits what the snacks leave evenly over the main meals", () => {
    expect(equalMainMealKcal(3, 1800, 300)).toBe(500)
  })
  it("is null with fewer than two main meals, or nothing left", () => {
    expect(equalMainMealKcal(1, 1800, 0)).toBeNull()
    expect(equalMainMealKcal(3, 300, 400)).toBeNull()
  })
})

describe("effectiveProteinRichSlot", () => {
  it("follows the food when lunch and dinner were swapped", () => {
    expect(effectiveProteinRichSlot("lunch", true)).toBe("dinner")
    expect(effectiveProteinRichSlot("dinner", true)).toBe("lunch")
    expect(effectiveProteinRichSlot("breakfast", true)).toBe("breakfast")
    expect(effectiveProteinRichSlot("lunch", false)).toBe("lunch")
  })
  it("ignores anything that is not a main meal", () => {
    expect(effectiveProteinRichSlot("evening", false)).toBeUndefined()
    expect(effectiveProteinRichSlot(null, true)).toBeUndefined()
  })
})

describe("describeMealBalanceProblems / mealShapeScore", () => {
  const even = day([
    { slot: "breakfast", items: [{ recipe: plain, grams: 500 }] },
    { slot: "evening", items: [{ recipe: snack, grams: 100 }] },
    { slot: "lunch", items: [{ recipe: plain, grams: 500 }] },
    { slot: "dinner", items: [{ recipe: plain, grams: 500 }] },
  ])

  it("is quiet when the three main meals are equal", () => {
    expect(describeMealBalanceProblems(even, 1600, 150)).toEqual([])
    expect(mealShapeScore(even, { kcal: 1600, proteinG: 150 })).toBeCloseTo(0)
  })

  it("reports a light breakfast", () => {
    const light = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 200 }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 650 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 650 }] },
    ])
    const problems = describeMealBalanceProblems(light, 1500, 150)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("not equal in calories")
    expect(mealShapeScore(light, { kcal: 1500, proteinG: 150 })).toBeGreaterThan(0.5)
  })

  it("reports a protein-rich meal that does not have the most protein", () => {
    const wrong = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 500 }] },
      { slot: "lunch", items: [{ recipe: lean, grams: 500 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 500 }] },
    ])
    const problems = describeMealBalanceProblems(wrong, 1500, 110, "lunch")
    expect(problems.some((p) => p.includes("lunch is the protein-rich meal"))).toBe(true)
    expect(mealShapeScore(wrong, { kcal: 1500, proteinG: 110, proteinRichSlot: "lunch" })).toBeGreaterThan(0)
  })
})

describe("recipe-balancer.ts meal terms", () => {
  const target: DailyRecipeTarget = { kcal: 1500, proteinG: 90, carbsG: 285, fatG: 0, fiberG: 0 }

  it("moves breakfast, lunch and dinner toward an equal share of calories", () => {
    const start = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 100 }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 900 }] },
      { slot: "dinner", items: [{ recipe: lean, grams: 500 }] },
    ])
    const balanced = balanceDayToTargets(start, target)
    expect(mealShapeScore(balanced, target)).toBeLessThan(mealShapeScore(start, target))
    expect(mealShapeScore(balanced, target)).toBeLessThan(0.15)
  })

  it("pushes protein toward the protein-rich meal", () => {
    const start = day([
      { slot: "breakfast", items: [{ recipe: lean, grams: 500 }] },
      { slot: "lunch", items: [{ recipe: lean, grams: 300 }, { recipe: plain, grams: 200 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 500 }] },
    ])
    const lunchProtein = (d: GroundedRecipeDay) =>
      d.meals[1].items.reduce((s, i) => s + (i.recipe.proteinPer100G * i.grams) / 100, 0)
    const without = balanceDayToTargets(start, target)
    const withRich = balanceDayToTargets(start, { ...target, proteinRichSlot: "lunch" })
    expect(lunchProtein(withRich)).toBeGreaterThan(lunchProtein(without))
  })

  it("holds a hand-locked quantity exactly, whatever the meal balance wants", () => {
    const start = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 100, gramsLocked: true }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 900 }] },
      { slot: "dinner", items: [{ recipe: lean, grams: 500 }] },
    ])
    expect(balanceDayToTargets(start, target).meals[0].items[0].grams).toBe(100)
  })
})

describe("formatMealBalanceSection", () => {
  const target: DailyRecipeTarget = { kcal: 1800, proteinG: 90, carbsG: 200, fatG: 60, fiberG: 30 }

  it("asks for equal main meals and names no protein-rich meal by default", () => {
    const text = formatMealBalanceSection(["breakfast", "mid_morning", "lunch", "evening", "dinner"], target)
    expect(text).toContain("roughly EQUAL in calories")
    expect(text).not.toContain("PROTEIN-RICH")
  })

  it("names the protein-rich meal and its share", () => {
    const text = formatMealBalanceSection(["breakfast", "lunch", "dinner"], { ...target, proteinRichSlot: "dinner" })
    expect(text).toContain("DINNER the PROTEIN-RICH meal")
    expect(text).toContain(`${Math.round(PROTEIN_RICH_SHARE * 100)}%`)
  })

  it("is empty when there is nothing to balance", () => {
    expect(formatMealBalanceSection(["mid_morning", "evening"], target)).toBe("")
  })
})
