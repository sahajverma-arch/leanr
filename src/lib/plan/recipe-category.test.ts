import { describe, expect, it } from "vitest"

import { recipeCategoryBucket } from "./recipe-category"

describe("recipeCategoryBucket", () => {
  it("buckets real category strings correctly", () => {
    expect(recipeCategoryBucket("Heavy Meal")).toBe("heavy_meal")
    expect(recipeCategoryBucket("Light Meal")).toBe("light_meal")
    expect(recipeCategoryBucket("Sabzi")).toBe("sabzi")
    expect(recipeCategoryBucket("Dal Curry")).toBe("dal_curry")
    expect(recipeCategoryBucket("Khichdi")).toBe("dal_curry")
    expect(recipeCategoryBucket("Pulao")).toBe("rice_pulao")
    expect(recipeCategoryBucket("Biryani")).toBe("rice_pulao")
    expect(recipeCategoryBucket("Paratha")).toBe("bread")
    expect(recipeCategoryBucket("Sandwich")).toBe("bread")
    expect(recipeCategoryBucket("Chaat")).toBe("snack")
    expect(recipeCategoryBucket("Dessert")).toBe("dessert")
    expect(recipeCategoryBucket("Salad")).toBe("salad")
    expect(recipeCategoryBucket("Raita")).toBe("salad")
    expect(recipeCategoryBucket("Soup")).toBe("soup")
    expect(recipeCategoryBucket("Smoothie")).toBe("beverage")
    expect(recipeCategoryBucket("Fruit")).toBe("fruit")
  })

  it("is case-insensitive", () => {
    expect(recipeCategoryBucket("HEAVY MEAL")).toBe("heavy_meal")
  })

  it("falls back to other for an unrecognized category", () => {
    expect(recipeCategoryBucket("Something Entirely Novel")).toBe("other")
  })

  it("buckets spreads, chutneys and dips as condiments, and nuts/seeds as nuts — never beside porridges in 'other'", () => {
    expect(recipeCategoryBucket("Spread", "Peanut Butter")).toBe("condiment")
    expect(recipeCategoryBucket("Chutney", "Mint Chutney")).toBe("condiment")
    expect(recipeCategoryBucket("Dip", "Hummus")).toBe("condiment")
    expect(recipeCategoryBucket("Nuts", "3 Soaked Walnuts")).toBe("nuts")
    expect(recipeCategoryBucket("Seeds", "Fitelo Chia Seeds")).toBe("nuts")
    expect(recipeCategoryBucket("Khichdi", "Oatmeal Peanut Butter Porridge")).toBe("other")
  })

  it("buckets a 'Sabzi'-category dish named '...Curry' as dal_curry (real regression: Rajma Curry, Kala Chana Curry, White Chana Curry are all Category=Sabzi)", () => {
    expect(recipeCategoryBucket("Sabzi", "Rajma Curry")).toBe("dal_curry")
    expect(recipeCategoryBucket("Sabzi", "Kala Chana Curry")).toBe("dal_curry")
    expect(recipeCategoryBucket("Sabzi", "Cauliflower Curry")).toBe("dal_curry")
  })

  it("keeps a genuinely dry 'Sabzi'-category dish (no 'curry' in the name) bucketed as sabzi", () => {
    expect(recipeCategoryBucket("Sabzi", "Karela Sabzi")).toBe("sabzi")
    expect(recipeCategoryBucket("Sabzi", "Bhindi Masala")).toBe("sabzi")
  })

  it("still buckets Sabzi as sabzi when no name is supplied (backward compatible)", () => {
    expect(recipeCategoryBucket("Sabzi")).toBe("sabzi")
  })

  it("matches the curry-name check case-insensitively", () => {
    expect(recipeCategoryBucket("Sabzi", "rajma CURRY")).toBe("dal_curry")
  })
})
