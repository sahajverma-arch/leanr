import { describe, expect, it } from "vitest"

import {
  gramsForQuantity,
  IngredientEditError,
  macrosForGrams,
  per100GOfPortion,
  setIngredientQuantity,
  sumIngredientMacros,
  toPortion,
  type PortionIngredient,
} from "./ingredient-edit"

/**
 * Real batch rows for "Egg Bhurji", taken from the Calculation column of
 * src/db/seed-data/recipe_ingredients.csv. Servings 1.5, one katori = 150 g.
 *
 * french beans is deliberately EXCLUDED here even though the real row carries
 * it: at 350 kcal/100g it is holding dried-rajma nutrition for a fresh
 * vegetable, which is exactly why the real Egg Bhurji is quarantined out of
 * this layer at seed time. Including it in a fixture would bake a known-bad
 * number into a golden test.
 */
function eggBhurjiBatch(): PortionIngredient[] {
  return [
    {
      name: "egg",
      kind: "piece",
      quantity: 2,
      unit: "piece",
      gramsPerUnit: 50,
      grams: 100,
      per100G: { carbsG: 0.7, proteinG: 12.6, fatG: 9.5, fiberG: 0, kcal: 138.7 },
    },
    {
      name: "ghee",
      kind: "measure",
      quantity: 1,
      unit: "tsp",
      gramsPerUnit: 5,
      grams: 5,
      per100G: { carbsG: 0, proteinG: 0, fatG: 100, fiberG: 0, kcal: 900 },
    },
    {
      name: "onion",
      kind: "piece",
      quantity: 0.5,
      unit: "piece",
      gramsPerUnit: 150,
      grams: 75,
      per100G: { carbsG: 6.5, proteinG: 1.1, fatG: 0.1, fiberG: 2.45, kcal: 31.3 },
    },
  ]
}

/** Real "Palak Dal Khichdi" batch - Servings 1, one katori = 200 g. */
function khichdiBatch(): PortionIngredient[] {
  return [
    {
      name: "moong dal",
      kind: "direct",
      quantity: 40,
      unit: null,
      gramsPerUnit: null,
      grams: 40,
      per100G: { carbsG: 62.6, proteinG: 23.9, fatG: 1.2, fiberG: 0, kcal: 356.3 },
    },
    {
      name: "brown rice",
      kind: "direct",
      quantity: 50,
      unit: null,
      gramsPerUnit: null,
      grams: 50,
      per100G: { carbsG: 76.3, proteinG: 7.5, fatG: 3.2, fiberG: 4.42, kcal: 364 },
    },
    // The tempering. Easy to overlook in a fixture, and leaving it out moves
    // the dish's kcal by 22.5 per 100 g while leaving carbs and protein
    // untouched - which is precisely how its absence was caught.
    {
      name: "ghee",
      kind: "measure",
      quantity: 1,
      unit: "tsp",
      gramsPerUnit: 5,
      grams: 5,
      per100G: { carbsG: 0, proteinG: 0, fatG: 100, fiberG: 0, kcal: 900 },
    },
  ]
}

describe("toPortion", () => {
  it("re-bases a batch by Servings, leaving counts honestly fractional", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const egg = portion.ingredients.find((i) => i.name === "egg")!
    // 2 eggs across 1.5 servings really is 1.33 eggs in one portion.
    expect(egg.quantity).toBeCloseTo(1.333, 3)
    expect(egg.grams).toBeCloseTo(66.67, 2)
  })

  it("derives a yield factor from declared portion weight against raw weight", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    // 180 g of raw ingredients per portion cooks down to a declared 150 g.
    expect(portion.yieldFactor).toBeCloseTo(150 / 120, 3)
  })

  it("reproduces a khichdi's live per-100g, which is the whole safety argument", () => {
    // Servings 1, so the portion IS the batch. Stored live values for this
    // row are C31.60 P6.70 F3.50 E184.70; deriving them from ingredients has
    // to land on the same figures or this layer would be changing nutrition.
    const portion = toPortion(khichdiBatch(), 1, 200)
    const per100 = per100GOfPortion(portion.macros, portion.portionGrams)
    expect(per100.carbsG).toBeCloseTo(31.6, 1)
    expect(per100.proteinG).toBeCloseTo(6.7, 1)
    expect(per100.fatG).toBeCloseTo(3.5, 1)
    expect(per100.kcal).toBeCloseTo(184.8, 0)
  })

  it("refuses a zero or negative Servings rather than dividing by it", () => {
    expect(() => toPortion(eggBhurjiBatch(), 0, 150)).toThrow(IngredientEditError)
    expect(() => toPortion(eggBhurjiBatch(), -1, 150)).toThrow(/greater than 0/)
  })

  it("refuses a recipe with no ingredient weight", () => {
    expect(() => toPortion([], 1, 150)).toThrow(/no ingredient weight/)
  })
})

