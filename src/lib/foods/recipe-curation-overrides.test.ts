import { describe, expect, it } from "vitest"

import { CATEGORY_OVERRIDES, CurationOverrideTracker, RETIRED_RECIPES, SEASON_OVERRIDES } from "./recipe-curation-overrides"
import { recipeCategoryBucket } from "@/lib/plan/recipe-category"
import { isMustHaveSatisfied } from "@/lib/plan/recipe-pairing"

describe("CurationOverrideTracker", () => {
  it("passes through a recipe with no override, unchanged", () => {
    const t = new CurationOverrideTracker()
    expect(t.applyCategory("Gobhi Paratha", "Paratha")).toBe("Paratha")
    expect(t.applySeason("Gobhi Paratha", "winter")).toBe("winter")
    expect(t.appliedCategoryCount).toBe(0)
    expect(t.appliedSeasonCount).toBe(0)
  })

  it("corrects a mislabelled legume curry's category", () => {
    const t = new CurationOverrideTracker()
    expect(t.applyCategory("Rajma Curry", "Sabzi")).toBe("Curry")
    expect(t.appliedCategoryCount).toBe(1)
  })

  it("corrects a mislabelled dal's category", () => {
    const t = new CurationOverrideTracker()
    expect(t.applyCategory("Sambhar", "Sabzi")).toBe("Dal")
    expect(t.applyCategory("Dal Palak", "High Protein Sabzi")).toBe("Dal")
  })

  it("frees a year-round staple dal from the source's Winter tag", () => {
    const t = new CurationOverrideTracker()
    expect(t.applySeason("Arhar Dal Without Tadka", "winter")).toBe("all_year")
    expect(t.appliedSeasonCount).toBe(1)
  })

  it("counts each overridden recipe once, however many rows are processed", () => {
    const t = new CurationOverrideTracker()
    t.applyCategory("Rajma Curry", "Sabzi")
    t.applyCategory("Rajma Curry", "Sabzi")
    expect(t.appliedCategoryCount).toBe(1)
  })

  it("reports override entries that never matched a recipe, so a renamed source row can't silently disable one", () => {
    const t = new CurationOverrideTracker()
    t.applyCategory("Rajma Curry", "Sabzi")
    const unmatched = t.unmatched()
    expect(unmatched.category).not.toContain("Rajma Curry")
    expect(unmatched.category).toContain("Sambhar")
    expect(unmatched.season.length).toBe(Object.keys(SEASON_OVERRIDES).length)
  })
})

describe("override tables — scope discipline", () => {
  it("leaves plain vegetable gravies as Sabzi, so a potato gravy can never satisfy the lunch/dinner Dal requirement", () => {
    for (const name of [
      "Aloo Tamatar Sabzi With Gravy",
      "Aloo Gobhi Sabzi With Gravy",
      "Aloo Matar Sabzi With Gravy",
      "Aloo Pyaaz Sabzi With Gravy",
      "Aloo Sabzi With Gravy",
      "Pumpkin Sabzi With Gravy",
    ]) {
      expect(CATEGORY_OVERRIDES[name]).toBeUndefined()
    }
  })

  it("leaves genuinely seasonal dishes on their real season — spinach dals and bajra kadhi stay winter", () => {
    for (const name of ["Dal Palak", "Palak Moong Dal", "Haryali Palak Shorba", "Bajra Kadi"]) {
      expect(SEASON_OVERRIDES[name]).toBeUndefined()
    }
  })

  it("every override carries a written reason", () => {
    for (const [name, o] of Object.entries(CATEGORY_OVERRIDES)) {
      expect(o.reason, `category override "${name}"`).toBeTruthy()
    }
    for (const [name, o] of Object.entries(SEASON_OVERRIDES)) {
      expect(o.reason, `season override "${name}"`).toBeTruthy()
    }
  })

  it("only ever corrects TO a Dal or Curry category — this table is not a general relabelling tool", () => {
    for (const o of Object.values(CATEGORY_OVERRIDES)) {
      expect(["Dal", "Curry"]).toContain(o.value)
    }
  })
})

describe("downstream effect of the corrections", () => {
  it("a corrected dal now satisfies Rice's literal [Curry/Dal] must-have pairing, which Sabzi never could", () => {
    const rice = { mustHaveCategories: ["Curry", "Dal"], mustHaveRecipeNames: [] }
    // Before: Sambhar's category was "Sabzi" — no match, so Rice was unpairable with it.
    expect(isMustHaveSatisfied(rice, ["Sabzi"], ["Sambhar"])).toBe(false)
    // After: the corrected category matches.
    expect(isMustHaveSatisfied(rice, [CATEGORY_OVERRIDES["Sambhar"].value], ["Sambhar"])).toBe(true)
  })

  it("a corrected kadhi now buckets as dal_curry, so it counts as the meal's dal course", () => {
    expect(recipeCategoryBucket("Sabzi", "Kadhi Without Pakoda")).toBe("sabzi")
    expect(recipeCategoryBucket(CATEGORY_OVERRIDES["Kadhi Without Pakoda"].value, "Kadhi Without Pakoda")).toBe("dal_curry")
  })

  it("a legume curry already bucketed dal_curry by name keeps that bucket — the correction only adds category-text matching", () => {
    expect(recipeCategoryBucket("Sabzi", "Rajma Curry")).toBe("dal_curry")
    expect(recipeCategoryBucket(CATEGORY_OVERRIDES["Rajma Curry"].value, "Rajma Curry")).toBe("dal_curry")
  })
})

describe("RETIRED_RECIPES", () => {
  it("retires Sprout Chilla (same dish as Moong Dal Chilla) and nothing else by accident", () => {
    const t = new CurationOverrideTracker()
    expect(t.isRetired("Sprout Chilla")).toBe(true)
    expect(t.isRetired("Moong Dal Chilla")).toBe(false)
    expect(t.isRetired("Sprouted Black Chana Chilla")).toBe(false)
    expect(t.unmatched().retired).toEqual(Object.keys(RETIRED_RECIPES).filter((n) => n !== "Sprout Chilla"))
  })
})
