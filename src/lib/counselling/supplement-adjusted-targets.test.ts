import { describe, expect, it } from "vitest"

import {
  describeSupplement,
  foodTargetsAfterSupplement,
  supplementDailyTotals,
  type PrescribedSupplement,
} from "./supplement-adjusted-targets"
import type { WeekTargets } from "./roadmap"

/** Sneha's real week-1 target (TEST-003). */
const TARGET: WeekTargets = { kcal: 1459, proteinG: 73, carbsG: 184.8, fatG: 47.6, fibreG: 30 }

const WHEY: PrescribedSupplement = {
  name: "Whey protein",
  servingLabel: "1 scoop",
  servingsPerDay: 1,
  proteinGPerServing: 24,
  kcalPerServing: 120,
}

describe("supplementDailyTotals", () => {
  it("multiplies per-serving figures by servings per day", () => {
    expect(supplementDailyTotals({ ...WHEY, servingsPerDay: 2 })).toEqual({ proteinG: 48, kcal: 240 })
  })
})

describe("foodTargetsAfterSupplement", () => {
  it("returns the prescribed target untouched when nothing is prescribed", () => {
    const out = foodTargetsAfterSupplement(TARGET, null)
    expect(out.food).toEqual(TARGET)
    expect(out.supplement).toEqual({ proteinG: 0, kcal: 0 })
    expect(out.warnings).toEqual([])
  })

  it("subtracts the supplement's protein and calories from what the food must supply", () => {
    const out = foodTargetsAfterSupplement(TARGET, WHEY)
    expect(out.food.proteinG).toBe(73 - 24)
    expect(out.food.kcal).toBe(1459 - 120)
  })

  it("carries fat through untouched", () => {
    expect(foodTargetsAfterSupplement(TARGET, WHEY).food.fatG).toBe(TARGET.fatG)
  })

  it("puts the scoop's NON-protein calories into carbs, keeping the target self-consistent", () => {
    // 120 kcal scoop, 24g protein = 96 kcal. The other 24 kcal must come out
    // of carbs (~6g) or kcal would no longer equal its own macros.
    //
    // Precision 0, not 1: TARGET is Sneha's REAL week-1 figures, and its
    // stored carbs (184.8) is not exactly its own residual — so the drop is
    // 6.15g, not 6.00g. Keeping the real numbers and loosening the assertion
    // is better than inventing a tidy fixture that hides that.
    const out = foodTargetsAfterSupplement(TARGET, WHEY)
    expect(TARGET.carbsG - out.food.carbsG).toBeCloseTo(6, 0)
    expect(out.food.kcal).toBeCloseTo(out.food.proteinG * 4 + out.food.carbsG * 4 + out.food.fatG * 9, 6)
  })

  it("leaves fibre alone — it is a soft target the supplement does not touch", () => {
    expect(foodTargetsAfterSupplement(TARGET, WHEY).food.fibreG).toBe(TARGET.fibreG)
  })

  it("warns, rather than going negative, when the supplement exceeds the protein target", () => {
    const out = foodTargetsAfterSupplement(TARGET, { ...WHEY, proteinGPerServing: 80 })
    expect(out.food.proteinG).toBe(0)
    expect(out.warnings.join(" ")).toContain("entire")
  })

  it("warns when the food is left with too little protein to plan around", () => {
    const out = foodTargetsAfterSupplement(TARGET, { ...WHEY, proteinGPerServing: 60 })
    expect(out.food.proteinG).toBe(13)
    expect(out.warnings.some((w) => w.includes("very little"))).toBe(true)
  })

  it("never produces a negative figure for any macro", () => {
    const out = foodTargetsAfterSupplement(TARGET, { ...WHEY, proteinGPerServing: 500, kcalPerServing: 5000 })
    expect(out.food.kcal).toBe(0)
    expect(out.food.proteinG).toBe(0)
    expect(out.food.carbsG).toBe(0)
  })

  it("is silent for an ordinary prescription — warnings are for real problems only", () => {
    expect(foodTargetsAfterSupplement(TARGET, WHEY).warnings).toEqual([])
  })

  it("scales with servings per day", () => {
    const out = foodTargetsAfterSupplement(TARGET, { ...WHEY, servingsPerDay: 2 })
    expect(out.food.proteinG).toBe(73 - 48)
    expect(out.food.kcal).toBe(1459 - 240)
  })
})

describe("describeSupplement", () => {
  it("reads as a dietitian would write it", () => {
    expect(describeSupplement(WHEY)).toBe("Daily: 1 scoop Whey protein — 24 g protein, 120 kcal")
  })

  it("shows the multiplier when more than one serving a day", () => {
    expect(describeSupplement({ ...WHEY, servingsPerDay: 2 })).toBe(
      "Daily: 2 × 1 scoop Whey protein — 48 g protein, 240 kcal"
    )
  })
})
