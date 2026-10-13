import { describe, expect, it } from "vitest"

import { formatRecipeQuantity, portionSizeReferenceText } from "./recipe-quantity-display"

describe("formatRecipeQuantity — container scale (tier 3)", () => {
  it("buckets by the specified thresholds", () => {
    const dal = { name: "Lentil Soup", category: "Dal", unitLabel: "bowl", perUnitGrams: 150 }
    expect(formatRecipeQuantity(dal, 20)).toBe("spoonful, 20 g")
    expect(formatRecipeQuantity(dal, 85)).toBe("small serving, 85 g")
    expect(formatRecipeQuantity(dal, 150)).toBe("small bowl, 150 g")
    expect(formatRecipeQuantity(dal, 255)).toBe("bowl, 255 g")
    expect(formatRecipeQuantity(dal, 380)).toBe("large bowl, 380 g")
    expect(formatRecipeQuantity(dal, 500)).toBe("plate, 500 g")
  })

  it("treats each threshold as inclusive of its upper bound", () => {
    const dal = { name: "Lentil Soup", category: "Dal", unitLabel: "bowl", perUnitGrams: 150 }
    expect(formatRecipeQuantity(dal, 40)).toBe("spoonful, 40 g")
    expect(formatRecipeQuantity(dal, 41)).toBe("small serving, 41 g")
    expect(formatRecipeQuantity(dal, 100)).toBe("small serving, 100 g")
    expect(formatRecipeQuantity(dal, 101)).toBe("small bowl, 101 g")
    expect(formatRecipeQuantity(dal, 450)).toBe("large bowl, 450 g")
    expect(formatRecipeQuantity(dal, 451)).toBe("plate, 451 g")
  })

  it("routes a vessel/stray source noun through the container scale, NOT through that noun — this is the whole point of the change", () => {
    // Previously these rendered "1 katori" / "2 glasses" / "2 rices".
    expect(formatRecipeQuantity({ name: "Kokum Sherbet", category: "Water Beverage", unitLabel: "glass", perUnitGrams: 200 }, 400)).toBe("2 glasses, 400 ml") // a drink: glass, not bowl
    expect(formatRecipeQuantity({ name: "Kuttu Kadhi With Samak Chawal (Navratri Special)", category: "Curry + Rice", unitLabel: "rice", perUnitGrams: 330 }, 470)).toBe("plate, 470 g")
    expect(formatRecipeQuantity({ name: "Cauliflower Curry", category: "Sabzi", unitLabel: "cup", perUnitGrams: 100 }, 190)).toBe("small bowl, 190 g")
  })

  it("handles a recipe with no per-unit data at all (Green Apple) — container scale, never a fabricated piece count", () => {
    expect(formatRecipeQuantity({ name: "Green Apple", category: "Fruit", unitLabel: null, perUnitGrams: null }, 185)).toBe("small bowl, 185 g")
  })

  it("never returns null — the container scale covers any gram figure", () => {
    expect(formatRecipeQuantity({ name: "Grilled Chicken", category: "Heavy Meal", unitLabel: null, perUnitGrams: null }, 150)).toBe("small bowl, 150 g")
  })
})

describe("formatRecipeQuantity — discrete pieces (tier 2)", () => {
  it("counts by the recipe's own real per-piece weight", () => {
    expect(formatRecipeQuantity({ name: "Masala Dosa", category: "Dosa", unitLabel: "piece", perUnitGrams: 97 }, 115)).toBe("1 piece, 115 g")
    expect(formatRecipeQuantity({ name: "Roti", category: "Roti", unitLabel: "piece", perUnitGrams: 40 }, 105)).toBe("3 pieces, 105 g")
    expect(formatRecipeQuantity({ name: "Plain Rava Idli", category: "Idli", unitLabel: "piece", perUnitGrams: 60 }, 180)).toBe("3 pieces, 180 g")
  })

  it("keeps singular at a count of 1 and never rounds down to zero", () => {
    expect(formatRecipeQuantity({ name: "Ragi Roti", category: "Roti", unitLabel: "piece", perUnitGrams: 70 }, 80)).toBe("1 piece, 80 g")
    expect(formatRecipeQuantity({ name: "Cashew", category: "Nuts", unitLabel: "piece", perUnitGrams: 40 }, 5)).toBe("1 piece, 5 g")
  })
})