describe("setIngredientQuantity", () => {
  it("applies the canonical edit: 1.33 eggs to 3, with an exact macro delta", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const result = setIngredientQuantity(portion, "egg", 3)

    // +1.67 eggs is +83.3 g, and 83.3 g of egg at 12.6 g protein/100 g is
    // +10.50 g protein. Nothing here is approximated.
    expect(result.delta.proteinG).toBeCloseTo(10.5, 1)
    expect(result.delta.fatG).toBeCloseTo(7.92, 1)
    expect(result.delta.kcal).toBeCloseTo(115.58, 1)
    expect(result.recipe.ingredients.find((i) => i.name === "egg")!.grams).toBeCloseTo(150, 5)
  })

  it("leaves every other ingredient untouched - the onion does not grow with the egg", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const before = portion.ingredients.find((i) => i.name === "onion")!
    const after = setIngredientQuantity(portion, "egg", 3).recipe.ingredients.find(
      (i) => i.name === "onion",
    )!
    expect(after.grams).toBe(before.grams)
    expect(after.quantity).toBe(before.quantity)
  })

  it("moves the plated weight by the added raw grams scaled by yield", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const result = setIngredientQuantity(portion, "egg", 3)
    const addedRaw = 150 - 100 / 1.5
    expect(result.recipe.portionGrams).toBeCloseTo(150 + addedRaw * portion.yieldFactor, 2)
    expect(result.weightChanged).toBe(true)
  })

  it("edits a gram-measured ingredient in grams, not in units", () => {
    const portion = toPortion(khichdiBatch(), 1, 200)
    const result = setIngredientQuantity(portion, "moong dal", 60)
    // 20 g more moong dal at 23.9 g protein/100 g is +4.78 g protein.
    expect(result.delta.proteinG).toBeCloseTo(4.78, 2)
    expect(result.delta.carbsG).toBeCloseTo(12.52, 2)
  })

  it("removes the ingredient entirely at quantity 0", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const result = setIngredientQuantity(portion, "ghee", 0)
    expect(result.recipe.ingredients.map((i) => i.name)).toEqual(["egg", "onion"])
    // All of this dish's fat beyond the egg came from the ghee.
    expect(result.delta.fatG).toBeCloseTo(-(5 / 1.5), 2)
  })

  it("is a no-op, with a zero delta, when set to the value it already holds", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const egg = portion.ingredients.find((i) => i.name === "egg")!
    const result = setIngredientQuantity(portion, "egg", egg.quantity)
    expect(result.delta.proteinG).toBeCloseTo(0, 6)
    expect(result.weightChanged).toBe(false)
    expect(result.recipe.portionGrams).toBeCloseTo(150, 6)
  })

  it("keeps macros and per-100g mutually consistent after an edit", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const result = setIngredientQuantity(portion, "egg", 3)
    const recomputed = per100GOfPortion(result.recipe.macros, result.recipe.portionGrams)
    expect(result.per100G.proteinG).toBeCloseTo(recomputed.proteinG, 6)
    expect(result.recipe.macros.proteinG).toBeCloseTo(
      sumIngredientMacros(result.recipe.ingredients).proteinG,
      6,
    )
  })

  it("does not mutate the recipe it was given", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    const snapshot = JSON.stringify(portion)
    setIngredientQuantity(portion, "egg", 3)
    expect(JSON.stringify(portion)).toBe(snapshot)
  })

  it("refuses an unknown ingredient, naming what the dish actually has", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    expect(() => setIngredientQuantity(portion, "paneer", 2)).toThrow(/not an ingredient/)
    expect(() => setIngredientQuantity(portion, "paneer", 2)).toThrow(/egg, ghee, onion/)
  })

  it("refuses a negative quantity instead of quietly clamping it to zero", () => {
    const portion = toPortion(eggBhurjiBatch(), 1.5, 150)
    expect(() => setIngredientQuantity(portion, "egg", -1)).toThrow(IngredientEditError)
    expect(() => setIngredientQuantity(portion, "egg", Number.NaN)).toThrow(/finite/)
  })
})

