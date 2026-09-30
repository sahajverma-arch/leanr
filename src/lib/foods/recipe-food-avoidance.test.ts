import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import type { Answers } from "@/lib/counselling/questions"
import { clientRecipeAllergenTagsFromAnswers, clientRecipeAvoidTermsFromAnswers } from "@/lib/plan/client-profile-from-answers"

import { parseCsvRows } from "./csv-parser"
import { parseRecipeCsv } from "./recipe-csv-parser"
import {
  allergenTagsFromText,
  compileAvoidTerms,
  effectiveRecipeAllergenTags,
  recipeAvoidanceConflict,
  splitAvoidTerms,
} from "./recipe-food-avoidance"
import { loadIngredientTextByRecipe } from "./recipe-ingredient-text"

const dish = (name: string, allergenTags: string[] = []) => ({ name, allergenTags })
const avoids = (raw: string, name: string) => recipeAvoidanceConflict(dish(name), [], compileAvoidTerms([raw])) !== null

describe("the real case (2026-09-30): q36 = 'Soya chunks ', vegetarian", () => {
  // Every soya dish this client was actually served, with the tags they
  // really carry — none of which says soy.
  const served = [
    dish("Soya Matar Sabzi Dry", ["onion_garlic"]),
    dish("Tofu Bhurji", ["lactose", "onion_garlic"]),
    dish("Tofu Shirataki Rice Pulao", ["onion_garlic", "lactose"]),
    dish("Tofu Do Pyaza", ["onion_garlic"]),
  ]
  const terms = compileAvoidTerms(["Soya chunks "])

  it.each(served)("keeps $name off the plate", (r) => {
    expect(recipeAvoidanceConflict(r, [], terms)).toMatch(/Soya chunks/)
  })

  it("catches soya by any of its names", () => {
    for (const name of ["Nutri Pulav", "Nutri Soya Tikki", "Soybean Salad", "Soya Momos", "Soybean Dal Chaat"]) {
      expect(avoids("Soya chunks", name), name).toBe(true)
    }
  })

  it("does not touch unrelated dishes", () => {
    for (const name of ["Matar Paneer", "Dal Tadka", "Nutritious Poha Bowl", "Jeera Rice"]) {
      expect(avoids("Soya chunks", name), name).toBe(false)
    }
  })
})

describe("compileAvoidTerms", () => {
  it("splits several foods in one answer and drops filler", () => {
    expect(splitAvoidTerms(["Soya chunks and paneer / lauki; I don't like karela"])).toEqual([
      "Soya chunks",
      "paneer",
      "lauki",
      "karela",
    ])
  })

  it("treats non-answers as nothing", () => {
    expect(compileAvoidTerms(["None", "no", "NA", "-", "Nothing"])).toEqual([])
  })

  it("knows regional and English names for the same food", () => {
    expect(avoids("lauki", "Bottle Gourd Raita")).toBe(true)
    expect(avoids("bottle gourd", "Lauki Chana Dal")).toBe(true)
    expect(avoids("brinjal", "Baingan Bharta")).toBe(true)
    expect(avoids("okra", "Bhindi Masala")).toBe(true)
    expect(avoids("paneer", "Cottage Cheese Salad")).toBe(true)
  })

  it("tofu alone excludes tofu, not all soya", () => {
    expect(avoids("tofu", "Tofu Bhurji")).toBe(true)
    expect(avoids("tofu", "Soya Matar Sabzi Dry")).toBe(false)
  })

  it("matches an unlisted food literally, whole-word, singular or plural", () => {
    expect(avoids("tomatoes", "Tomato Soup")).toBe(true)
    expect(avoids("mango", "Mangoes With Curd")).toBe(true)
    expect(avoids("pea", "Peanut Chikki")).toBe(false)
  })

  it("does not read 'egg' inside 'eggplant'", () => {
    expect(avoids("egg", "Egg Bhurji")).toBe(true)
    expect(avoids("egg", "Eggless Cake")).toBe(false)
  })
})

describe("soy and sesame allergies", () => {
  it("the q27 Soy/Sesame allergy now maps to a tag", () => {
    const answers = { q27: ["Soy", "Sesame"], q27_soy_type: "Allergy — never serve", q27_sesame_type: "Allergy — never serve" } as Answers
    expect(clientRecipeAllergenTagsFromAnswers(answers).sort()).toEqual(["sesame", "soy"])
  })

  it("an intolerance is not a hard exclusion", () => {
    const answers = { q27: ["Soy"], q27_soy_type: "Intolerance" } as unknown as Answers
    expect(clientRecipeAllergenTagsFromAnswers(answers)).toEqual([])
  })

  it("a soya dish is refused for a soy allergy even though the CSV never tagged it", () => {
    expect(effectiveRecipeAllergenTags(dish("Soya Matar Sabzi Dry", ["onion_garlic"]))).toContain("soy")
    expect(recipeAvoidanceConflict(dish("Soya Matar Sabzi Dry", ["onion_garlic"]), ["soy"], [])).toMatch(/soy/)
    expect(recipeAvoidanceConflict(dish("Til Ladoo"), ["sesame"], [])).toMatch(/sesame/)
    expect(recipeAvoidanceConflict(dish("Dal Tadka"), ["soy"], [])).toBeNull()
  })

  it("ingredient text is evidence too (used at ingestion)", () => {
    expect(allergenTagsFromText("Egg Rice | Vegetable oil or sesame oil - 1 tsp, soy sauce - 1 tsp")).toEqual(["soy", "sesame"])
  })
})

describe("clientRecipeAvoidTermsFromAnswers", () => {
  it("takes q36 and the name of an 'Other' allergy", () => {
    const answers = { q36: "Soya chunks", q27: ["Other"], q27_other_type: "Allergy — never serve", q27c: "Mushroom" } as unknown as Answers
    expect(clientRecipeAvoidTermsFromAnswers(answers)).toEqual(["Soya chunks", "Mushroom"])
  })

  it("ignores an 'Other' food that is only an intolerance", () => {
    const answers = { q27: ["Other"], q27_other_type: "Intolerance", q27c: "Mushroom" } as unknown as Answers
    expect(clientRecipeAvoidTermsFromAnswers(answers)).toEqual([])
  })
})

describe("against the committed recipe CSVs", () => {
  const dir = join(process.cwd(), "src/db/seed-data")
  const parsed = parseRecipeCsv(readFileSync(join(dir, "recipe_database.csv"), "utf8"))
  const ingredientText = loadIngredientTextByRecipe(parseCsvRows(readFileSync(join(dir, "recipe_ingredients.csv"), "utf8")))

  it("every dish named for soya or tofu is kept from a 'soya' dislike", () => {
    const terms = compileAvoidTerms(["soya"])
    const named = parsed.rows.filter((r) => /\b(soy|soya|soybean|tofu|nutri)\b/i.test(r.name))
    expect(named.length).toBeGreaterThan(10)
    for (const r of named) expect(recipeAvoidanceConflict(dish(r.name), [], terms), r.name).not.toBeNull()
  })

  it("ingestion finds soy that neither the name nor the Allergen column shows", () => {
    const hidden = parsed.rows.filter((r) => {
      const text = ingredientText.byId.get(r.recipeId) ?? ingredientText.byName.get(r.name.toLowerCase()) ?? ""
      return allergenTagsFromText(text).includes("soy") && !allergenTagsFromText(r.name).includes("soy")
    })
    expect(hidden.length).toBeGreaterThan(0)
  })
})
