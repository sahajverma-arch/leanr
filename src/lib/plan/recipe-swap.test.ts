import { describe, expect, it } from "vitest"

import { deviationOf, rebalanceDay, toBalanceableDay, weeklyAverageOf, type StoredRecipeMeal } from "./recipe-swap"
import type { DailyRecipeTarget, RecipeForPipeline } from "./recipe-types"

const TARGET: DailyRecipeTarget = { kcal: 2000, proteinG: 100, carbsG: 250, fatG: 60, fiberG: 30 }

function recipe(name: string, per100: { p: number; c: number; f: number }, min = 50, max = 400): RecipeForPipeline {
  return {
    id: `id-${name}`, name, minGrams: min, maxGrams: max, idealGrams: (min + max) / 2,
    proteinPer100G: per100.p, carbsPer100G: per100.c, fatPer100G: per100.f, fiberPer100G: 2,
    kcalPer100G: per100.p * 4 + per100.c * 4 + per100.f * 9,
    dietTypes: ["vegetarian"], allergenTags: [], cuisine: "General", category: "Dal", season: "all_year",
  } as unknown as RecipeForPipeline
}

function meal(slot: string, items: { name: string; grams: number; snap: { p: number; c: number; f: number } }[]): StoredRecipeMeal {
  return {
    slot,
    items: items.map((i, n) => ({
      id: `${slot}-${n}`, grams: i.grams, recipe: recipe(i.name, i.snap),
      proteinPer100GSnapshot: i.snap.p, carbsPer100GSnapshot: i.snap.c,
      fatPer100GSnapshot: i.snap.f, fiberPer100GSnapshot: 2,
    })),
  }
}

describe("toBalanceableDay", () => {
  it("uses each item's SNAPSHOT macros, not the live recipe row", () => {
    // The live row says 99g protein; the snapshot says 10. A saved plan's
    // numbers must not change because the CSV was re-ingested since.
    const stored = meal("lunch", [{ name: "Dal", grams: 100, snap: { p: 10, c: 20, f: 5 } }])
    stored.items[0].recipe = recipe("Dal", { p: 99, c: 99, f: 99 })
    const day = toBalanceableDay(0, [stored])
    expect(day.meals[0].items[0].recipe.proteinPer100G).toBe(10)
  })

  it("recomputes kcal from the snapshot macros so the two can never disagree", () => {
    const day = toBalanceableDay(0, [meal("lunch", [{ name: "Dal", grams: 100, snap: { p: 10, c: 20, f: 5 } }])])
    expect(day.meals[0].items[0].recipe.kcalPer100G).toBe(10 * 4 + 20 * 4 + 5 * 9)
  })

  it("keeps the live serving range, which is a property of the dish and is not snapshotted", () => {
    const stored = meal("lunch", [{ name: "Dal", grams: 100, snap: { p: 10, c: 20, f: 5 } }])
    stored.items[0].recipe = recipe("Dal", { p: 99, c: 99, f: 99 }, 80, 250)
    const day = toBalanceableDay(0, [stored])
    expect(day.meals[0].items[0].recipe.minGrams).toBe(80)
    expect(day.meals[0].items[0].recipe.maxGrams).toBe(250)
  })
})

describe("rebalanceDay", () => {
  it("moves grams toward the target and never outside a recipe's serving range", () => {
    const meals = [
      meal("lunch", [{ name: "Rice", grams: 50, snap: { p: 3, c: 28, f: 0.4 } }]),
      meal("dinner", [{ name: "Paneer", grams: 50, snap: { p: 18, c: 3, f: 20 } }]),
    ]
    const day = rebalanceDay(0, meals, TARGET)
    for (const m of day.meals) {
      for (const item of m.items) {
        expect(item.grams).toBeGreaterThanOrEqual(item.recipe.minGrams)
        expect(item.grams).toBeLessThanOrEqual(item.recipe.maxGrams)
      }
    }
    // Closer to target than the deliberately-too-small starting grams.
    expect(day.totals.kcal).toBeGreaterThan(400)
  })

  it("preserves item identity — a swap changes the dish, the balancer only changes amounts", () => {
    const meals = [meal("lunch", [{ name: "Rice", grams: 100, snap: { p: 3, c: 28, f: 0.4 } }, { name: "Dal", grams: 100, snap: { p: 9, c: 20, f: 1 } }])]
    const day = rebalanceDay(0, meals, TARGET)
    expect(day.meals[0].items.map((i) => i.recipe.name)).toEqual(["Rice", "Dal"])
  })
})

describe("weeklyAverageOf", () => {
  it("averages the days rather than taking the first", () => {
    const avg = weeklyAverageOf([
      { kcal: 1000, proteinG: 50, carbsG: 100, fatG: 20, fiberG: 10 },
      { kcal: 3000, proteinG: 150, carbsG: 300, fatG: 60, fiberG: 30 },
    ])
    expect(avg.kcal).toBe(2000)
    expect(avg.proteinG).toBe(100)
  })

  it("does not divide by zero on an empty plan", () => {
    expect(weeklyAverageOf([]).kcal).toBe(0)
  })
})

describe("deviationOf", () => {
  it("is signed, so direction survives — over and under need opposite corrections", () => {
    const over = deviationOf({ kcal: 2200, proteinG: 100, carbsG: 250, fatG: 60, fiberG: 30 }, TARGET)
    const under = deviationOf({ kcal: 1800, proteinG: 100, carbsG: 250, fatG: 60, fiberG: 30 }, TARGET)
    expect(over.kcal).toBeCloseTo(0.1, 6)
    expect(under.kcal).toBeCloseTo(-0.1, 6)
  })

  it("is 0, not NaN, when a target is 0", () => {
    expect(deviationOf({ kcal: 5, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }, { ...TARGET, kcal: 0 }).kcal).toBe(0)
  })
})
