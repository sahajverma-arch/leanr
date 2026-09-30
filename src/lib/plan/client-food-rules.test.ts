import { describe, expect, it } from "vitest"

import type { Answers } from "@/lib/counselling/questions"

import { clientFoodRules, foodRuleViolation, recipeRuleViolation } from "./client-food-rules"

const ALL = ["vegetarian", "eggetarian", "non_vegetarian"]
const dish = (name: string, dietTypes: string[] = ALL, allergenTags: string[] = []) => ({ name, dietTypes, allergenTags })
const vegetarian = { q33: "Vegetarian" } as unknown as Answers

describe("a vegetarian client can never be given non-veg, whatever the dietitian picks", () => {
  const rules = clientFoodRules(vegetarian, "vegetarian")

  it.each([
    dish("Chicken Tikka", ["non_vegetarian"]),
    dish("Egg Bhurji", ["eggetarian", "non_vegetarian"]),
    // Mislabelled vegetarian in the source CSV — caught by its own name.
    dish("Goan Fish Curry", ALL),
    dish("Mutton Kosha", ["vegetarian", "vegan"]),
  ])("refuses $name", (r) => {
    expect(recipeRuleViolation(r, rules)).toMatch(/not suitable for a vegetarian client/)
  })

  it("allows ordinary vegetarian food", () => {
    expect(recipeRuleViolation(dish("Dal Tadka"), rules)).toBeNull()
    expect(recipeRuleViolation(dish("Paneer Bhurji"), rules)).toBeNull()
  })

  it("a plan labelled non-vegetarian still refuses chicken once the client's answer says vegetarian", () => {
    const stale = clientFoodRules(vegetarian, "non_vegetarian")
    expect(stale.dietTypes.sort()).toEqual(["non_vegetarian", "vegetarian"])
    expect(recipeRuleViolation(dish("Chicken Curry", ["non_vegetarian"]), stale)).toMatch(/vegetarian/)
  })
})

describe("a food the client said they don't want cannot be put back by editing", () => {
  const rules = clientFoodRules({ q33: "Vegetarian", q36: "Soya chunks, lauki" } as unknown as Answers, "vegetarian")

  it("refuses the disliked dish under any of its names", () => {
    expect(recipeRuleViolation(dish("Soya Matar Sabzi Dry"), rules)).toMatch(/Soya chunks/)
    expect(recipeRuleViolation(dish("Nutri Pulav"), rules)).toMatch(/Soya chunks/)
    expect(recipeRuleViolation(dish("Tofu Bhurji"), rules)).toBeNull()
    expect(recipeRuleViolation(dish("Bottle Gourd Raita"), rules)).toMatch(/lauki/)
  })

  it("refuses a declared allergen even when the source never tagged it", () => {
    const allergic = clientFoodRules(
      { q33: "Vegetarian", q27: ["Peanut", "Soy"], q27_peanut_type: "Allergy — never serve", q27_soy_type: "Allergy — never serve" } as unknown as Answers,
      "vegetarian"
    )
    expect(recipeRuleViolation(dish("Peanut Chikki", ALL, ["peanuts"]), allergic)).toMatch(/peanuts/)
    expect(recipeRuleViolation(dish("Chilli Soya"), allergic)).toMatch(/soy/)
  })
})

describe("exchange-engine foods follow the same rules", () => {
  const rules = clientFoodRules(
    { q33: "Vegetarian", q36: "karela", q27: ["Milk"], q27_milk_type: "Allergy — never serve" } as unknown as Answers,
    "vegetarian"
  )
  const food = (nameEn: string, dietTypes: string[] = ALL, allergens: string[] = []) => ({ nameEn, dietTypes, allergens })

  it("refuses non-veg, a declared allergen, and a dislike", () => {
    expect(foodRuleViolation(food("Chicken breast", ["non_vegetarian"]), rules)).toMatch(/vegetarian/)
    expect(foodRuleViolation(food("Milk", ALL, ["dairy"]), rules)).toMatch(/dairy/)
    expect(foodRuleViolation(food("Karela Sabzi"), rules)).toMatch(/karela/)
    expect(foodRuleViolation(food("Moong dal"), rules)).toBeNull()
  })
})
