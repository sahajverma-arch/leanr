/** Shared minimal Food/Recipe fixtures for plan/*.test.ts — not a production module. */

import type { Food, Recipe } from "@/db/schema"
import type { ExchangeCode } from "./table-4-1"

let counter = 0
let recipeCounter = 0

export function makeFood(overrides: Partial<Food> & { exchangeType: ExchangeCode }): Food {
  counter += 1
  return {
    id: overrides.id ?? `food-${counter}`,
    nameEn: overrides.nameEn ?? `Food ${counter}`,
    nameHi: null,
    exchangeUnits: 1,
    servingRawG: 20,
    householdMeasure: "1 portion",
    regions: ["north_indian"],
    dietTypes: ["vegetarian", "eggetarian", "non_vegetarian"],
    mealSlots: ["breakfast", "mid_morning", "lunch", "evening", "dinner"],
    allergens: [],
    tags: [],
    seasons: ["all_year"],
    isActive: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    dishFamilyId: null,
    ...overrides,
  }
}

export function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  recipeCounter += 1
  const proteinPer100G = overrides.proteinPer100G ?? 5
  const carbsPer100G = overrides.carbsPer100G ?? 15
  const fatPer100G = overrides.fatPer100G ?? 3
  return {
    id: overrides.id ?? `recipe-${recipeCounter}`,
    recipeId: overrides.recipeId ?? `csv-id-${recipeCounter}`,
    name: overrides.name ?? `Recipe ${recipeCounter}`,
    dietTypes: overrides.dietTypes ?? ["vegetarian", "eggetarian", "non_vegetarian", "vegan", "jain"],
    cuisine: overrides.cuisine ?? "General",
    category: overrides.category ?? "Sabzi",
    macroCategory: overrides.macroCategory ?? null,
    heavyLight: overrides.heavyLight ?? "light",
    // `?? "solid"` would silently replace an explicit `consistency: null`
    // override (a legitimate test value — "no data") with "solid", since
    // `??` treats null and undefined the same way — compare against
    // undefined directly instead, so an explicit null passes through.
    consistency: overrides.consistency === undefined ? "solid" : overrides.consistency,
    mainOrMid: overrides.mainOrMid ?? "main",
    commonality: overrides.commonality ?? 1,
    priority: overrides.priority ?? "primary",
    mustHaveCategories: overrides.mustHaveCategories ?? [],
    goodToHaveCategories: overrides.goodToHaveCategories ?? [],
    mustHaveRecipeNames: overrides.mustHaveRecipeNames ?? [],
    goodToHaveRecipeNames: overrides.goodToHaveRecipeNames ?? [],
    season: overrides.season ?? "all_year",
    allergenTags: overrides.allergenTags ?? [],
    minGrams: overrides.minGrams ?? 50,
    maxGrams: overrides.maxGrams ?? 300,
    idealGrams: overrides.idealGrams ?? 150,
    servingLimitsSource: overrides.servingLimitsSource ?? "computed",
    unitLabel: overrides.unitLabel ?? null,
    perUnitGrams: overrides.perUnitGrams ?? null,
    proteinPer100G,
    carbsPer100G,
    fatPer100G,
    fiberPer100G: overrides.fiberPer100G ?? 2,
    kcalPer100G: proteinPer100G * 4 + carbsPer100G * 4 + fatPer100G * 9,
    recipeUrl: overrides.recipeUrl ?? null,
    isActive: overrides.isActive ?? true,
    notes: overrides.notes ?? null,
    rawCsvRow: overrides.rawCsvRow ?? {},
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  }
}
