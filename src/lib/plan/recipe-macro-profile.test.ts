import { describe, expect, it } from "vitest"

import {
  MACRO_PROFILE_FILTERS,
  macroProfileTags,
  matchesAnyTag,
  type MacroProfileInput,
} from "./recipe-macro-profile"

/** Atwater, so a fixture can never claim a macro split its own energy contradicts. */
function recipe(proteinPer100G: number, carbsPer100G: number, fatPer100G: number): MacroProfileInput {
  return {
    proteinPer100G,
    carbsPer100G,
    kcalPer100G: proteinPer100G * 4 + carbsPer100G * 4 + fatPer100G * 9,
  }
}

// Real ingested rows — protein/carbs/fat per 100 g copied from the recipes
// table, not invented. An earlier draft of this file guessed the salad's
// carbs and fat and it fell just under the threshold, which is a good reason
// to take fixture numbers from the data rather than from memory.
const EGG_WHITES = recipe(12.8, 0.8, 0.2) // 91% of calories from protein
const KADAI_CHICKEN = recipe(19, 2.9, 15.7) // 33%
const BEETROOT_MOONG_SALAD = recipe(7.3, 21, 0.4) // exactly 25.0% — the boundary row, and high-carb too
const RICE_AKKI_ROTI = recipe(4.4, 58.3, 10.1) // 68% carbs
const GREEN_APPLE = recipe(0.4, 16.7, 0.2) // 95% carbs

// The trap: a percentage of almost nothing. Both are real rows.
const HIBISCUS_ROSE_TEA = recipe(0.2, 0.2, 0)
const ROSE_TEA = recipe(0, 0.5, 0)

describe("macroProfileTags — high protein", () => {
  it("tags real protein dishes", () => {
    expect(macroProfileTags(EGG_WHITES)).toContain("high_protein")
    expect(macroProfileTags(KADAI_CHICKEN)).toContain("high_protein")
    // The leanest row that still qualifies — the floor is set below this on purpose.
    expect(macroProfileTags(BEETROOT_MOONG_SALAD)).toContain("high_protein")
  })

  it("does NOT tag a carb dish", () => {
    expect(macroProfileTags(RICE_AKKI_ROTI)).not.toContain("high_protein")
  })
})

describe("macroProfileTags — high carb", () => {
  it("tags real carbohydrate dishes", () => {
    expect(macroProfileTags(RICE_AKKI_ROTI)).toContain("high_carb")
    expect(macroProfileTags(GREEN_APPLE)).toContain("high_carb")
  })

  it("does NOT tag a lean protein dish", () => {
    expect(macroProfileTags(EGG_WHITES)).not.toContain("high_carb")
  })

  it("a dish can hold both tags — 7 rows in the real table do", () => {
    expect(macroProfileTags(BEETROOT_MOONG_SALAD).sort()).toEqual(["high_carb", "high_protein"])
  })
})

describe("the absolute floor — the reason each tag is two gates", () => {
  it("excludes an infusion that is 50% protein BY SHARE on 0.2 g per 100 g", () => {
    // Ranked by protein share alone this row is second in the whole table,
    // above every chicken dish. It is tea.
    const share = (HIBISCUS_ROSE_TEA.proteinPer100G * 4) / HIBISCUS_ROSE_TEA.kcalPer100G
    expect(share).toBeGreaterThanOrEqual(0.25)
    expect(macroProfileTags(HIBISCUS_ROSE_TEA)).toEqual([])
  })

  it("excludes an infusion that is 100% carbohydrate by share", () => {
    expect((ROSE_TEA.carbsPer100G * 4) / ROSE_TEA.kcalPer100G).toBe(1)
    expect(macroProfileTags(ROSE_TEA)).toEqual([])
  })

  it("never tags a zero-energy row, which would divide by zero", () => {
    expect(macroProfileTags(recipe(0, 0, 0))).toEqual([])
  })
})

describe("matchesAnyTag", () => {
  it("selecting nothing shows everything", () => {
    expect(matchesAnyTag([], [])).toBe(true)
    expect(matchesAnyTag(["high_carb"], [])).toBe(true)
  })

  it("selecting both chips is OR, not AND — ticking both WIDENS the search", () => {
    // Only 7 rows in the whole table are both; intersecting would read as a
    // broken filter.
    expect(matchesAnyTag(["high_protein"], ["high_protein", "high_carb"])).toBe(true)
    expect(matchesAnyTag(["high_carb"], ["high_protein", "high_carb"])).toBe(true)
    expect(matchesAnyTag([], ["high_protein", "high_carb"])).toBe(false)
  })
})

describe("filter definitions", () => {
  it("every filter states its own rule, so a chip tooltip can never go stale", () => {
    for (const f of MACRO_PROFILE_FILTERS) {
      expect(f.label.length).toBeGreaterThan(0)
      expect(f.description).toMatch(/per 100 g/)
    }
  })
})
