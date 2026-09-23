import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { parseCsvRows } from "./csv-parser"
import { detectRecipeAnimalContent, evidenceSafeDietTypes, isAnimalProteinRecipe, isRecipeAllowedForDiet } from "./recipe-animal-content"
import { classifyRecipeDietTypes } from "./recipe-diet-classifier"
import { normalizeRecipeAllergenTags } from "./recipe-allergen-normalize"
import { parseRecipeCsv } from "./recipe-csv-parser"
import { loadIngredientTextByRecipe } from "./recipe-ingredient-text"

const ALL = ["vegetarian", "eggetarian", "non_vegetarian", "vegan", "jain"]
const veg = (name: string, allergenTags: string[] = []) => ({ name, dietTypes: ALL, allergenTags })

describe("isRecipeAllowedForDiet — the real mislabelled dishes (2026-09-23)", () => {
  // Every one of these was labelled VEGETARIAN in the source CSV and served
  // to a vegetarian client. Each must be blocked by its NAME alone, even
  // with the allergen tags stripped — two independent signals, not one.
  const nonVegByName = [
    "Goan Fish Curry", "Low-Cal Fish Curry", "Fish Tikka", "Fish With Sauteed Vegetables",
    "Grilled Mahi-Mahi With Salsa Verde", "Tuna Chana Salad", "Salmon Salad", "Rui Macher Kalia",
    "Chital Macher Muitha", "Doi Ilish", "Begun Diye Ilish Macher Jhol", "Macher Matha Diye Dal",
    "Lau Chingri", "Daab Chingri", "Spicy Grilled Prawns Salad", "Pot Shrimps And Broccoli",
    "Mutton Kosha", "Subway Shami Kabab Sub", "Chicken Tikka", "Murgh Makhani", "Keema Pav",
  ]
  for (const name of nonVegByName) {
    it(`blocks "${name}" for vegetarian, vegan, jain and eggetarian`, () => {
      const r = veg(name)
      expect(isRecipeAllowedForDiet(r, "vegetarian")).toBe(false)
      expect(isRecipeAllowedForDiet(r, "vegan")).toBe(false)
      expect(isRecipeAllowedForDiet(r, "jain")).toBe(false)
      expect(isRecipeAllowedForDiet(r, "eggetarian")).toBe(false)
      expect(isRecipeAllowedForDiet(r, "non_vegetarian")).toBe(true)
    })
  }

  it("blocks a dish whose name says nothing, on its allergen tag alone (Muri Ghonto — fish head)", () => {
    expect(isRecipeAllowedForDiet(veg("Muri Ghonto", ["fish", "seafood"]), "vegetarian")).toBe(false)
  })

  it("keeps egg dishes for eggetarian but not vegetarian", () => {
    for (const name of ["Egg Bhurji", "Masala Omelette", "Acuri Eggs", "Egg Keema", "Boiled Egg Whites"]) {
      expect(isRecipeAllowedForDiet(veg(name), "vegetarian")).toBe(false)
      expect(isRecipeAllowedForDiet(veg(name), "eggetarian")).toBe(true)
    }
  })

  it("blocks an egg dish that also contains chicken from eggetarian (Egg Drop Soup)", () => {
    const r = { name: "Egg Drop Soup", dietTypes: ["eggetarian", "non_vegetarian"], allergenTags: ["egg"] }
    expect(evidenceSafeDietTypes(r.dietTypes, { ...r, ingredientsText: "Chicken stock - 2 cups | Egg - 1" })).toEqual([
      "non_vegetarian",
    ])
  })
})

describe("no false positives on real vegetarian names", () => {
  const stillVeg = [
    "Sauteed Veggies", "Grilled Veggies", "Baingan (Eggplant) Bharta", "Eggless Banana Cake", "Nutri Keema Pav",
    "Soya Keema", "Veg Seekh Kebab", "Chickpea Salad", "Hummus With Veggie Sticks", "Goat Cheese Salad",
    "Pakoda", "Vada Pav", "Paneer Tikka", "Macaroni Salad",
  ]
  for (const name of stillVeg) {
    it(`allows "${name}" for vegetarian`, () => {
      expect(isRecipeAllowedForDiet(veg(name), "vegetarian")).toBe(true)
    })
  }
})

