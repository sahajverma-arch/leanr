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
