import { recipeCategoryBucket } from "./recipe-category"
import { STAPLE_BUCKETS, STRUCTURED_MEAL_SLOTS } from "./recipe-meal-structure"
import type { RecipeForPipeline as Recipe } from "./recipe-types"

/**
 * A thin field read, not a name-pattern heuristic — unlike the deleted dish
 * engine's dish-serving-limits.ts (SERVING_RULES regex matching), the
 * richer recipe dataset already computed real min/max/ideal grams at
 * ingestion time (recipe-quantity-normalize.ts) and stored them directly on
 * the recipe row. This file exists only so recipe-balancer.ts has the same
 * small interface the dish engine's balancer used.
 */
export interface ServingLimitsG {
  min: number
  max: number
  ideal: number
}

export function getServingLimitsG(recipe: Recipe): ServingLimitsG {
  return { min: recipe.minGrams, max: recipe.maxGrams, ideal: recipe.idealGrams }
}

/**
 * Rotis a lunch or dinner serves at the least when roti is its only staple.
 * The authored range of a plain roti starts at ONE piece (Roti 40-120 g), and
 * the balancer, trimming carbs, parked 109 of 203 lunch/dinner roti servings
 * on the saved plans at a single roti. Nobody eats one roti with dal and
 * sabzi as their lunch; the day's calories are taken out of other dishes
 * instead. A meal that also has rice keeps the authored minimum, since one
 * roti beside a bowl of rice is a normal plate.
 */
export const MIN_ROTIS_AS_ONLY_STAPLE = 2

const ROTI_CATEGORY = /roti|paratha|thepla|bhakri|phulka|chapati/i

/**
 * The serving range of one dish IN ITS MEAL. Only ever raises the minimum,
 * and never past the dish's own authored maximum.
 */
export function getMealServingLimitsG(recipe: Recipe, slot: string, mealRecipes: readonly Recipe[]): ServingLimitsG {
  const limits = getServingLimitsG(recipe)
  if (!STRUCTURED_MEAL_SLOTS.has(slot) || !isCountedRoti(recipe)) return limits
  const otherStaple = mealRecipes.some(
    (other) => other !== recipe && STAPLE_BUCKETS.has(recipeCategoryBucket(other.category, other.name)) && !isCountedRoti(other)
  )
  if (otherStaple) return limits
  const floor = Math.min(MIN_ROTIS_AS_ONLY_STAPLE * (recipe.perUnitGrams ?? 0), limits.max)
  return floor > limits.min ? { ...limits, min: floor, ideal: Math.max(limits.ideal, floor) } : limits
}

/** A roti-style flatbread counted by the piece — what "two rotis" can be said of. */
function isCountedRoti(recipe: Recipe): boolean {
  return recipe.unitLabel === "piece" && (recipe.perUnitGrams ?? 0) > 0 && ROTI_CATEGORY.test(recipe.category)
}
