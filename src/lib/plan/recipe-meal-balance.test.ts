import { describe, expect, it } from "vitest"

import { balanceDayToTargets } from "./recipe-balancer"
import {
  describeMealBalanceProblems,
  effectiveProteinRichSlot,
  MEAL_KCAL_SHARES,
  mealShapeScore,
  mealShapeWithinTolerance,
  PROTEIN_RICH_SHARE,
  slotKcalTargets,
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
const snack = pipeline(makeRecipe({ name: "Snack", category: "Snack", proteinPer100G: 2, carbsPer100G: 23, fatPer100G: 0, minGrams: 50, idealGrams: 100, maxGrams: 1000 }))
const drink = pipeline(makeRecipe({ name: "Jeera Water", category: "Morning Water", mainOrMid: "mid", proteinPer100G: 0, carbsPer100G: 5, fatPer100G: 0, minGrams: 200, idealGrams: 200, maxGrams: 200 }))

describe("slotKcalTargets", () => {
  it("gives each slot the dietitian's share of the day: breakfast 17.5%, lunch and dinner 27.5%, the rest to the snacks", () => {
    const slots = ["breakfast", "mid_morning", "lunch", "evening", "dinner"].map((slot) => ({ slot, kcal: 0 }))
    const targets = slotKcalTargets(slots, 2000)
    expect(targets.get("breakfast")).toBeCloseTo(350)
    expect(targets.get("lunch")).toBeCloseTo(550)
    expect(targets.get("dinner")).toBeCloseTo(550)
    expect(targets.get("mid_morning")).toBeCloseTo(275)
    expect(targets.get("evening")).toBeCloseTo(275)
    expect([...targets.values()].reduce((s, k) => s + k, 0)).toBeCloseTo(2000)
    expect(Object.values(MEAL_KCAL_SHARES).reduce((s, x) => s + x, 0)).toBeCloseTo(1)
  })

  it("renormalises over the slots a day actually has", () => {
    const three = slotKcalTargets(["breakfast", "lunch", "dinner"].map((slot) => ({ slot, kcal: 0 })), 1000)
    expect(three.get("breakfast")).toBeCloseTo((0.175 / 0.725) * 1000)
    expect(three.get("lunch")).toBeCloseTo((0.275 / 0.725) * 1000)
    expect([...three.values()].reduce((s, k) => s + k, 0)).toBeCloseTo(1000)
  })

  it("lets a wake-up or bedtime drink keep what it carries and splits the rest", () => {
    const targets = slotKcalTargets(
      [
        { slot: "wake_up", kcal: 100 },
        { slot: "breakfast", kcal: 0 },
        { slot: "lunch", kcal: 0 },
        { slot: "dinner", kcal: 0 },
      ],
      1100
    )
    expect(targets.has("wake_up")).toBe(false)
    expect([...targets.values()].reduce((s, k) => s + k, 0)).toBeCloseTo(1000)
  })

  it("is empty with fewer than two share slots, or nothing left for them", () => {
    expect(slotKcalTargets([{ slot: "breakfast", kcal: 0 }], 1800).size).toBe(0)
    expect(slotKcalTargets([{ slot: "wake_up", kcal: 500 }, { slot: "breakfast", kcal: 0 }, { slot: "lunch", kcal: 0 }], 400).size).toBe(0)
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
  // 2000 kcal day on the exact split: 350 / 275 / 550 / 275 / 550, at 100 kcal/100 g.
  const onSplit = day([
    { slot: "breakfast", items: [{ recipe: plain, grams: 350 }] },
    { slot: "mid_morning", items: [{ recipe: snack, grams: 275 }] },
    { slot: "lunch", items: [{ recipe: plain, grams: 550 }] },
    { slot: "evening", items: [{ recipe: snack, grams: 275 }] },
    { slot: "dinner", items: [{ recipe: plain, grams: 550 }] },
  ])

  it("is quiet when every slot carries its share", () => {
    expect(describeMealBalanceProblems(onSplit, 2000, 150)).toEqual([])
    expect(mealShapeScore(onSplit, { kcal: 2000, proteinG: 150 })).toBeCloseTo(0)
  })

  it("reports the equal three-way split the dietitian rejected: breakfast too big, snacks negligible", () => {
    const equal = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 600 }] },
      { slot: "mid_morning", items: [{ recipe: snack, grams: 100 }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 600 }] },
      { slot: "evening", items: [{ recipe: snack, grams: 100 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 600 }] },
    ])
    const problems = describeMealBalanceProblems(equal, 2000, 150)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("calorie split is off")
    expect(problems[0]).toContain("breakfast 30% of the day (aim ~18%)")
    expect(problems[0]).toContain("mid_morning 5% of the day (aim ~14%)")
    expect(problems[0]).not.toContain("lunch 30%")
    // Gaps in points of the day: breakfast 12.5, each snack 8.75, lunch and dinner 2.5 — summed.
    expect(mealShapeScore(equal, { kcal: 2000, proteinG: 150 })).toBeCloseTo(0.35)
    expect(mealShapeWithinTolerance(equal, { kcal: 2000, proteinG: 150 })).toBe(false)
  })

  it("tolerates a slot within ±2.5 points of the day", () => {
    const nearly = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 390 }] },
      { slot: "mid_morning", items: [{ recipe: snack, grams: 240 }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 550 }] },
      { slot: "evening", items: [{ recipe: snack, grams: 270 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 550 }] },
    ])
    expect(describeMealBalanceProblems(nearly, 2000, 150)).toEqual([])
    expect(mealShapeWithinTolerance(nearly, { kcal: 2000, proteinG: 150 })).toBe(true)
  })

  it("leaves a wake-up drink out of the split", () => {
    const withDrink = day([{ slot: "wake_up", items: [{ recipe: drink, grams: 200 }] }, ...onSplit.meals])
    // The drink adds 40 kcal the shares no longer cover, so the day target rises by it.
    expect(describeMealBalanceProblems(withDrink, 2040, 150)).toEqual([])
  })

  it("reports a protein-rich meal that does not have the most protein", () => {
    const wrong = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 350 }] },
      { slot: "lunch", items: [{ recipe: lean, grams: 550 }] },
      { slot: "dinner", items: [{ recipe: plain, grams: 550 }] },
    ])
    const problems = describeMealBalanceProblems(wrong, 1450, 110, "lunch")
    expect(problems.some((p) => p.includes("lunch is the protein-rich meal"))).toBe(true)
    expect(mealShapeScore(wrong, { kcal: 1450, proteinG: 110, proteinRichSlot: "lunch" })).toBeGreaterThan(0)
  })
})

