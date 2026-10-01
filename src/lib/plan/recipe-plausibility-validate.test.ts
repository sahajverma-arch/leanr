import { describe, expect, it } from "vitest"

import { describePlausibilityProblems } from "./recipe-plausibility-validate"
import { makeRecipe } from "./test-fixtures"
import type { GroundedRecipeDay } from "./recipe-types"

const constraints = { dietType: "vegetarian", eligibleCuisines: ["General", "North Indian"], allergenTags: [] }

function makeDay(meals: GroundedRecipeDay["meals"]): GroundedRecipeDay {
  return { dayIndex: 0, meals, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }, cappedRecipeNames: [], unknownRecipeNames: [] }
}

describe("describePlausibilityProblems", () => {
  it("flags a structurally empty meal", () => {
    const day = makeDay([{ slot: "breakfast", items: [] }])
    expect(describePlausibilityProblems(day, constraints)).toEqual(["breakfast has no resolved items"])
  })

  it("does not flag an empty optional wake-up/bedtime meal — the dietitian fills it by hand", () => {
    const day = makeDay([
      { slot: "wake_up", items: [] },
      { slot: "bedtime", items: [] },
    ])
    expect(describePlausibilityProblems(day, constraints)).toEqual([])
  })

  it("does not require a MAIN item at wake_up", () => {
    const drink = makeRecipe({ name: "Jeera Water", mainOrMid: "mid" })
    const day = makeDay([{ slot: "wake_up", items: [{ recipe: drink, grams: 200 }] }])
    expect(describePlausibilityProblems(day, constraints)).toEqual([])
  })

  it("flags two sabzis in one lunch — one sabzi, one dal", () => {
    const roti = makeRecipe({ name: "Roti", category: "Roti" })
    const dal = makeRecipe({ name: "Arhar Dal", category: "Dal" })
    const paneer = makeRecipe({ name: "Paneer Bhurji", category: "High Protein Sabzi" })
    const bhindi = makeRecipe({ name: "Bhindi Masala", category: "Sabzi" })
    const day = makeDay([{ slot: "lunch", items: [roti, dal, paneer, bhindi].map((recipe) => ({ recipe, grams: 150 })) }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("2 sabzi dishes"))).toBe(true)
  })

  it("flags a duplicate recipe within one meal", () => {
    const dal = makeRecipe({ name: "Dal" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: dal, grams: 100 }, { recipe: dal, grams: 50 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true)
  })

  it("flags a real meal slot (lunch) with no MAIN item", () => {
    const side = makeRecipe({ name: "Side", mainOrMid: "mid" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: side, grams: 50 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("no MAIN"))).toBe(true)
  })

  it("does not require a MAIN item at mid_morning/evening/bedtime — snack-only occasions", () => {
    const snack = makeRecipe({ name: "Masala Chai", mainOrMid: "mid" })
    for (const slot of ["mid_morning", "evening", "bedtime"]) {
      const day = makeDay([{ slot, items: [{ recipe: snack, grams: 150 }] }])
      expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("no MAIN")), slot).toBe(false)
    }
  })

  it("flags stacking two rich (heavy_meal/dessert) dishes in one meal", () => {
    const heavy1 = makeRecipe({ name: "Butter Chicken", category: "Heavy Meal", mainOrMid: "main" })
    const heavy2 = makeRecipe({ name: "Gulab Jamun", category: "Dessert", mainOrMid: "mid" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: heavy1, grams: 200 }, { recipe: heavy2, grams: 50 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("stacks"))).toBe(true)
  })

  it("flags a diet-type-ineligible recipe as a defense-in-depth check", () => {
    const meatDish = makeRecipe({ name: "Chicken Curry", dietTypes: ["non_vegetarian"] })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: meatDish, grams: 100 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("not eligible for diet type"))).toBe(true)
  })

  it("flags a cuisine-ineligible recipe", () => {
    const foreign = makeRecipe({ name: "Sushi", cuisine: "Bengali" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: foreign, grams: 100 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("not eligible for the requested cuisine"))).toBe(true)
  })

  it("flags a recipe carrying a declared client allergen", () => {
    const nutty = makeRecipe({ name: "Peanut Chikki", allergenTags: ["peanuts"] })
    const day = makeDay([{ slot: "evening", items: [{ recipe: nutty, grams: 30 }] }])
    const withAllergy = { ...constraints, allergenTags: ["peanuts"] }
    expect(describePlausibilityProblems(day, withAllergy).some((p) => p.includes("declared allergen"))).toBe(true)
  })

  it("returns empty for a fully plausible day", () => {
    const roti = makeRecipe({ name: "Roti", category: "Roti/Paratha/Bread", mainOrMid: "mid" })
    const dal = makeRecipe({ name: "Dal", category: "Dal Curry", mainOrMid: "main" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: roti, grams: 60 }, { recipe: dal, grams: 150 }] }])
    expect(describePlausibilityProblems(day, constraints)).toEqual([])
  })

  it("flags lunch/dinner missing a staple dish (roti/rice)", () => {
    const dal = makeRecipe({ name: "Dal", category: "Dal Curry", mainOrMid: "main" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: dal, grams: 150 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("missing a staple dish"))).toBe(true)
  })

  it("flags lunch/dinner missing a dal/curry dish", () => {
    const roti = makeRecipe({ name: "Roti", category: "Roti/Paratha/Bread", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: roti, grams: 60 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("missing a Dal/Curry dish"))).toBe(true)
  })

  it("does not require a separate staple/dal when the meal is already a composite dish (Biryani, a Thali-style Heavy Meal row)", () => {
    const biryani = makeRecipe({ name: "Chicken Biryani", category: "Heavy Meal", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: biryani, grams: 300 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple") || p.includes("missing a Dal/Curry"))).toBe(false)
  })

  it("DOES require a separate staple when a 'Heavy Meal'-category dish is really a plain zero-carb protein main (real regression: Roasted Chicken, Grilled Chicken Breast are Category=Heavy Meal with C0/100g, not a composite meal)", () => {
    const roastedChicken = makeRecipe({ name: "Roasted Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0 })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: roastedChicken, grams: 120 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple dish"))).toBe(true)
  })

  it("does not flag a redundant staple when a zero-carb protein main (Roasted Chicken) is realistically paired with rice and dal", () => {
    const roastedChicken = makeRecipe({ name: "Roasted Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0 })
    const rice = makeRecipe({ name: "Rice", category: "Rice", mainOrMid: "main" })
    const dal = makeRecipe({ name: "Lentil Soup", category: "Dal", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: roastedChicken, grams: 120 }, { recipe: rice, grams: 200 }, { recipe: dal, grams: 150 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple") || p.includes("missing a Dal/Curry") || p.includes("already-complete dish"))).toBe(false)
  })

  it("does not require a separate Dal/Curry dish when a real non-veg/egg dish is present — it's its own protein course, same as the exchange engine's meat-vs-dal convention", () => {
    const chicken = makeRecipe({ name: "Roasted Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }, { recipe: roti, grams: 60 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a Dal/Curry"))).toBe(false)
    // Staple is still required — the exemption only ever waives the Dal/Curry half.
    expect(problems.some((p) => p.includes("missing a staple"))).toBe(false)
  })

  it("still requires a staple even with a real non-veg dish present — the exemption only waives Dal/Curry, not the staple", () => {
    const chicken = makeRecipe({ name: "Roasted Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple"))).toBe(true)
  })

  it("does NOT waive the Dal/Curry requirement for a vegetarian-eligible 'high protein' dish (e.g. Tofu Chilli) — the exemption is only for a real egg/meat/fish dish", () => {
    const tofuChilli = makeRecipe({ name: "Tofu Chilli", category: "High Protein Sabzi", mainOrMid: "main" })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: tofuChilli, grams: 100 }, { recipe: roti, grams: 60 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a Dal/Curry"))).toBe(true)
  })

  it("flags a real non-veg dish paired with a separate Dal — real regression, exact hand-built plan: Dahi Chicken + Wheat Bran Roti + Aloo Tamatar Sabzi With Gravy ('we cant give chicken like things meat with any sabzi and dal')", () => {
    const chicken = makeRecipe({ name: "Dahi Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 1.3, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Wheat Bran Roti", category: "Roti", mainOrMid: "main" })
    const sabzi = makeRecipe({ name: "Aloo Tamatar Sabzi With Gravy", category: "Sabzi", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 250 }, { recipe: roti, grams: 180 }, { recipe: sabzi, grams: 285 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("pairs a real non-veg/egg dish with a Sabzi/Dal"))).toBe(true)
  })

  it("flags a real non-veg dish paired with a separate Dal_curry-bucket item too, not just Sabzi", () => {
    const chicken = makeRecipe({ name: "Grilled Chicken Breast", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const dal = makeRecipe({ name: "Lentil Soup", category: "Dal", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }, { recipe: roti, grams: 60 }, { recipe: dal, grams: 150 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("pairs a real non-veg/egg dish with a Sabzi/Dal"))).toBe(true)
  })

  it("does NOT flag a real non-veg dish paired with just a staple and a Salad — a salad alongside meat is completely normal (the user's own stated first option)", () => {
    const chicken = makeRecipe({ name: "Grilled Chicken Breast", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const salad = makeRecipe({ name: "Garden Fresh Salad", category: "Light Salad", mainOrMid: "mid" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }, { recipe: roti, grams: 60 }, { recipe: salad, grams: 80 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("pairs a real non-veg/egg dish with a Sabzi/Dal"))).toBe(false)
  })

  it("does NOT flag a real non-veg dish paired with just a staple, no side at all — the user's second stated option ('optimize the quantity')", () => {
    const chicken = makeRecipe({ name: "Grilled Chicken Breast", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }, { recipe: roti, grams: 60 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("pairs a real non-veg/egg dish with a Sabzi/Dal"))).toBe(false)
  })

  it("does NOT flag a real curry-style non-veg dish (e.g. 'Chicken Curry', self-bucketed dal_curry via the curry-name reclassification) as conflicting with itself", () => {
    const chickenCurry = makeRecipe({ name: "Chicken Curry", category: "Sabzi", mainOrMid: "main", carbsPer100G: 5, dietTypes: ["non_vegetarian"] })
    const roti = makeRecipe({ name: "Roti", category: "Roti", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chickenCurry, grams: 200 }, { recipe: roti, grams: 60 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("pairs a real non-veg/egg dish with a Sabzi/Dal"))).toBe(false)
  })

  it("waives a staple's own 'needs Sabzi/Dal/Curry' must-have when a real non-veg dish is present — otherwise it could never be satisfied in a non-veg meal at all, now that Sabzi/Dal is hard-excluded from one", () => {
    const chicken = makeRecipe({ name: "Roasted Chicken", category: "Heavy Meal", mainOrMid: "main", carbsPer100G: 0, dietTypes: ["non_vegetarian"] })
    const wheatBranRoti = makeRecipe({ name: "Wheat Bran Roti", category: "Roti", mainOrMid: "main", mustHaveCategories: ["Sabzi", "High Protein Sabzi", "Dal", "Curry"] })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: chicken, grams: 120 }, { recipe: wheatBranRoti, grams: 60 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("needs one of"))).toBe(false)
  })

  it("does not require a separate staple/dal when the meal is a Khichdi-style self-contained dish", () => {
    const khichdi = makeRecipe({ name: "Sweet And Salty Khichdi", category: "Khichdi", mainOrMid: "main" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: khichdi, grams: 250 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple") || p.includes("missing a Dal/Curry"))).toBe(false)
  })

  it("flags a self-contained dish paired with a redundant separate staple — real regression, hand-built plan: 'no one eats ajwain paratha with khichdi and tofu chilla'", () => {
    const paratha = makeRecipe({ name: "Ajwain Paratha", category: "Paratha", mainOrMid: "main" })
    const khichdi = makeRecipe({ name: "Sweet And Salty Khichdi", category: "Khichdi", mainOrMid: "main" })
    const tofuChilli = makeRecipe({ name: "Tofu Chilli", category: "High Protein Sabzi", mainOrMid: "main" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: paratha, grams: 60 }, { recipe: khichdi, grams: 290 }, { recipe: tofuChilli, grams: 65 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("already-complete dish with a separate staple"))).toBe(true)
  })

  it("flags a Kadhi-with-rice dish paired with a redundant paratha — real regression: 'no one eats paneer paratha with this kuttu kadhi'", () => {
    const paneerParantha = makeRecipe({ name: "Paneer Parantha", category: "Paratha", mainOrMid: "main" })
    const kadhi = makeRecipe({ name: "Kuttu Kadhi With Samak Chawal", category: "Curry + Rice", mainOrMid: "main" })
    const day = makeDay([{ slot: "dinner", items: [{ recipe: paneerParantha, grams: 85 }, { recipe: kadhi, grams: 385 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("already-complete dish with a separate staple"))).toBe(true)
  })

  it("does not flag a self-contained dish paired with a non-staple side (sabzi, salad) — only a redundant staple is a problem", () => {
    const khichdi = makeRecipe({ name: "Sweet And Salty Khichdi", category: "Khichdi", mainOrMid: "main" })
    const salad = makeRecipe({ name: "Garden Fresh Salad", category: "Light Salad", mainOrMid: "mid" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: khichdi, grams: 250 }, { recipe: salad, grams: 80 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("already-complete dish"))).toBe(false)
  })

  it("does not require staple/dal at slots outside lunch/dinner", () => {
    const chai = makeRecipe({ name: "Masala Chai", category: "Beverage", mainOrMid: "main", consistency: "liquid" })
    const day = makeDay([{ slot: "evening", items: [{ recipe: chai, grams: 150 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("missing a staple") || p.includes("missing a Dal/Curry"))).toBe(false)
  })

  it("flags a liquid dish (Consistency=liquid) as the meal's main at lunch/dinner", () => {
    const soup = makeRecipe({ name: "Tomato Soup", category: "Light Soup", mainOrMid: "main", consistency: "liquid" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: soup, grams: 200 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("are liquid") && p.includes("Tomato Soup"))).toBe(true)
  })

  it("flags a soup/beverage-category main even when Consistency is null (Category bucket alone catches it)", () => {
    const soup = makeRecipe({ name: "Herbal Belly Tea", category: "Morning Water", mainOrMid: "main", consistency: null })
    const day = makeDay([{ slot: "breakfast", items: [{ recipe: soup, grams: 250 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("are liquid"))).toBe(true)
  })

  it("does NOT flag a genuinely solid dish whose Category text happens to match the beverage bucket (Cereal) — explicit consistency='solid' wins over the bucket guess", () => {
    // Real regression: recipeCategoryBucket("Cereal") maps to "beverage"
    // (for things like corn flakes), which was overriding an already-known
    // consistency="solid" value and false-flagging real dishes like "Oats
    // Toast"/"Tomato Basil Bruschetta" on a live generation run.
    const toast = makeRecipe({ name: "Oats Toast", category: "Cereal", mainOrMid: "main", consistency: "solid" })
    const day = makeDay([{ slot: "breakfast", items: [{ recipe: toast, grams: 100 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("are liquid"))).toBe(false)
  })

  it("does NOT flag a liquid dal (main-tagged) when a real solid main also anchors the same meal", () => {
    // Real regression, found on a live generation run: "Rice + Lentil Soup
    // (consistency=liquid) + Cauliflower Curry" was being rejected because
    // Lentil Soup alone was liquid — even though Rice already anchors the
    // meal perfectly well. A liquid dal served alongside rice/roti is
    // completely normal; the rule should only fire when EVERY main-tagged
    // item is liquid, never the moment any one of several is.
    const rice = makeRecipe({ name: "Rice", category: "Rice", mainOrMid: "main", consistency: "solid" })
    const dal = makeRecipe({ name: "Lentil Soup", category: "Dal", mainOrMid: "main", consistency: "liquid" })
    const sabzi = makeRecipe({ name: "Cauliflower Curry", category: "Sabzi", mainOrMid: "main", consistency: "solid" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: rice, grams: 200 }, { recipe: dal, grams: 150 }, { recipe: sabzi, grams: 150 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("are liquid"))).toBe(false)
  })

  it("does not flag a liquid main at mid_morning/evening/bedtime — chai-as-main is normal there", () => {
    const chai = makeRecipe({ name: "Masala Chai", category: "Beverage", mainOrMid: "main", consistency: "liquid" })
    for (const slot of ["mid_morning", "evening", "bedtime"]) {
      const day = makeDay([{ slot, items: [{ recipe: chai, grams: 150 }] }])
      expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("are liquid")), slot).toBe(false)
    }
  })

  it("flags a 'must have' pairing left unsatisfied by the rest of the meal", () => {
    const pulao = makeRecipe({ name: "Veg Pulao", category: "Pulao", mustHaveCategories: ["Raita"] })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: pulao, grams: 200 }] }])
    const problems = describePlausibilityProblems(day, constraints)
    expect(problems.some((p) => p.includes("Veg Pulao") && p.includes("needs one of") && p.includes("Raita"))).toBe(true)
  })

  it("does not flag a 'must have' pairing when a sibling item's category satisfies it", () => {
    const pulao = makeRecipe({ name: "Veg Pulao", category: "Pulao", mustHaveCategories: ["Raita"] })
    const raita = makeRecipe({ name: "Boondi Raita", category: "Raita" })
    const day = makeDay([{ slot: "lunch", items: [{ recipe: pulao, grams: 200 }, { recipe: raita, grams: 100 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("needs one of"))).toBe(false)
  })

  it("does not flag a 'must have' pairing when a sibling item's exact recipe name satisfies it (Must-have-recipe column)", () => {
    const bajra = makeRecipe({ name: "Masala Bajra", category: "Cereal", mustHaveRecipeNames: ["Mint Chutney", "Coriander Chutney"] })
    const chutney = makeRecipe({ name: "Mint Chutney", category: "Chutney" })
    const day = makeDay([{ slot: "breakfast", items: [{ recipe: bajra, grams: 100 }, { recipe: chutney, grams: 20 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("needs one of"))).toBe(false)
  })

  it("does not flag a recipe with no 'must have' data at all", () => {
    const roti = makeRecipe({ name: "Roti", category: "Roti/Paratha/Bread" })
    const day = makeDay([{ slot: "breakfast", items: [{ recipe: roti, grams: 40 }] }])
    expect(describePlausibilityProblems(day, constraints).some((p) => p.includes("needs one of"))).toBe(false)
  })
})
