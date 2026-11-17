/**
 * Recipe repetition is tracked and enforced in code, not left as a hopeful
 * prompt instruction alone (the prompt states the same rules as a first line
 * of defense — see recipe-prompt.ts — and recipe-repair.ts's variety pass
 * swaps out whatever still breaks them).
 *
 * FOUR CAPS, NOT ONE. A single "no recipe more than twice a week" cap was
 * the rule, and measured over 24 real saved plans it was broken on every
 * single one: plain Roti landed 5-8 times a week, Curd up to 10. A North
 * Indian client eating roti most days is normal home food, not a variety
 * failure, so the warning fired on every plan and stopped meaning anything —
 * while the real repetition (Rajma Curry four times in one week, the same
 * rajma/chole/kala chana rotation for every client) sat in the same noise.
 *
 * So (2026-09-29) an everyday base or side — a plain roti or rice, plain
 * curd, or any MID accompaniment (chutney, chaas, a piece of fruit) — may
 * appear up to MAX_STAPLE_REPEATS_PER_WEEK times, and every actual dish keeps
 * the cap of 2, and may not appear on consecutive days or twice on one day.
 *
 * Then (2026-11-03) a dietitian found "the same sabzis and salads are still
 * being repeated throughout the week, about 2-3 times". Measured on the 12
 * plans saved since 13 Oct: a sabzi twice in 11 of 52 cases, a salad or
 * raita 3-4 times in 15 of 115 — all INSIDE the caps above, so nothing
 * corrected them. A sabzi is now once a week, a salad or flavoured raita at
 * most twice (and never two days running). Plain Curd stays a staple side:
 * curd beside roti is how the dietitian asked a meal to be filled out.
 */

import { recipeCategoryBucket } from "./recipe-category"
import type { GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"

/** A distinct dish (dal, curry, paratha, chilla, snack): at most twice a week. */
export const MAX_RECIPE_REPEATS_PER_WEEK = 2

/**
 * A plain roti/rice, plain curd, or a mid accompaniment (chutney, chaas,
 * fruit): at most this many times a week. 4, not 7: the plate should still
 * rotate between plain, missi, bajra and jowar roti, or rice and jeera rice,
 * rather than serving the identical base every meal.
 */
export const MAX_STAPLE_REPEATS_PER_WEEK = 4

/** A sabzi (dry vegetable dish, paneer/tofu bhurji included): once a week. */
export const MAX_SABZI_REPEATS_PER_WEEK = 1

/** A salad or a flavoured raita (not plain curd): at most twice a week. */
export const MAX_SALAD_REPEATS_PER_WEEK = 2

/**
 * The raw CSV Category values that mean "a plain everyday base". Exact
 * matches only: "Paratha", "Pulao", "Biryani" are real dishes and keep the
 * dish cap. Checked against the real data: Roti, Jaun Roti, Bajra Roti,
 * Missi Roti are all "Roti"; Rice, Jeera Rice, Brown Rice are all "Rice".
 */
const STAPLE_CATEGORIES = new Set(["roti", "rice"])

/** The one Raita-category row that is plain curd rather than a dish of its own. */
const PLAIN_CURD_NAME = /^(plain )?curd$/i

type VarietyRecipe = Pick<RecipeForPipeline, "name" | "category" | "mainOrMid">

export type VarietyClass = "staple" | "sabzi" | "salad" | "dish"

export function isPlainCurd(recipe: VarietyRecipe): boolean {
  return recipe.category.trim().toLowerCase() === "raita" && PLAIN_CURD_NAME.test(recipe.name.trim())
}

/** Which repeat rule a recipe falls under — see the file comment. */
export function varietyClassOf(recipe: VarietyRecipe): VarietyClass {
  const bucket = recipeCategoryBucket(recipe.category, recipe.name)
  if (bucket === "sabzi") return "sabzi"
  if (bucket === "salad") return isPlainCurd(recipe) ? "staple" : "salad"
  if (recipe.mainOrMid === "mid" || STAPLE_CATEGORIES.has(recipe.category.trim().toLowerCase())) return "staple"
  return "dish"
}

/** A plain base or side that may repeat through the week without being "the same dish again". */
export function isEverydayStaple(recipe: VarietyRecipe): boolean {
  return varietyClassOf(recipe) === "staple"
}

export function repeatCapFor(recipe: VarietyRecipe): number {
  switch (varietyClassOf(recipe)) {
    case "staple":
      return MAX_STAPLE_REPEATS_PER_WEEK
    case "sabzi":
      return MAX_SABZI_REPEATS_PER_WEEK
    case "salad":
      return MAX_SALAD_REPEATS_PER_WEEK
    default:
      return MAX_RECIPE_REPEATS_PER_WEEK
  }
}

export function trackRecipeUsage(days: GroundedRecipeDay[]): Map<string, number> {
  const usage = new Map<string, number>()
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        usage.set(item.recipe.id, (usage.get(item.recipe.id) ?? 0) + 1)
      }
    }
  }
  return usage
}

