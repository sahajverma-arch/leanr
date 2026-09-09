import { describe, expect, it } from "vitest"

import { filterRecipePool, isNutritionallyEmpty, type PoolFilterRecipe } from "./recipe-pool-filters"

function recipe(name: string, category: string, kcalPer100G: number, fatPer100G: number): PoolFilterRecipe {
  return { name, category, kcalPer100G, fatPer100G }
}

describe("isNutritionallyEmpty", () => {
  it("drops placeholder rows that are not dishes", () => {
    // Both real rows, both plated to a dietitian as "Any Veg (150 g)".
    expect(isNutritionallyEmpty(recipe("Any Veg", "Sabzi", 0, 0))).toBe(true)
    expect(isNutritionallyEmpty(recipe("Any Veg (W/O Aloo, Arbi, Paneer, Soy)", "Sabzi", 0, 0))).toBe(true)
  })

  it("drops food rows whose calories are simply wrong", () => {
    // Real ingested rows. Worse than placeholders: the balancer will serve
    // 250g of these and count zero macros against the day's target.
    expect(isNutritionallyEmpty(recipe("Watermelon", "Fruit", 0, 0))).toBe(true)
    expect(isNutritionallyEmpty(recipe("Moong Dal Idli", "Idli", 0, 0))).toBe(true)
    expect(isNutritionallyEmpty(recipe("Kandi Pachadi (Toor Dal Chutney)", "Chutney", 0, 0))).toBe(true)
  })

  it("KEEPS drinks that are legitimately zero-calorie", () => {
    expect(isNutritionallyEmpty(recipe("Lukewarm Water", "Morning Water", 0, 0))).toBe(false)
    expect(isNutritionallyEmpty(recipe("Apple Cider Vinegar", "Morning Water", 0, 0))).toBe(false)
    expect(isNutritionallyEmpty(recipe("Extreme Weight Loss Green Tea", "Tea", 0, 0))).toBe(false)
  })

  it("keeps any row that declares real energy", () => {
    expect(isNutritionallyEmpty(recipe("Roti", "Roti", 157, 0.8))).toBe(false)
  })
})

describe("filterRecipePool", () => {
  it("drops empty rows and keeps everything else", () => {
    const pool = [
      recipe("Any Veg", "Sabzi", 0, 0),
      recipe("Roti", "Roti", 157, 0.8),
      recipe("Lukewarm Water", "Morning Water", 0, 0),
    ]
    expect(filterRecipePool(pool).map((r) => r.name)).toEqual(["Roti", "Lukewarm Water"])
  })

  it("KEEPS calorie-dense recipes — the fat-share filter was measured and removed", () => {
    // Walnut is ~89% of calories from fat. A previous version dropped rows
    // like this, which made the fat target unreachable and convergence
    // strictly worse across three live runs. See the note in the source.
    const walnut = recipe("Walnut", "Nuts", 654, 65)
    expect(filterRecipePool([walnut])).toContain(walnut)
  })

  it("never empties a pool that has real food in it", () => {
    const pool = [recipe("Ghee", "Fat", 900, 100), recipe("Rice", "Rice", 130, 0.3)]
    expect(filterRecipePool(pool)).toHaveLength(2)
  })
})
