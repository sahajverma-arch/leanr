import { describe, expect, it } from "vitest"

import { balanceDayToTargets } from "./recipe-balancer"
import { buildRepairPool, repairDay, repairWeek, worstRelativeDeviation, REPAIR_TARGET_DEVIATION } from "./recipe-repair"
import type { ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { makeRecipe } from "./test-fixtures"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"
import { MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"

const constraints: ClientRecipeConstraints = {
  dietType: "vegetarian",
  eligibleCuisines: ["General"],
  allergenTags: [],
}

function pipeline(recipe: ReturnType<typeof makeRecipe>): RecipeForPipeline {
  const { rawCsvRow: _auditOnly, ...rest } = recipe
  return rest
}

/**
 * A day of `items` in one slot. `evening` is used by default because
 * recipe-plausibility-validate.ts imposes no staple/dal structure there —
 * these tests are about the macro search, and the structural rules have
 * their own suite.
 */
function makeDay(items: RecipeForPipeline[], target: DailyRecipeTarget, slot = "evening"): GroundedRecipeDay {
  const day: GroundedRecipeDay = {
    dayIndex: 0,
    meals: [{ slot, items: items.map((recipe) => ({ recipe, grams: recipe.idealGrams })) }],
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
    cappedRecipeNames: [],
    unknownRecipeNames: [],
  }
  return balanceDayToTargets(day, target)
}

describe("worstRelativeDeviation", () => {
  it("reports the single worst macro, not an average that hides it", () => {
    const totals = { kcal: 1000, proteinG: 50, carbsG: 100, fatG: 60, fiberG: 20 }
    const target: DailyRecipeTarget = { kcal: 1000, proteinG: 50, carbsG: 100, fatG: 30, fiberG: 20 }
    expect(worstRelativeDeviation(totals, target)).toBeCloseTo(1.0, 5)
  })

  it("ignores fiber, exactly as the tolerance gate does", () => {
    const totals = { kcal: 1000, proteinG: 50, carbsG: 100, fatG: 30, fiberG: 1 }
    const target: DailyRecipeTarget = { kcal: 1000, proteinG: 50, carbsG: 100, fatG: 30, fiberG: 40 }
    expect(worstRelativeDeviation(totals, target)).toBe(0)
  })
})

describe("repairDay", () => {
  it("replaces a dish whose macros cannot reach the target at ANY legal serving", () => {
    // A pure-carb dish pinned to a narrow serving range: no amount of it
    // delivers the protein this day needs. The lean alternative sits in the
    // same category bucket, so the swap is offered.
    const stodge = makeRecipe({ name: "Stodge", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 120, idealGrams: 110 })
    const lean = makeRecipe({ name: "Lean Sabzi", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }

    const day = makeDay([pipeline(stodge)], target)
    const before = worstRelativeDeviation(day.totals, target)
    expect(before).toBeGreaterThan(0.5)

    const pool = buildRepairPool([pipeline(stodge), pipeline(lean)])
    const result = repairDay(day, target, pool, constraints, new Map())

    expect(result.swaps).toEqual([{ dayIndex: 0, slot: "evening", from: "Stodge", to: "Lean Sabzi" }])
    expect(worstRelativeDeviation(result.day.totals, target)).toBeLessThan(before)
  })

  it("leaves a day alone once it is already comfortably inside tolerance", () => {
    const dal = makeRecipe({ name: "Dal", category: "Dal", proteinPer100G: 7, carbsPer100G: 17, fatPer100G: 1.5, minGrams: 50, maxGrams: 400, idealGrams: 200 })
    const other = makeRecipe({ name: "Other Dal", category: "Dal", proteinPer100G: 20, carbsPer100G: 2, fatPer100G: 9, minGrams: 50, maxGrams: 400, idealGrams: 200 })
    // Exactly reachable at 200 g of Dal.
    const target: DailyRecipeTarget = { kcal: 219, proteinG: 14, carbsG: 34, fatG: 3, fiberG: 4 }
    const day = makeDay([pipeline(dal)], target)
    expect(worstRelativeDeviation(day.totals, target)).toBeLessThanOrEqual(REPAIR_TARGET_DEVIATION)

    const pool = buildRepairPool([pipeline(dal), pipeline(other)])
    const result = repairDay(day, target, pool, constraints, new Map())
    expect(result.swaps).toEqual([])
    expect(result.day.meals[0].items[0].recipe.name).toBe("Dal")
  })

  it("never swaps across category buckets — a sabzi is only ever replaced by a sabzi", () => {
    const sabzi = makeRecipe({ name: "Sabzi", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 110, idealGrams: 105 })
    // A far better macro fit, but it is a Dal — structurally a different
    // course, so it must never be offered as a replacement for the sabzi.
    const dal = makeRecipe({ name: "Protein Dal", category: "Dal", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }

    const day = makeDay([pipeline(sabzi)], target)
    const pool = buildRepairPool([pipeline(sabzi), pipeline(dal)])
    const result = repairDay(day, target, pool, constraints, new Map())

    expect(result.swaps).toEqual([])
    expect(result.day.meals[0].items[0].recipe.name).toBe("Sabzi")
  })

  it("refuses a swap that would push a recipe past the weekly repeat cap", () => {
    const stodge = makeRecipe({ name: "Stodge", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 120, idealGrams: 110 })
    const lean = makeRecipe({ name: "Lean Sabzi", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }
    const day = makeDay([pipeline(stodge)], target)
    const pool = buildRepairPool([pipeline(stodge), pipeline(lean)])

    const spent = new Map([["Lean Sabzi", MAX_RECIPE_REPEATS_PER_WEEK]])
    const result = repairDay(day, target, pool, constraints, spent)

    expect(result.swaps).toEqual([])
  })

  it("never introduces a duplicate recipe inside one meal", () => {
    const poor = makeRecipe({ name: "Poor", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 110, idealGrams: 105 })
    const good = makeRecipe({ name: "Good", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }
    // "Good" is ALREADY in the meal, so replacing "Poor" with it would
    // duplicate it — a plausibility problem in its own right.
    const day = makeDay([pipeline(poor), pipeline(good)], target)
    const pool = buildRepairPool([pipeline(poor), pipeline(good)])

    const result = repairDay(day, target, pool, constraints, new Map())
    const names = result.day.meals[0].items.map((i) => i.recipe.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("leaves a day carrying a hand-locked quantity completely untouched", () => {
    const stodge = makeRecipe({ name: "Stodge", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 120, idealGrams: 110 })
    const lean = makeRecipe({ name: "Lean Sabzi", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }

    const day = makeDay([pipeline(stodge)], target)
    const locked: GroundedRecipeDay = {
      ...day,
      meals: day.meals.map((m) => ({ ...m, items: m.items.map((i) => ({ ...i, gramsLocked: true })) })),
    }
    const pool = buildRepairPool([pipeline(stodge), pipeline(lean)])
    const result = repairDay(locked, target, pool, constraints, new Map())

    expect(result.swaps).toEqual([])
    expect(result.day).toBe(locked)
  })

  it("is deterministic — the same input always yields the same repaired day", () => {
    const stodge = makeRecipe({ id: "r-stodge", name: "Stodge", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 120, idealGrams: 110 })
    // Two equally good alternatives: the tie must break the same way twice.
    const a = makeRecipe({ id: "r-aaa", name: "Alt A", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const b = makeRecipe({ id: "r-bbb", name: "Alt B", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }
    const recipes = [pipeline(stodge), pipeline(a), pipeline(b)]

    const first = repairDay(makeDay([pipeline(stodge)], target), target, buildRepairPool(recipes), constraints, new Map())
    const second = repairDay(makeDay([pipeline(stodge)], target), target, buildRepairPool(recipes), constraints, new Map())
    expect(first.swaps).toEqual(second.swaps)
  })
})

describe("repairWeek", () => {
  it("shares one weekly tally, so seven days cannot all spend the same rescue dish", () => {
    const stodge = makeRecipe({ name: "Stodge", category: "Sabzi", proteinPer100G: 1, carbsPer100G: 30, fatPer100G: 1, minGrams: 100, maxGrams: 120, idealGrams: 110 })
    const lean = makeRecipe({ name: "Lean Sabzi", category: "Sabzi", proteinPer100G: 18, carbsPer100G: 6, fatPer100G: 2, minGrams: 100, maxGrams: 250, idealGrams: 150 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }
    const pool = buildRepairPool([pipeline(stodge), pipeline(lean)])

    const days = Array.from({ length: 7 }, (_, dayIndex) => ({ ...makeDay([pipeline(stodge)], target), dayIndex }))
    const result = repairWeek(days, target, pool, constraints)

    const leanUse = result.days.flatMap((d) => d.meals.flatMap((m) => m.items)).filter((i) => i.recipe.name === "Lean Sabzi").length
    expect(leanUse).toBeLessThanOrEqual(MAX_RECIPE_REPEATS_PER_WEEK)
    expect(result.swaps.length).toBe(leanUse)
  })

  it("returns the week unchanged when nothing can be improved", () => {
    const only = makeRecipe({ name: "Only Dish", category: "Sabzi", minGrams: 100, maxGrams: 120, idealGrams: 110 })
    const target: DailyRecipeTarget = { kcal: 400, proteinG: 36, carbsG: 12, fatG: 4, fiberG: 5 }
    const pool = buildRepairPool([pipeline(only)])
    const days = [{ ...makeDay([pipeline(only)], target), dayIndex: 0 }]

    const result = repairWeek(days, target, pool, constraints)
    expect(result.swaps).toEqual([])
    expect(result.days[0].meals[0].items[0].recipe.name).toBe("Only Dish")
  })
})