describe("recipe-balancer.ts meal terms", () => {
  const target: DailyRecipeTarget = { kcal: 2000, proteinG: 120, carbsG: 380, fatG: 0, fiberG: 0 }

  it("moves every slot toward its own calorie share, snacks included", () => {
    const start = day([
      { slot: "breakfast", items: [{ recipe: plain, grams: 700 }] },
      { slot: "mid_morning", items: [{ recipe: snack, grams: 60 }] },
      { slot: "lunch", items: [{ recipe: plain, grams: 600 }] },
      { slot: "evening", items: [{ recipe: snack, grams: 60 }] },
      { slot: "dinner", items: [{ recipe: lean, grams: 600 }] },
    ])
    const balanced = balanceDayToTargets(start, target)
    expect(mealShapeScore(balanced, target)).toBeLessThan(mealShapeScore(start, target))
    expect(mealShapeWithinTolerance(balanced, target)).toBe(true)
    const kcal = (slot: string) => balanced.meals.find((m) => m.slot === slot)!.items.reduce((s, i) => s + (i.recipe.kcalPer100G * i.grams) / 100, 0)
    expect(kcal("breakfast")).toBeLessThan(kcal("lunch"))
    expect(kcal("mid_morning")).toBeGreaterThan(200)
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

  it("states the split for the day's own slots and names no protein-rich meal by default", () => {
    const text = formatMealBalanceSection(["breakfast", "mid_morning", "lunch", "evening", "dinner"], target)
    expect(text).toContain("breakfast ~18%")
    expect(text).toContain("lunch ~28%")
    expect(text).toContain("mid_morning ~14%")
    expect(text).toContain("REAL snacks")
    expect(text).not.toContain("EQUAL")
    expect(text).not.toContain("PROTEIN-RICH")
  })

  it("renormalises the split for a three-meal day", () => {
    const text = formatMealBalanceSection(["breakfast", "lunch", "dinner"], target)
    expect(text).toContain("breakfast ~24%")
    expect(text).toContain("dinner ~38%")
  })

  it("names the protein-rich meal and its share", () => {
    const text = formatMealBalanceSection(["breakfast", "lunch", "dinner"], { ...target, proteinRichSlot: "dinner" })
    expect(text).toContain("DINNER the PROTEIN-RICH meal")
    expect(text).toContain(`${Math.round(PROTEIN_RICH_SHARE * 100)}%`)
  })

  it("is empty when there is nothing to balance", () => {
    expect(formatMealBalanceSection(["mid_morning"], target)).toBe("")
    expect(formatMealBalanceSection(["wake_up", "bedtime"], target)).toBe("")
  })
})
