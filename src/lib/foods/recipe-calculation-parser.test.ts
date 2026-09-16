import { describe, expect, it } from "vitest"

import { MIN_GRAMS_FOR_PER_100G, parseCalculation, per100GFrom } from "./recipe-calculation-parser"

// Verbatim from src/db/seed-data/recipe_ingredients.csv, "Egg Bhurji". It is
// the useful fixture because it exercises all three quantity shapes at once:
// a counted piece (egg), a measured unit (ghee, tsp) and a fractional count
// (onion, half a piece).
const EGG_BHURJI =
  "egg → 2 × 50g = 100g | egg → Carbs: 0.7, Protein: 12.6, Fat: 9.5, Fiber: 0, Energy: 138.7 | " +
  "ghee → 1'tsp = 5g | ghee → Carbs: 0, Protein: 0, Fat: 5, Fiber: 0, Energy: 45 | " +
  "onion → 0.5 × 150g = 75g | onion → Carbs: 4.88, Protein: 0.83, Fat: 0.08, Fiber: 1.84, Energy: 23.48"

// Verbatim from the same file, "Egg Spinach Bhurji" - the "direct: Ng" shape.
const DIRECT_SHAPE =
  "spinach leaf → direct: 15g | spinach leaf → Carbs: 0.54, Protein: 0.44, Fat: 0.06, Fiber: 0.36, Energy: 4.43"

describe("parseCalculation", () => {
  it("reads a counted piece, keeping the count and the per-unit weight apart", () => {
    const { ingredients, problems } = parseCalculation(EGG_BHURJI)
    expect(problems).toEqual([])

    const egg = ingredients.find((i) => i.name === "egg")
    expect(egg).toMatchObject({
      name: "egg",
      kind: "piece",
      count: 2,
      unit: "piece",
      gramsPerUnit: 50,
      grams: 100,
      carbsG: 0.7,
      proteinG: 12.6,
      fatG: 9.5,
      fiberG: 0,
      kcal: 138.7,
    })
  })

  it("reads a measured unit and derives grams for ONE of it", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    expect(ingredients.find((i) => i.name === "ghee")).toMatchObject({
      kind: "measure",
      count: 1,
      unit: "tsp",
      gramsPerUnit: 5,
      grams: 5,
      fatG: 5,
    })
  })

  it("keeps a fractional count fractional rather than rounding it to a whole piece", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    // Half an onion in a dish is correct, not a defect to be snapped away.
    expect(ingredients.find((i) => i.name === "onion")).toMatchObject({
      count: 0.5,
      gramsPerUnit: 150,
      grams: 75,
    })
  })

  it("reads the direct-grams shape with no unit at all", () => {
    const { ingredients, problems } = parseCalculation(DIRECT_SHAPE)
    expect(problems).toEqual([])
    expect(ingredients[0]).toMatchObject({
      name: "spinach leaf",
      kind: "direct",
      count: null,
      unit: null,
      gramsPerUnit: null,
      grams: 15,
    })
  })

  it("preserves source order, because that is the order a dish is written in", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    expect(ingredients.map((i) => i.name)).toEqual(["egg", "ghee", "onion"])
  })

  it("reports the source's own failure messages instead of silently dropping them", () => {
    // These strings are real cell contents, written by whatever script
    // produced the spreadsheet when it could not cost an ingredient.
    const { ingredients, problems } = parseCalculation(
      'Ingredient not found in nutrition sheet: | Unknown medium weight for: cardamom | Invalid format: "NA"',
    )
    expect(ingredients).toEqual([])
    expect(problems).toHaveLength(3)
    expect(problems[1]).toContain("cardamom")
  })

  it("drops an ingredient whose macros never arrived, and says so", () => {
    // A quantity with no macro fragment would otherwise contribute grams but
    // zero nutrition, silently understating the dish.
    const { ingredients, problems } = parseCalculation("egg → 2 × 50g = 100g")
    expect(ingredients).toEqual([])
    expect(problems).toEqual([expect.stringContaining("incomplete ingredient")])
  })

  it("returns empty for a blank cell without throwing", () => {
    expect(parseCalculation("")).toEqual({ ingredients: [], problems: [] })
  })
})

describe("per100GFrom", () => {
  it("recovers the reusable per-100g figure from a stated contribution", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    const egg = ingredients.find((i) => i.name === "egg")!
    // 100 g of egg contributing 12.6 g protein is 12.6 g per 100 g.
    expect(per100GFrom(egg)).toMatchObject({ proteinG: 12.6, fatG: 9.5, kcal: 138.7 })
  })

  it("scales a non-100g contribution correctly", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    const onion = ingredients.find((i) => i.name === "onion")!
    const per100 = per100GFrom(onion)!
    expect(per100.kcal).toBeCloseTo(31.3, 1) // 23.48 kcal in 75 g
    expect(per100.carbsG).toBeCloseTo(6.5, 1)
  })

  it("refuses a contribution too small to divide up without inventing precision", () => {
    const { ingredients } = parseCalculation(EGG_BHURJI)
    const ghee = ingredients.find((i) => i.name === "ghee")!
    // 5 g, and the source rounds to 2 dp - scaling up 20x would multiply that
    // rounding error by 20 too.
    expect(ghee.grams).toBeLessThan(MIN_GRAMS_FOR_PER_100G)
    expect(per100GFrom(ghee)).toBeNull()
  })
})
