/**
 * Swapping one recipe in a saved plan.
 *
 * WHY THIS IS NOT THE SAME AS AN EXCHANGE-ENGINE SWAP. There, a swap keeps
 * the exchange type and count, so the macros are unchanged by construction
 * and only the food's identity and gram weight move. Here, replacing recipe A
 * with recipe B changes the day's macros outright — B has entirely different
 * per-100g figures and its own serving range. The grams of EVERY item in that
 * day therefore have to be re-optimised together, because recipe-balancer.ts
 * solves a day as a whole, not an item at a time.
 *
 * So a swap is: substitute the recipe, re-balance that day, recompute the
 * day's achieved macros, then recompute the plan's weekly average, deviation
 * and warnings. Nothing here lets a number drift — every gram still comes out
 * of the same deterministic balancer the generator uses, and the LLM is not
 * involved at all (see CLAUDE.md "THE ONE RULE THAT MATTERS").
 */

import { balanceDayToTargets } from "./recipe-balancer"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeAchievedMacros, RecipeForPipeline } from "./recipe-types"

/** One saved item, as stored: a recipe reference plus the macros snapshotted when the plan was generated. */
export interface StoredRecipeItem {
  id: string
  grams: number
  recipe: RecipeForPipeline
  proteinPer100GSnapshot: number
  carbsPer100GSnapshot: number
  fatPer100GSnapshot: number
  fiberPer100GSnapshot: number
}

export interface StoredRecipeMeal {
  slot: string
  items: StoredRecipeItem[]
}

/**
 * Rebuilds a day in the shape the balancer expects, from stored rows.
 *
 * Each item keeps its OWN SNAPSHOT macros rather than the live `recipes`
 * values — a plan's displayed numbers must not silently change because the
 * CSV was re-ingested since it was generated, which is the entire reason the
 * snapshot columns exist. The live row is still used for the serving range
 * (`minGrams`/`maxGrams`/`idealGrams`), which is not snapshotted and is a
 * property of the dish rather than of this plan.
 *
 * kcal is recomputed from the snapshot macros by Atwater rather than read
 * from the live row, so it can never disagree with the macros beside it —
 * the same discipline `recipes.kcal_per_100g` uses as a generated column.
 */
export function toBalanceableDay(dayIndex: number, meals: StoredRecipeMeal[]): GroundedRecipeDay {
  return {
    dayIndex,
    meals: meals.map((meal) => ({
      slot: meal.slot,
      items: meal.items.map((item) => ({
        grams: item.grams,
        recipe: {
          ...item.recipe,
          proteinPer100G: item.proteinPer100GSnapshot,
          carbsPer100G: item.carbsPer100GSnapshot,
          fatPer100G: item.fatPer100GSnapshot,
          fiberPer100G: item.fiberPer100GSnapshot,
          kcalPer100G:
            item.proteinPer100GSnapshot * 4 + item.carbsPer100GSnapshot * 4 + item.fatPer100GSnapshot * 9,
        },
      })),
    })),
    totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
    unknownRecipeNames: [],
    cappedRecipeNames: [],
  } as unknown as GroundedRecipeDay
}

/** Re-optimises every gram in the day against the client's target. Item identity is untouched; only grams move. */
export function rebalanceDay(dayIndex: number, meals: StoredRecipeMeal[], target: DailyRecipeTarget): GroundedRecipeDay {
  return balanceDayToTargets(toBalanceableDay(dayIndex, meals), target)
}

/**
 * The plan-level figure after an edit: the mean of the days' achieved macros.
 *
 * Deliberately the weekly AVERAGE, matching what generation stores and what
 * the best-of-N gate measures — a swap must not quietly change the meaning of
 * `diet_plans.achieved` from "the week" to "one day".
 */
export function weeklyAverageOf(dayTotals: RecipeAchievedMacros[]): RecipeAchievedMacros {
  const n = dayTotals.length || 1
  return {
    kcal: dayTotals.reduce((s, d) => s + d.kcal, 0) / n,
    proteinG: dayTotals.reduce((s, d) => s + d.proteinG, 0) / n,
    carbsG: dayTotals.reduce((s, d) => s + d.carbsG, 0) / n,
    fatG: dayTotals.reduce((s, d) => s + d.fatG, 0) / n,
    fiberG: dayTotals.reduce((s, d) => s + d.fiberG, 0) / n,
  }
}

/** Signed fractional deviation per macro, the shape `diet_plans.deviation` already stores. */
export function deviationOf(achieved: RecipeAchievedMacros, target: DailyRecipeTarget) {
  const dev = (a: number, t: number) => (t === 0 ? 0 : (a - t) / t)
  return {
    kcal: dev(achieved.kcal, target.kcal),
    proteinG: dev(achieved.proteinG, target.proteinG),
    carbsG: dev(achieved.carbsG, target.carbsG),
    fatG: dev(achieved.fatG, target.fatG),
  }
}
