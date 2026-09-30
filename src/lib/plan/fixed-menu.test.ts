import { describe, expect, it } from "vitest"

import { compileAvoidTerms } from "@/lib/foods/recipe-food-avoidance"

import {
  buildFixedMenuDay,
  FixedMenuError,
  fixedMenuItemsSchema,
  fixedMenuProblems,
  fixedMenuRecipeRefusal,
  fixedMenuRefusals,
  fixedMenuWarnings,
  repeatFixedMenuDay,
  type FixedMenuItem,
} from "./fixed-menu"
import type { DailyRecipeTarget, MealSlotInfo, RecipeForPipeline } from "./recipe-types"

let nextId = 0
function recipe(partial: Partial<RecipeForPipeline> & { name: string }): RecipeForPipeline {
  const protein = partial.proteinPer100G ?? 8
  const carbs = partial.carbsPer100G ?? 30
  const fat = partial.fatPer100G ?? 4
  return {
    id: partial.id ?? `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    name: partial.name,
    category: partial.category ?? "Roti",
    dietTypes: partial.dietTypes ?? ["vegetarian", "eggetarian", "non_vegetarian"],
    cuisine: partial.cuisine ?? "General",
    consistency: "solid",
    mainOrMid: partial.mainOrMid ?? "main",
    allergenTags: partial.allergenTags ?? [],
    mustHaveCategories: [],
    mustHaveRecipeNames: [],
    goodToHaveCategories: [],
    goodToHaveRecipeNames: [],
    isActive: partial.isActive ?? true,
    proteinPer100G: protein,
    carbsPer100G: carbs,
    fatPer100G: fat,
    fiberPer100G: 3,
    kcalPer100G: partial.kcalPer100G ?? protein * 4 + carbs * 4 + fat * 9,
    minGrams: partial.minGrams ?? 50,
    maxGrams: partial.maxGrams ?? 400,
    idealGrams: partial.idealGrams ?? 150,
  } as unknown as RecipeForPipeline
}

const TARGET: DailyRecipeTarget = { kcal: 1500, proteinG: 70, carbsG: 190, fatG: 50, fiberG: 30 }
const SLOTS: MealSlotInfo[] = [
  { slot: "breakfast", slotOrder: 1, timeHint: null },
  { slot: "mid_morning", slotOrder: 2, timeHint: null },
  { slot: "lunch", slotOrder: 3, timeHint: null },
  { slot: "evening", slotOrder: 4, timeHint: null },
  { slot: "dinner", slotOrder: 5, timeHint: null },
]

const poha = recipe({ name: "Poha", category: "Poha" })
const roti = recipe({ name: "Roti", category: "Roti", proteinPer100G: 10, carbsPer100G: 45, fatPer100G: 3 })
const dal = recipe({ name: "Dal Tadka", category: "Dal", proteinPer100G: 9, carbsPer100G: 15, fatPer100G: 5 })
const paneer = recipe({ name: "Paneer Bhurji", category: "Curry", proteinPer100G: 15, carbsPer100G: 5, fatPer100G: 15 })
const byId = new Map([poha, roti, dal, paneer].map((r) => [r.id, r]))

const menu: FixedMenuItem[] = [
  { slot: "breakfast", recipeId: poha.id, grams: null },
  { slot: "lunch", recipeId: roti.id, grams: 120 },
  { slot: "lunch", recipeId: dal.id, grams: null },
  { slot: "dinner", recipeId: roti.id, grams: null },
  { slot: "dinner", recipeId: paneer.id, grams: null },
]

describe("fixedMenuProblems", () => {
  it("accepts breakfast, lunch and dinner with the snack meals left out", () => {
    expect(fixedMenuProblems(menu)).toEqual([])
  })

  it("requires breakfast, lunch and dinner", () => {
    expect(fixedMenuProblems(menu.filter((i) => i.slot !== "lunch"))).toEqual(["Lunch needs at least one dish."])
  })

  it("refuses the same dish twice in one meal, but allows it in two meals", () => {
    expect(fixedMenuProblems([...menu, { slot: "lunch", recipeId: dal.id, grams: null }])).toEqual(["Lunch has the same dish twice."])
  })

  it("rejects an impossible quantity at the boundary", () => {
    expect(fixedMenuItemsSchema.safeParse([{ slot: "lunch", recipeId: roti.id, grams: 2 }]).success).toBe(false)
    expect(fixedMenuItemsSchema.safeParse([{ slot: "lunch", recipeId: roti.id, grams: 120 }]).success).toBe(true)
  })
})

describe("buildFixedMenuDay", () => {
  const day = buildFixedMenuDay(menu, byId, SLOTS, TARGET)

  it("keeps exactly the dishes the dietitian chose, in meal order, with empty meals left out", () => {
    expect(day.meals.map((m) => [m.slot, m.items.map((i) => i.recipe.name)])).toEqual([
      ["breakfast", ["Poha"]],
      ["lunch", ["Roti", "Dal Tadka"]],
      ["dinner", ["Roti", "Paneer Bhurji"]],
    ])
  })

  it("holds a typed quantity exactly and lets the balancer set the rest", () => {
    const lunchRoti = day.meals.find((m) => m.slot === "lunch")!.items[0]
    expect(lunchRoti.grams).toBe(120)
    expect(lunchRoti.gramsLocked).toBe(true)
    const dinnerRoti = day.meals.find((m) => m.slot === "dinner")!.items[0]
    expect(dinnerRoti.gramsLocked).toBeUndefined()
    for (const item of day.meals.flatMap((m) => m.items).filter((i) => !i.gramsLocked)) {
      expect(item.grams).toBeGreaterThanOrEqual(item.recipe.minGrams)
      expect(item.grams).toBeLessThanOrEqual(item.recipe.maxGrams)
    }
  })

  it("moves toward the target rather than leaving every dish at its typical portion", () => {
    const naive = buildFixedMenuDay(menu, byId, SLOTS, { ...TARGET, kcal: 1, proteinG: 1, carbsG: 1, fatG: 1 })
    expect(Math.abs(day.totals.kcal - TARGET.kcal)).toBeLessThan(Math.abs(naive.totals.kcal - TARGET.kcal))
  })

  it("refuses a menu whose meal is not one of this client's meals", () => {
    const fourMeals = SLOTS.filter((s) => s.slot !== "mid_morning")
    expect(() => buildFixedMenuDay([...menu, { slot: "mid_morning", recipeId: poha.id, grams: null }], byId, fourMeals, TARGET)).toThrow(FixedMenuError)
  })

  it("refuses an incomplete menu instead of building a partial day", () => {
    expect(() => buildFixedMenuDay(menu.filter((i) => i.slot !== "dinner"), byId, SLOTS, TARGET)).toThrow(/Dinner needs/)
  })
})

describe("repeatFixedMenuDay", () => {
  it("gives 7 identical days that do not share objects", () => {
    const days = repeatFixedMenuDay(buildFixedMenuDay(menu, byId, SLOTS, TARGET))
    expect(days.map((d) => d.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(new Set(days.map((d) => JSON.stringify({ ...d, dayIndex: 0 }))).size).toBe(1)
    days[0].meals[0].items[0].grams = 999
    expect(days[1].meals[0].items[0].grams).not.toBe(999)
  })
})

describe("fixedMenuRecipeRefusal — the same hard rules as every other recipe path", () => {
  const vegetarian = { dietType: "vegetarian", allergenTags: [] as string[], avoidTerms: compileAvoidTerms([]) }

  it("refuses a dish the client's diet forbids, by its name even when mislabelled", () => {
    expect(fixedMenuRecipeRefusal(recipe({ name: "Fish Curry", dietTypes: ["vegetarian"] }), vegetarian)).toMatch(/not suitable/)
  })

  it("refuses a dish the client dislikes or is allergic to", () => {
    const client = { ...vegetarian, avoidTerms: compileAvoidTerms(["Soya chunks"]) }
    expect(fixedMenuRecipeRefusal(recipe({ name: "Soya Matar Sabzi Dry" }), client)).toMatch(/avoids/)
    expect(fixedMenuRecipeRefusal(recipe({ name: "Til Ladoo" }), { ...vegetarian, allergenTags: ["sesame"] })).toMatch(/allergen/)
  })

  it("does NOT refuse a dish for its cuisine — the dietitian is choosing by hand", () => {
    expect(fixedMenuRecipeRefusal(recipe({ name: "Kande Pohe", cuisine: "Maharashtrian" }), vegetarian)).toBeNull()
  })

  it("names every refused dish with its meal, including one that no longer exists", () => {
    const refusals = fixedMenuRefusals(
      [...menu, { slot: "evening", recipeId: "00000000-0000-4000-8000-999999999999", grams: null }],
      byId,
      { ...vegetarian, avoidTerms: compileAvoidTerms(["paneer"]) }
    )
    expect(refusals).toEqual([
      "Dinner: Paneer Bhurji matches \"paneer\", which this client avoids.",
      "Evening: A dish on the fixed menu (Evening) no longer exists.",
    ])
  })
})

describe("fixedMenuWarnings", () => {
  const constraints = { dietType: "vegetarian", eligibleCuisines: ["General"], allergenTags: [] }

  it("says nothing when the day is on target and sound", () => {
    const day = buildFixedMenuDay(menu, byId, SLOTS, TARGET)
    const onTarget = { ...TARGET, kcal: day.totals.kcal, proteinG: day.totals.proteinG, carbsG: day.totals.carbsG, fatG: day.totals.fatG }
    expect(fixedMenuWarnings(day, onTarget, constraints)).toEqual([])
  })

  it("warns once, not seven times, and never about repeating dishes", () => {
    const day = buildFixedMenuDay(menu, byId, SLOTS, TARGET)
    const warnings = fixedMenuWarnings(day, { ...TARGET, proteinG: 200 }, constraints)
    expect(warnings[0]).toMatch(/NEEDS DIETITIAN REVIEW/)
    expect(warnings.some((w) => /Every day: protein is \d+% under/.test(w))).toBe(true)
    expect(warnings.some((w) => /Repeated|consecutive/.test(w))).toBe(false)
  })
})