describe("helpers", () => {
  it("converts a unit count to grams, and passes grams through untouched", () => {
    const [egg, , onion] = eggBhurjiBatch()
    expect(gramsForQuantity(egg, 3)).toBe(150)
    expect(gramsForQuantity(onion, 1)).toBe(150)
    const dal = khichdiBatch()[0]
    expect(gramsForQuantity(dal, 60)).toBe(60)
  })

  it("scales macros linearly with grams", () => {
    const egg = eggBhurjiBatch()[0]
    expect(macrosForGrams(egg.per100G, 50).proteinG).toBeCloseTo(6.3, 5)
    expect(macrosForGrams(egg.per100G, 0).kcal).toBe(0)
  })

  it("returns zeros rather than Infinity for a zero-weight portion", () => {
    expect(per100GOfPortion({ kcal: 10, proteinG: 1, carbsG: 1, fatG: 1, fiberG: 0 }, 0)).toEqual({
      carbsG: 0,
      proteinG: 0,
      fatG: 0,
      fiberG: 0,
      kcal: 0,
    })
  })
})

/**
 * The plated scale.
 *
 * A plan item is plated at whatever weight the day needs, which on real plans
 * is a declared portion only 40 percent of the time and is routinely 2x or 3x
 * it. plan-item-ingredients.ts reaches that scale by dividing the batch by
 * `servings / portions` rather than by `servings`, so these assert the
 * properties that makes the panel honest: the amounts scale with the plate,
 * while everything that describes the DISH rather than the serving does not.
 */
describe("scaling a batch to the plated weight", () => {
  const SERVINGS = 1.5
  const DECLARED_PORTION_G = 150

  it("lists proportionally more of every ingredient when the dish is plated at 3 portions", () => {
    const one = toPortion(eggBhurjiBatch(), SERVINGS, DECLARED_PORTION_G)
    const portions = 3
    const three = toPortion(eggBhurjiBatch(), SERVINGS / portions, DECLARED_PORTION_G * portions)

    expect(three.ingredients).toHaveLength(one.ingredients.length)
    for (const [i, ing] of three.ingredients.entries()) {
      expect(ing.quantity).toBeCloseTo(one.ingredients[i].quantity * portions, 10)
      expect(ing.grams).toBeCloseTo(one.ingredients[i].grams * portions, 10)
    }
    expect(three.macros.kcal).toBeCloseTo(one.macros.kcal * portions, 10)
    expect(three.portionGrams).toBe(DECLARED_PORTION_G * portions)
  })

  it("leaves yield factor and per-100g untouched, because neither describes the serving", () => {
    const one = toPortion(eggBhurjiBatch(), SERVINGS, DECLARED_PORTION_G)
    const three = toPortion(eggBhurjiBatch(), SERVINGS / 3, DECLARED_PORTION_G * 3)

    expect(three.yieldFactor).toBeCloseTo(one.yieldFactor, 10)
    const a = per100GOfPortion(one.macros, one.portionGrams)
    const b = per100GOfPortion(three.macros, three.portionGrams)
    expect(b.proteinG).toBeCloseTo(a.proteinG, 10)
    expect(b.carbsG).toBeCloseTo(a.carbsG, 10)
    expect(b.fatG).toBeCloseTo(a.fatG, 10)
    expect(b.kcal).toBeCloseTo(a.kcal, 10)
  })

  it("adds one egg to the plate, not one egg per portion", () => {
    const three = toPortion(eggBhurjiBatch(), SERVINGS / 3, DECLARED_PORTION_G * 3)
    const eggs = three.ingredients.find((i) => i.name === "egg")!
    const edited = setIngredientQuantity(three, "egg", eggs.quantity + 1)

    const after = edited.recipe.ingredients.find((i) => i.name === "egg")!
    expect(after.quantity).toBeCloseTo(eggs.quantity + 1, 10)
    // One 50 g egg, whatever the plate already held.
    expect(after.grams - eggs.grams).toBeCloseTo(50, 10)
    expect(edited.delta.proteinG).toBeGreaterThan(0)
  })
})
