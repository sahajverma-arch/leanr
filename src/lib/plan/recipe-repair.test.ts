import { describe, expect, it } from "vitest"

import { balanceDayToTargets } from "./recipe-balancer"
import { buildRepairPool, enforceSingleSabzi, enforceVariety, repairDay, repairWeek, worstRelativeDeviation, REPAIR_TARGET_DEVIATION } from "./recipe-repair"
import type { ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { makeRecipe } from "./test-fixtures"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"
import { findBackToBackRepeats, findVarietyViolations, MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"

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

describe("enforceVariety", () => {
  // Identical macros, so a variety swap is always macro-neutral and the
  // tests are about which dish is chosen, not about the balancer.
  const macros = { proteinPer100G: 8, carbsPer100G: 14, fatPer100G: 3, minGrams: 100, maxGrams: 250, idealGrams: 150 }
  const rajma = makeRecipe({ id: "a-rajma", name: "Rajma Curry", category: "Curry", ...macros })
  const arhar = makeRecipe({ id: "b-arhar", name: "Arhar Dal", category: "Dal", ...macros })
  const moong = makeRecipe({ id: "c-moong", name: "Moong Dal", category: "Dal", ...macros })
  const porridge = makeRecipe({ id: "d-porridge", name: "Oats Porridge", category: "Khichdi", ...macros })
  const target: DailyRecipeTarget = { kcal: 297, proteinG: 12, carbsG: 21, fatG: 4.5, fiberG: 3 }
  const week = (recipes: ReturnType<typeof makeRecipe>[]) =>
    recipes.map((r, dayIndex) => ({ ...makeDay([pipeline(r)], target), dayIndex }))

  it("replaces a dish served on consecutive days with another dal or curry", () => {
    const pool = buildRepairPool([rajma, arhar, moong, porridge].map(pipeline))
    const result = enforceVariety(week([rajma, rajma, rajma]), target, pool, constraints)
    const names = result.days.map((d) => d.meals[0].items[0].recipe.name)
    expect(findBackToBackRepeats(result.days)).toEqual([])
    expect(names[0]).toBe("Rajma Curry")
    expect(names).not.toContain("Oats Porridge")
    expect(result.swaps.length).toBeGreaterThan(0)
  })

  it("brings a dish back under its weekly cap", () => {
    const masoor = makeRecipe({ id: "h-masoor", name: "Masoor Dal", category: "Dal", ...macros })
    const pool = buildRepairPool([rajma, arhar, moong, masoor].map(pipeline))
    const result = enforceVariety(week([rajma, arhar, rajma, moong, rajma, arhar, rajma]), target, pool, constraints)
    expect(findVarietyViolations(result.days)).toEqual([])
  })

  it("keeps the repeat when the only alternative would wreck the day's macros", () => {
    const fatty = makeRecipe({ id: "e-fatty", name: "Dal Makhani", category: "Dal", proteinPer100G: 2, carbsPer100G: 4, fatPer100G: 30, minGrams: 100, maxGrams: 110, idealGrams: 100 })
    const pool = buildRepairPool([rajma, fatty].map(pipeline))
    const result = enforceVariety(week([rajma, rajma]), target, pool, constraints)
    expect(result.swaps).toEqual([])
    expect(result.days[1].meals[0].items[0].recipe.name).toBe("Rajma Curry")
  })

  it("leaves plain staples alone within their higher cap", () => {
    const roti = makeRecipe({ id: "f-roti", name: "Roti", category: "Roti", ...macros })
    const missi = makeRecipe({ id: "g-missi", name: "Missi Roti", category: "Roti", ...macros })
    const pool = buildRepairPool([roti, missi].map(pipeline))
    const result = enforceVariety(week([roti, roti, roti, roti]), target, pool, constraints)
    expect(result.swaps).toEqual([])
  })
})

describe("enforceSingleSabzi", () => {
  const target: DailyRecipeTarget = { kcal: 1800, proteinG: 70, carbsG: 230, fatG: 60, fiberG: 25 }
  const roti = pipeline(makeRecipe({ name: "Roti", category: "Roti", carbsPer100G: 45, proteinPer100G: 9, fatPer100G: 3 }))
  const paneer = pipeline(makeRecipe({ name: "Paneer Bhurji", category: "High Protein Sabzi", proteinPer100G: 14, fatPer100G: 12 }))
  const bhindi = pipeline(makeRecipe({ name: "Bhindi Masala", category: "Sabzi" }))
  const dal = pipeline(makeRecipe({ name: "Arhar Dal", category: "Dal", proteinPer100G: 7 }))
  const porridge = pipeline(makeRecipe({ name: "Oats Porridge", category: "Dal Porridge" }))
  const sabziCount = (day: GroundedRecipeDay) =>
    day.meals[0].items.filter((i) => ["Sabzi", "High Protein Sabzi"].includes(i.recipe.category)).length

  it("drops the extra sabzi when the meal already has a dal", () => {
    const day = makeDay([roti, paneer, bhindi, dal], target, "lunch")
    const result = enforceSingleSabzi(day, target, buildRepairPool([roti, paneer, bhindi, dal]), new Map())
    expect(sabziCount(result.day)).toBe(1)
    expect(result.day.meals[0].items.some((i) => i.recipe.name === "Arhar Dal")).toBe(true)
    expect(result.swaps).toHaveLength(1)
  })

  it("turns the extra sabzi into a dal (never a porridge) when the meal has none", () => {
    const day = makeDay([roti, paneer, bhindi], target, "dinner")
    const result = enforceSingleSabzi(day, target, buildRepairPool([roti, paneer, bhindi, dal, porridge]), new Map())
    expect(sabziCount(result.day)).toBe(1)
    const names = result.day.meals[0].items.map((i) => i.recipe.name)
    expect(names).not.toContain("Oats Porridge")
    expect(names.includes("Arhar Dal") || result.swaps[0].to.startsWith("(removed")).toBe(true)
  })

  it("leaves breakfast and snacks alone", () => {
    const day = makeDay([paneer, bhindi], target, "evening")
    expect(enforceSingleSabzi(day, target, buildRepairPool([paneer, bhindi, dal]), new Map()).swaps).toEqual([])
  })
})
