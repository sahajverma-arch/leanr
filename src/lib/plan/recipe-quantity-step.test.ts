import { describe, expect, it } from "vitest"

import {
  describeQuantity,
  GRAM_STEP,
  isCountable,
  MANUAL_GRAMS_CEILING_G,
  MANUAL_GRAMS_FLOOR_G,
  macroDelta,
  macrosAtGrams,
  stepGrams,
  steppedGrams,
  type SteppableItem,
} from "./recipe-quantity-step"

// Real ingested rows, taken straight from the recipes table - the per-piece
// weights differ per dish, which is the whole reason the step is not a fixed
// 40 g for everything called "roti".
const JOWAR_ROTI: SteppableItem = { unitLabel: "piece", perUnitGrams: 42, minGrams: 42, maxGrams: 126 }
const WHEAT_BRAN_ROTI: SteppableItem = { unitLabel: "piece", perUnitGrams: 60, minGrams: 60, maxGrams: 180 }
// A real row with no derivable unit noun at all.
const SINGHARE_ROTI: SteppableItem = { unitLabel: null, perUnitGrams: null, minGrams: 30, maxGrams: 150 }
// A vessel noun, not a countable thing - deliberately NOT treated as pieces.
const DAL: SteppableItem = { unitLabel: "katori", perUnitGrams: 150, minGrams: 100, maxGrams: 300 }

describe("isCountable / stepGrams", () => {
  it("counts only 'piece' rows, using that row's OWN per-piece weight", () => {
    expect(isCountable(JOWAR_ROTI)).toBe(true)
    expect(stepGrams(JOWAR_ROTI)).toBe(42)
    expect(stepGrams(WHEAT_BRAN_ROTI)).toBe(60)
  })

  it("treats a vessel noun as not countable", () => {
    // "katori" is how much a bowl holds, not a thing you can have three of.
    expect(isCountable(DAL)).toBe(false)
    expect(stepGrams(DAL)).toBe(GRAM_STEP)
  })

  it("falls back to grams when the row has no unit at all", () => {
    expect(isCountable(SINGHARE_ROTI)).toBe(false)
    expect(stepGrams(SINGHARE_ROTI)).toBe(GRAM_STEP)
  })
})

describe("steppedGrams", () => {
  it("steps a countable dish by whole pieces", () => {
    expect(steppedGrams(JOWAR_ROTI, 84, 1)).toBe(126) // 2 rotis -> 3
    expect(steppedGrams(JOWAR_ROTI, 126, -1)).toBe(84) // 3 rotis -> 2
  })

  it("snaps a generated off-grid quantity to a whole piece on the first press", () => {
    // The balancer optimises freely and rounds to a 5 g grid, so a real
    // plated item is routinely 125 g of a 42 g roti (2.98 pieces). "One more
    // roti" from there means 3, not 3.98.
    expect(steppedGrams(JOWAR_ROTI, 125, 1)).toBe(126)
    expect(steppedGrams(JOWAR_ROTI, 125, -1)).toBe(84)
  })

  it("never steps a countable dish below one piece", () => {
    expect(steppedGrams(JOWAR_ROTI, 42, -1)).toBe(42)
  })

  it("goes PAST the recipe's authored max — a fourth roti is a clinical call, not a data error", () => {
    // Jowar Roti's authored range stops at 126 g (3 pieces).
    expect(steppedGrams(JOWAR_ROTI, 126, 1)).toBe(168)
  })

  it("steps a gram-measured dish by a round 25 g", () => {
    expect(steppedGrams(DAL, 150, 1)).toBe(175)
    expect(steppedGrams(DAL, 150, -1)).toBe(125)
    // An off-grid starting point lands back on the grid rather than staying off it.
    expect(steppedGrams(DAL, 143, 1)).toBe(175)
  })

  it("clamps to the ingestion plausibility envelope in both directions", () => {
    expect(steppedGrams(DAL, MANUAL_GRAMS_CEILING_G, 1)).toBe(MANUAL_GRAMS_CEILING_G)
    expect(steppedGrams(DAL, MANUAL_GRAMS_FLOOR_G, -1)).toBe(MANUAL_GRAMS_FLOOR_G)
  })
})

describe("describeQuantity", () => {
  it("names whole pieces when the quantity genuinely is a whole number of them", () => {
    expect(describeQuantity(JOWAR_ROTI, 126)).toMatchObject({ pieces: 3, label: "3 pieces (126 g)" })
    expect(describeQuantity(JOWAR_ROTI, 42)).toMatchObject({ pieces: 1, label: "1 piece (42 g)" })
  })

  it("refuses to invent a piece count for an off-grid quantity", () => {
    // 125 g is 2.98 rotis. Calling that "3 pieces" would put a fabricated
    // number on a clinical document.
    expect(describeQuantity(JOWAR_ROTI, 125)).toMatchObject({ pieces: null, label: "125 g" })
  })

  it("flags a quantity outside the authored range without blocking it", () => {
    expect(describeQuantity(JOWAR_ROTI, 168).outsideRangeNote).toContain("Above")
    expect(describeQuantity(DAL, 50).outsideRangeNote).toContain("Below")
    expect(describeQuantity(DAL, 150).outsideRangeNote).toBeNull()
  })
})

describe("macrosAtGrams / macroDelta", () => {
  const per100 = { kcal: 200, proteinG: 8, carbsG: 30, fatG: 5, fiberG: 3 }

  it("scales per-100g figures to the served portion", () => {
    expect(macrosAtGrams(per100, 150)).toEqual({ kcal: 300, proteinG: 12, carbsG: 45, fatG: 7.5, fiberG: 4.5 })
  })

  it("reports the direct impact of a change, macro by macro", () => {
    const delta = macroDelta(macrosAtGrams(per100, 84), macrosAtGrams(per100, 126))
    expect(delta.kcal).toBeCloseTo(84, 6)
    expect(delta.proteinG).toBeCloseTo(3.36, 6)
    expect(delta.carbsG).toBeCloseTo(12.6, 6)
  })

  it("reports a removal as a negative delta", () => {
    const delta = macroDelta(macrosAtGrams(per100, 126), macrosAtGrams(per100, 0))
    expect(delta.kcal).toBeCloseTo(-252, 6)
  })
})
