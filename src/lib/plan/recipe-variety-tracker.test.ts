import { describe, expect, it } from "vitest"

import {
  findBackToBackRepeats,
  findDaysNeedingVarietyRetry,
  findVarietyViolations,
  isEverydayStaple,
  MAX_RECIPE_REPEATS_PER_WEEK,
  MAX_STAPLE_REPEATS_PER_WEEK,
  repeatCapFor,
  trackRecipeUsage,
} from "./recipe-variety-tracker"
import { makeRecipe } from "./test-fixtures"
import type { GroundedRecipeDay } from "./recipe-types"

function makeDays(recipeNamePerDay: string[]): GroundedRecipeDay[] {
  const recipesByName = new Map<string, ReturnType<typeof makeRecipe>>()
  return recipeNamePerDay.map((name, dayIndex) => {
    let recipe = recipesByName.get(name)
    if (!recipe) {
      recipe = makeRecipe({ id: name, name })
      recipesByName.set(name, recipe)
    }
    return {
      dayIndex,
      meals: [{ slot: "lunch", items: [{ recipe, grams: 100 }] }],
      totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      cappedRecipeNames: [],
      unknownRecipeNames: [],
    }
  })
}

describe("trackRecipeUsage / findVarietyViolations", () => {
  it("counts usage per recipe across the week", () => {
    const days = makeDays(["A", "B", "A", "C", "A", "B", "D"])
    const usage = trackRecipeUsage(days)
    expect(usage.get("A")).toBe(3)
    expect(usage.get("B")).toBe(2)
  })

  it("flags a recipe used more than MAX_RECIPE_REPEATS_PER_WEEK times", () => {
    const days = makeDays(["A", "A", "A", "B", "C", "D", "E"])
    const violations = findVarietyViolations(days)
    expect(violations).toHaveLength(1)
    expect(violations[0].name).toBe("A")
    expect(violations[0].count).toBe(3)
  })

  it("does not flag a recipe used exactly at the cap", () => {
    const days = makeDays(Array.from({ length: MAX_RECIPE_REPEATS_PER_WEEK }, () => "A").concat(["B", "C", "D", "E"]))
    expect(findVarietyViolations(days)).toEqual([])
  })
})

describe("findDaysNeedingVarietyRetry", () => {
  it("flags only the day(s) where a recipe's count first exceeds the cap, in day order", () => {
    const days = makeDays(["A", "A", "A", "B", "C", "D", "E"])
    const flagged = findDaysNeedingVarietyRetry(days)
    // 3rd occurrence of A is on dayIndex 2 — that's the one that pushed the count over the cap.
    expect(flagged.has(2)).toBe(true)
    expect(flagged.has(0)).toBe(false)
    expect(flagged.has(1)).toBe(false)
  })

  it("returns an empty set when nothing exceeds the cap", () => {
    const days = makeDays(["A", "B", "C", "D", "E", "F", "G"])
    expect(findDaysNeedingVarietyRetry(days).size).toBe(0)
  })
})

describe("per-recipe caps", () => {
  it("lets a plain roti, rice or side appear up to the staple cap, but not a dish", () => {
    const roti = makeRecipe({ id: "roti", name: "Roti", category: "Roti" })
    const curd = makeRecipe({ id: "curd", name: "Curd", category: "Raita", mainOrMid: "mid" })
    const paratha = makeRecipe({ id: "paratha", name: "Aloo Paratha", category: "Paratha" })
    expect(repeatCapFor(roti)).toBe(MAX_STAPLE_REPEATS_PER_WEEK)
    expect(repeatCapFor(curd)).toBe(MAX_STAPLE_REPEATS_PER_WEEK)
    expect(repeatCapFor(paratha)).toBe(MAX_RECIPE_REPEATS_PER_WEEK)
    expect(isEverydayStaple(makeRecipe({ category: "Rice" }))).toBe(true)
    expect(isEverydayStaple(makeRecipe({ category: "Pulao" }))).toBe(false)
  })

  it("flags a staple only once it passes its own higher cap", () => {
    const roti = makeRecipe({ id: "roti", name: "Roti", category: "Roti" })
    const week = (n: number): GroundedRecipeDay[] =>
      Array.from({ length: 7 }, (_, dayIndex) => ({
        dayIndex,
        meals: [{ slot: "lunch", items: dayIndex < n ? [{ recipe: roti, grams: 100 }] : [] }],
        totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
        cappedRecipeNames: [],
        unknownRecipeNames: [],
      }))
    expect(findVarietyViolations(week(MAX_STAPLE_REPEATS_PER_WEEK))).toEqual([])
    const over = findVarietyViolations(week(MAX_STAPLE_REPEATS_PER_WEEK + 1))
    expect(over).toHaveLength(1)
    expect(over[0].cap).toBe(MAX_STAPLE_REPEATS_PER_WEEK)
    expect(findDaysNeedingVarietyRetry(week(MAX_STAPLE_REPEATS_PER_WEEK + 1)).has(MAX_STAPLE_REPEATS_PER_WEEK)).toBe(true)
  })
})

describe("findBackToBackRepeats", () => {
  it("flags a dish on consecutive days, but not the same dish two days apart", () => {
    expect(findBackToBackRepeats(makeDays(["A", "A", "B", "C", "D", "E", "F"]))).toEqual([{ dayIndex: 1, name: "A" }])
    expect(findBackToBackRepeats(makeDays(["A", "B", "A", "C", "D", "E", "F"]))).toEqual([])
  })

  it("flags a dish served at both lunch and dinner on one day", () => {
    const rajma = makeRecipe({ id: "rajma", name: "Rajma Curry", category: "Curry" })
    const day: GroundedRecipeDay = {
      dayIndex: 0,
      meals: [
        { slot: "lunch", items: [{ recipe: rajma, grams: 150 }] },
        { slot: "dinner", items: [{ recipe: rajma, grams: 150 }] },
      ],
      totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      cappedRecipeNames: [],
      unknownRecipeNames: [],
    }
    expect(findBackToBackRepeats([day])).toEqual([{ dayIndex: 0, name: "Rajma Curry" }])
  })

  it("never flags a staple — roti every day is normal home food", () => {
    const roti = makeRecipe({ id: "roti", name: "Roti", category: "Roti" })
    const days: GroundedRecipeDay[] = [0, 1].map((dayIndex) => ({
      dayIndex,
      meals: [{ slot: "lunch", items: [{ recipe: roti, grams: 100 }] }],
      totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
      cappedRecipeNames: [],
      unknownRecipeNames: [],
    }))
    expect(findBackToBackRepeats(days)).toEqual([])
  })
})
