import { describe, expect, it } from "vitest"

import {
  applyWeekTargetOverride,
  assertWeekTargetOverride,
  impliedFatG,
  WeekTargetValidationError,
  weekTargetOverrideWarnings,
} from "./week-target-override"

const computed = { kcal: 1800, proteinG: 90, fatG: 50, carbsG: 245, fibreG: 30 }

describe("applyWeekTargetOverride", () => {
  it("returns the computed target untouched when there is no override", () => {
    expect(applyWeekTargetOverride(computed, null)).toBe(computed)
  })

  it("replaces kcal/protein/carbs and derives fat as the residual", () => {
    const t = applyWeekTargetOverride(computed, { kcal: 1700, proteinG: 110, carbsG: 180 })
    expect(t.kcal).toBe(1700)
    expect(t.proteinG).toBe(110)
    expect(t.carbsG).toBe(180)
    expect(t.fatG).toBeCloseTo((1700 - 440 - 720) / 9, 10)
    // kcal must always equal its own macros.
    expect(t.proteinG * 4 + t.carbsG * 4 + t.fatG * 9).toBeCloseTo(t.kcal, 10)
  })

  it("keeps the computed fibre target", () => {
    expect(applyWeekTargetOverride(computed, { kcal: 1700, proteinG: 110, carbsG: 180 }).fibreG).toBe(30)
  })

  it("refuses numbers that leave negative fat", () => {
    expect(() => applyWeekTargetOverride(computed, { kcal: 1000, proteinG: 150, carbsG: 150 })).toThrow(
      WeekTargetValidationError
    )
  })
})

describe("assertWeekTargetOverride", () => {
  it("accepts exactly zero fat", () => {
    expect(() => assertWeekTargetOverride({ kcal: 1200, proteinG: 150, carbsG: 150 })).not.toThrow()
    expect(impliedFatG({ kcal: 1200, proteinG: 150, carbsG: 150 })).toBe(0)
  })
})

describe("weekTargetOverrideWarnings", () => {
  it("warns on very low fat", () => {
    expect(weekTargetOverrideWarnings({ kcal: 1300, proteinG: 150, carbsG: 150 })).toHaveLength(1)
  })

  it("is silent on a normal split", () => {
    expect(weekTargetOverrideWarnings({ kcal: 1800, proteinG: 90, carbsG: 245 })).toEqual([])
  })
})
