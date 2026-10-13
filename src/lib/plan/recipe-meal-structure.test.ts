import { describe, expect, it } from "vitest"

import { recipeCategoryBucket } from "./recipe-category"
import { formatSlotStructureRules, isMealStaple, isSelfContainedMeal, MEAT_CONFLICTING_BUCKETS } from "./recipe-meal-structure"

describe("formatSlotStructureRules", () => {
  it("returns empty string when no slot needs structure rules", () => {
    expect(formatSlotStructureRules(["breakfast", "mid_morning", "evening"])).toBe("")
  })

  it("renders one rule line per structured slot (lunch, dinner)", () => {
    const text = formatSlotStructureRules(["breakfast", "lunch", "dinner"])
    expect(text).toContain("lunch must include")
    expect(text).toContain("dinner must include")
    expect(text).not.toContain("breakfast must include")
  })

  it("mentions the staple+dal requirement and the liquid-anchor prohibition", () => {
    const text = formatSlotStructureRules(["lunch"])
    expect(text).toContain("Roti/Paratha/Thepla and/or Rice/Pulao")
    expect(text).toContain("a wrap, roll, sandwich or chilla is NOT a staple")
    expect(text).toContain("exactly ONE Dal/Curry OR ONE Sabzi (never both)")
    expect(text).toContain("Salad and/or Curd/Raita")
    expect(text).toContain("Never anchor lunch on soup, tea, dessert, or a liquid dish alone")
  })

  it("says a composite dish already satisfies staple+dal and warns against adding a separate staple", () => {
    const text = formatSlotStructureRules(["lunch"])
    expect(text).toContain("a real Khichdi — not a porridge")
    expect(text).toContain("never add a SEPARATE roti/rice beside one of these")
  })

  it("warns that a plain protein main (zero carbs) still needs a real staple, unlike a composite dish", () => {
    const text = formatSlotStructureRules(["lunch"])
    expect(text).toContain("Roasted Chicken")
    expect(text).toContain("has NO carbs and still needs a staple")
  })

  it("says a real egg/chicken/fish dish substitutes for the Dal/Curry requirement", () => {
    const text = formatSlotStructureRules(["lunch"])
    expect(text).toContain("is the meal's protein course by itself")
  })

  it("says a real non-veg dish must never be paired with a cooked Sabzi or Dal/Curry, and suggests a Salad or sizing up quantity instead", () => {
    const text = formatSlotStructureRules(["lunch"])
    expect(text).toContain("NEVER with a cooked Sabzi or Dal/Curry")
    expect(text).toContain("pair it with a staple and a salad/curd")
  })
})

describe("MEAT_CONFLICTING_BUCKETS", () => {
  it("includes sabzi and dal_curry but not salad — a salad alongside meat is fine, only a cooked sabzi/dal course is the conflict", () => {
    expect(MEAT_CONFLICTING_BUCKETS.has("sabzi")).toBe(true)
    expect(MEAT_CONFLICTING_BUCKETS.has("dal_curry")).toBe(true)
    expect(MEAT_CONFLICTING_BUCKETS.has("salad")).toBe(false)
  })
})

describe("isSelfContainedMeal", () => {
  it("is true for a genuinely composite heavy_meal/light_meal dish with real carbs (e.g. Rajma Chawal, Biryani)", () => {
    expect(isSelfContainedMeal("Heavy Meal", "heavy_meal", 19.1)).toBe(true)
    expect(isSelfContainedMeal("Light Meal", "light_meal", 15)).toBe(true)
  })

  it("is FALSE for a heavy_meal-bucket dish with near-zero carbs — a plain protein main, not a composite meal (real regression: Roasted Chicken, Grilled Chicken Breast, Air Fried Fish, Grilled Fish are all Category=Heavy Meal with C0/100g)", () => {
    expect(isSelfContainedMeal("Heavy Meal", "heavy_meal", 0)).toBe(false)
    expect(isSelfContainedMeal("Heavy Meal", "heavy_meal", 4)).toBe(false)
  })

  it("is true right at the real observed carb threshold (8g/100g — Tomato Risotto, the lowest genuinely composite Heavy Meal row) and false just under it (7.8g — Low Calorie Pav Bhaji, correctly non-composite since a bhaji is eaten WITH pav)", () => {
    expect(isSelfContainedMeal("Heavy Meal", "heavy_meal", 8)).toBe(true)
    expect(isSelfContainedMeal("Heavy Meal", "heavy_meal", 7.8)).toBe(false)
  })

  it("is true for a real khichdi even though its bucket is dal_curry, not heavy_meal", () => {
    expect(isSelfContainedMeal("Khichdi", recipeCategoryBucket("Khichdi", "Moong Dal Khichdi"), 22.3)).toBe(true)
    expect(isSelfContainedMeal("Khichdi", recipeCategoryBucket("Khichdi", "Bajre Ki Khichdi"), 11.6)).toBe(true)
  })

  // The CSV files porridges and Baingan Kachri (a brinjal sabzi) under
  // "Khichdi"; counting them as a complete meal let a dinner go out with two
  // sabzis and no roti or rice.
  it("is false for a porridge or a sabzi filed under the Khichdi category", () => {
    expect(recipeCategoryBucket("Khichdi", "Baingan Kachri")).toBe("sabzi")
    expect(recipeCategoryBucket("Khichdi", "Kasha Porridge")).toBe("other")
    expect(isSelfContainedMeal("Khichdi", recipeCategoryBucket("Khichdi", "Baingan Kachri"), 4.4)).toBe(false)
    expect(isSelfContainedMeal("Khichdi", recipeCategoryBucket("Khichdi", "Kasha Porridge"), 22.9)).toBe(false)
  })

  it("is true for a 'Curry + Rice' category dish (e.g. Kuttu Kadhi With Samak Chawal)", () => {
    expect(isSelfContainedMeal("Curry + Rice", "dal_curry", 20.7)).toBe(true)
  })

  it("is false for a plain Dal or Curry dish that genuinely needs a separate staple (e.g. Lentil Soup, Rajma Curry)", () => {
    expect(isSelfContainedMeal("Dal", "dal_curry", 14)).toBe(false)
    expect(isSelfContainedMeal("Sabzi", "dal_curry", 12)).toBe(false)
  })

  it("is false for an ordinary bread or rice dish", () => {
    expect(isSelfContainedMeal("Roti", "bread", 60)).toBe(false)
    expect(isSelfContainedMeal("Rice", "rice_pulao", 24)).toBe(false)
  })
})

describe("isMealStaple", () => {
  it("counts roti, paratha, thepla, rice, pulao and biryani", () => {
    for (const category of ["Roti", "Paratha", "Thepla", "Rice", "Pulao", "Biryani"]) {
      expect(isMealStaple(category, recipeCategoryBucket(category))).toBe(true)
    }
  })

  // A real plan's lunch was a 10 g Colocasia Leaves Roll with dal and no roti or rice.
  it("does not count a wrap, roll, sandwich or chilla", () => {
    for (const category of ["Wrap & Roll", "Sandwich", "Chila"]) {
      expect(isMealStaple(category, recipeCategoryBucket(category))).toBe(false)
    }
  })
})