describe("formatRecipeQuantity — whole fruit by the piece (tier 1)", () => {
  it("counts Apple and Banana under their own name", () => {
    expect(formatRecipeQuantity({ name: "Apple", category: "Fruit", unitLabel: "bowl", perUnitGrams: 150 }, 150)).toBe("1 apple, 150 g")
    expect(formatRecipeQuantity({ name: "Apple", category: "Fruit", unitLabel: "bowl", perUnitGrams: 150 }, 300)).toBe("2 apples, 300 g")
    expect(formatRecipeQuantity({ name: "Banana", category: "Fruit", unitLabel: "bowl", perUnitGrams: 150 }, 230)).toBe("2 bananas, 230 g")
  })

  it("uses the ingested per-piece weight for a Fruit row the source already counts by the piece, under its own name", () => {
    expect(formatRecipeQuantity({ name: "Mango", category: "Fruit", unitLabel: "piece", perUnitGrams: 250 }, 250)).toBe("1 mango, 250 g")
    expect(formatRecipeQuantity({ name: "Peach", category: "Fruit", unitLabel: "piece", perUnitGrams: 150 }, 300)).toBe("2 peaches, 300 g")
  })

  it("does NOT generalise to every Fruit row — a mixed-fruit bowl and per-gram grapes stay on the container scale", () => {
    expect(formatRecipeQuantity({ name: "All-Season Mix Fruit Bowl", category: "Fruit", unitLabel: "cup", perUnitGrams: 200 }, 200)).toBe("small bowl, 200 g")
    expect(formatRecipeQuantity({ name: "Grapes", category: "Fruit", unitLabel: "g", perUnitGrams: 1 }, 120)).toBe("small bowl, 120 g")
    expect(formatRecipeQuantity({ name: "Papaya", category: "Fruit", unitLabel: "cup", perUnitGrams: 200 }, 300)).toBe("bowl, 300 g")
  })
})

describe("portionSizeReferenceText", () => {
  it("states every bucket in the scale", () => {
    const text = portionSizeReferenceText()
    for (const label of ["spoonful", "small serving", "small bowl", "bowl", "large bowl", "plate"]) {
      expect(text).toContain(label)
    }
  })
})

describe("formatRecipeQuantity — dry snacks", () => {
  it("says small handful, not spoonful, for chips and nuts under 40 g", () => {
    expect(formatRecipeQuantity({ name: "Banana Chips", category: "Snack", unitLabel: null, perUnitGrams: null }, 40)).toBe("small handful, 40 g")
    expect(formatRecipeQuantity({ name: "Roasted Chickpeas", category: "Nuts", unitLabel: null, perUnitGrams: null }, 25)).toBe("small handful, 25 g")
  })

  it("keeps spoonful for a chutney, and the normal scale for a bigger snack", () => {
    expect(formatRecipeQuantity({ name: "Mint Chutney", category: "Chutney", unitLabel: null, perUnitGrams: null }, 25)).toBe("spoonful, 25 g")
    expect(formatRecipeQuantity({ name: "Banana Chips", category: "Snack", unitLabel: null, perUnitGrams: null }, 53)).toBe("small serving, 53 g")
  })
})

describe("formatRecipeQuantity — drinks", () => {
  const drink = (category: string) => ({ name: "Lemon Water", category, unitLabel: "glass", perUnitGrams: 250 })

  it("serves a drink in a glass, in ml, never a bowl", () => {
    expect(formatRecipeQuantity(drink("Morning Water"), 250)).toBe("glass, 250 ml")
    expect(formatRecipeQuantity(drink("Lassi"), 200)).toBe("glass, 200 ml")
    expect(formatRecipeQuantity(drink("Smoothie"), 333)).toBe("glass, 333 ml")
  })

  it("serves tea and coffee in a cup", () => {
    expect(formatRecipeQuantity(drink("Tea"), 150)).toBe("cup, 150 ml")
  })

  it("counts glasses for a big pour and calls a tiny one a shot", () => {
    expect(formatRecipeQuantity(drink("Juice"), 500)).toBe("2 glasses, 500 ml")
    expect(formatRecipeQuantity(drink("Morning Water"), 30)).toBe("shot, 30 ml")
  })

  it("keeps soup in a bowl", () => {
    expect(formatRecipeQuantity({ name: "Pumpkin Soup", category: "Light Soup", unitLabel: "bowl", perUnitGrams: 200 }, 200)).toBe("small bowl, 200 g")
  })
})