export interface VarietyViolation {
  recipeId: string
  name: string
  count: number
  cap: number
}

export function findVarietyViolations(days: GroundedRecipeDay[]): VarietyViolation[] {
  const usage = trackRecipeUsage(days)
  const recipeById = new Map<string, VarietyRecipe>()
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        recipeById.set(item.recipe.id, item.recipe)
      }
    }
  }

  const violations: VarietyViolation[] = []
  for (const [recipeId, count] of usage) {
    const recipe = recipeById.get(recipeId)
    if (!recipe) continue
    const cap = repeatCapFor(recipe)
    if (count > cap) violations.push({ recipeId, name: recipe.name, count, cap })
  }
  return violations
}

export interface BackToBackRepeat {
  dayIndex: number
  name: string
}

/**
 * A dish (not a staple) served on two consecutive days, or twice on one day
 * (Rajma at lunch AND dinner). Reported once per offending later occurrence.
 * This is the "every day looks the same" pattern a weekly count alone misses:
 * a dish used twice is within the cap, but not on Monday and Tuesday.
 */
export function findBackToBackRepeats(days: GroundedRecipeDay[]): BackToBackRepeat[] {
  const sorted = [...days].sort((a, b) => a.dayIndex - b.dayIndex)
  const repeats: BackToBackRepeat[] = []
  let previousDayIds = new Set<string>()
  for (const day of sorted) {
    const todayIds = new Set<string>()
    for (const meal of day.meals) {
      for (const item of meal.items) {
        if (isEverydayStaple(item.recipe)) continue
        if (todayIds.has(item.recipe.id) || previousDayIds.has(item.recipe.id)) {
          repeats.push({ dayIndex: day.dayIndex, name: item.recipe.name })
        }
        todayIds.add(item.recipe.id)
      }
    }
    previousDayIds = todayIds
  }
  return repeats
}

/**
 * Which specific days need a variety retry: computed once after the
 * whole-week initial grounding (a genuinely week-level signal, unlike the
 * per-day macro/plausibility checks) — a day is flagged the moment a
 * recipe's cumulative count (in day order) exceeds its cap on that day,
 * not for every day the recipe subsequently appears again.
 */
export function findDaysNeedingVarietyRetry(days: GroundedRecipeDay[]): Set<number> {
  const seenCount = new Map<string, number>()
  const daysToRetry = new Set<number>()
  const sortedDays = [...days].sort((a, b) => a.dayIndex - b.dayIndex)
  for (const day of sortedDays) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        const count = (seenCount.get(item.recipe.id) ?? 0) + 1
        seenCount.set(item.recipe.id, count)
        if (count > repeatCapFor(item.recipe)) daysToRetry.add(day.dayIndex)
      }
    }
  }
  return daysToRetry
}