describe("evidenceSafeDietTypes", () => {
  it("never adds a diet type the label did not have", () => {
    expect(evidenceSafeDietTypes(["non_vegetarian"], { name: "Aloo Gobi", allergenTags: [] })).toEqual(["non_vegetarian"])
  })
  it("drops vegan for a dish tagged lactose, and jain for one tagged onion/garlic", () => {
    expect(evidenceSafeDietTypes(ALL, { name: "Mooli Paratha", allergenTags: ["lactose", "onion_garlic"] })).toEqual([
      "vegetarian", "eggetarian", "non_vegetarian",
    ])
  })
  it("reads ingredient text when it is given", () => {
    const c = detectRecipeAnimalContent({ name: "Sauteed Vegetables", allergenTags: [], ingredientsText: "Paneer / Boiled Egg Whites - 1/2 cup" })
    expect(c.egg).toBe(true)
  })
  it("isAnimalProteinRecipe follows the evidence, not the label", () => {
    expect(isAnimalProteinRecipe(veg("Goan Fish Curry"))).toBe(true)
    expect(isAnimalProteinRecipe(veg("Dal Tadka"))).toBe(false)
  })
})

/**
 * Regression test over the REAL committed data: whatever the source CSV's
 * Diet Pref says, no recipe with fish, seafood, meat or egg evidence may come
 * out of ingestion eligible for a vegetarian. If a future CSV update brings
 * back a mislabelled dish, this fails before it can reach a client.
 */
describe("real recipe_database.csv + recipe_ingredients.csv", () => {
  const dir = join(process.cwd(), "src", "db", "seed-data")
  const parsed = parseRecipeCsv(readFileSync(join(dir, "recipe_database.csv"), "utf8"))
  const ingredientText = loadIngredientTextByRecipe(parseCsvRows(readFileSync(join(dir, "recipe_ingredients.csv"), "utf8")))

  const ingested = parsed.rows.map((row) => {
    const classification = classifyRecipeDietTypes(row.dietPrefRaw)
    const allergenTags = normalizeRecipeAllergenTags(row.allergenRaw).tags
    const ingredientsText = ingredientText.byId.get(row.recipeId) ?? ingredientText.byName.get(row.name.toLowerCase()) ?? null
    return {
      name: row.name,
      allergenTags,
      ingredientsText,
      dietTypes: evidenceSafeDietTypes(classification.dietTypes, { name: row.name, allergenTags, ingredientsText }),
    }
  })

  it("matches every recipe to an ingredient list (so the third signal is really there)", () => {
    expect(ingested.filter((r) => !r.ingredientsText).map((r) => r.name)).toEqual([])
  })

  it("leaves no vegetarian/vegan/jain dish with fish, seafood, meat or egg evidence", () => {
    const breaches = ingested.filter((r) => {
      const c = detectRecipeAnimalContent(r)
      const animal = c.meat || c.fish || c.egg
      return animal && (r.dietTypes.includes("vegetarian") || r.dietTypes.includes("vegan") || r.dietTypes.includes("jain"))
    })
    expect(breaches.map((r) => r.name)).toEqual([])
  })

  it("leaves no eggetarian dish with meat or fish evidence", () => {
    const breaches = ingested.filter((r) => {
      const c = detectRecipeAnimalContent(r)
      return (c.meat || c.fish) && r.dietTypes.includes("eggetarian")
    })
    expect(breaches.map((r) => r.name)).toEqual([])
  })

  it("blocks the 22 dishes the 2026-09-23 audit found mislabelled", () => {
    const byName = new Map(ingested.map((r) => [r.name, r]))
    const found = [
      "Rui Macher Kalia", "Grilled Mahi-Mahi With Salsa Verde", "Lau Chingri", "Tuna Chana Salad", "Subway Shami Kabab Sub",
      "Fish With Sauteed Vegetables", "Chital Macher Muitha", "Daab Chingri", "Low-Cal Fish Curry", "Mutton Kosha",
      "Sauteed Vegetables", "Fish Tikka", "Begun Diye Ilish Macher Jhol", "Salmon Salad", "Goan Fish Curry", "Muri Ghonto",
      "Spicy Grilled Prawns Salad", "Pot Shrimps And Broccoli", "Doi Ilish", "Macher Matha Diye Dal",
    ]
    for (const name of found) {
      const r = byName.get(name)
      expect(r, name).toBeDefined()
      expect(r!.dietTypes.includes("vegetarian"), name).toBe(false)
    }
    for (const name of ["Egg Drop Soup", "Egg And Chicken Soup"]) {
      expect(byName.get(name)!.dietTypes, name).toEqual(["non_vegetarian"])
    }
  })

  it("still leaves a healthy vegetarian pool", () => {
    expect(ingested.filter((r) => r.dietTypes.includes("vegetarian")).length).toBeGreaterThan(1000)
  })
})
