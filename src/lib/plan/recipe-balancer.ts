/**
 * Box-constrained weighted least-squares quantity optimizer (Lee–Seung
 * multiplicative update) — direct descendant of the deleted dish engine's
 * balanceDayToTargets(), adapted for a 5th macro (fiber, lightly weighted —
 * steered toward, never gates, see recipe-validate.ts). Runs ONCE PER DAY,
 * pooling every recipe across every meal that day against the day's 5
 * targets (day-level, matching spec point 6's "optimize the ENTIRE DAY").
 *
 * Seeded at x0 = recipe.idealGrams (the recipe's own authored typical
 * portion) rather than an LLM guess — the LLM never proposes a gram figure
 * at all, a materially better starting point than the dish engine had.
 * Hard-clamped every iteration to each recipe's real, authored
 * [minGrams, maxGrams] — never a fabricated or unrealistically stretched
 * portion. A recipe landing at its real limit without closing the gap is
 * recorded in cappedRecipeNames, feeding the day-retry diagnosis ("add
 * another dish", never "make this one unrealistically bigger").
 *
 * LOCKED ITEMS. An item carrying `gramsLocked` is one a dietitian set by
 * hand on the plan page. Its grams are held EXACTLY as given - not updated,
 * not clamped to the authored serving range, not rounded to the 5 g grid -
 * while still counting in full toward the day's predicted macros, so every
 * other item is re-optimised around it. That is what "make it three rotis"
 * has to mean: the dietitian's number stands and the rest of the day absorbs
 * it. A locked item is also never reported in cappedRecipeNames - sitting at
 * or past a serving limit is a deliberate instruction there, not a solver
 * failure worth telling anyone about.
 *
 * Generation never sets the flag; every gram it writes is solver-owned,
 * exactly as before locking existed.
 */

import type { DailyRecipeTarget, GroundedRecipeDay, GroundedRecipeMeal } from "./recipe-types"
import { computeMealsTotals } from "./recipe-grounding"
import { getServingLimitsG } from "./recipe-serving-limits"

const WEIGHTS = { kcal: 0.4, proteinG: 2.0, carbsG: 1.0, fatG: 1.0, fiberG: 0.5 }
const ITERATIONS = 200
const DAMPING_MIN = 0.3
const DAMPING_MAX = 3
const CAP_MARGIN_G = 2

type MacroKey = keyof typeof WEIGHTS

function macroPerGram(recipe: { kcalPer100G: number; proteinPer100G: number; carbsPer100G: number; fatPer100G: number; fiberPer100G: number }) {
  return {
    kcal: recipe.kcalPer100G / 100,
    proteinG: recipe.proteinPer100G / 100,
    carbsG: recipe.carbsPer100G / 100,
    fatG: recipe.fatPer100G / 100,
    fiberG: recipe.fiberPer100G / 100,
  }
}

export function balanceDayToTargets(day: GroundedRecipeDay, target: DailyRecipeTarget): GroundedRecipeDay {
  const flatItems = day.meals.flatMap((meal) => meal.items)
  if (flatItems.length === 0) {
    return { ...day, totals: computeMealsTotals(day.meals), cappedRecipeNames: [] }
  }

  const limits = flatItems.map((item) => getServingLimitsG(item.recipe))
  const perGram = flatItems.map((item) => macroPerGram(item.recipe))
  const locked = flatItems.map((item) => item.gramsLocked === true)
  let x = flatItems.map((item) => item.grams)

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const predicted = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
    x.forEach((grams, i) => {
      const factor = grams / 100
      predicted.kcal += flatItems[i].recipe.kcalPer100G * factor
      predicted.proteinG += flatItems[i].recipe.proteinPer100G * factor
      predicted.carbsG += flatItems[i].recipe.carbsPer100G * factor
      predicted.fatG += flatItems[i].recipe.fatPer100G * factor
      predicted.fiberG += flatItems[i].recipe.fiberPer100G * factor
    })

    x = x.map((grams, i) => {
      if (locked[i]) return grams
      let num = 0
      let den = 0
      for (const key of Object.keys(WEIGHTS) as MacroKey[]) {
        num += WEIGHTS[key] * perGram[i][key] * target[key]
        den += WEIGHTS[key] * perGram[i][key] * predicted[key]
      }
      const factor = den > 1e-9 ? num / den : 1
      const damped = Math.min(Math.max(factor, DAMPING_MIN), DAMPING_MAX)
      const next = grams * damped
      return Math.min(Math.max(next, limits[i].min), limits[i].max)
    })
  }

  const finalGrams = x.map((v, i) => (locked[i] ? v : Math.max(0, Math.round(v / 5) * 5)))
  const cappedRecipeNames: string[] = []
  let cursor = 0
  const newMeals: GroundedRecipeMeal[] = day.meals.map((meal) => ({
    slot: meal.slot,
    items: meal.items.map((item) => {
      const grams = finalGrams[cursor]
      const lim = limits[cursor]
      const isLocked = locked[cursor]
      if (!isLocked && (grams >= lim.max - CAP_MARGIN_G || grams <= lim.min + CAP_MARGIN_G)) {
        cappedRecipeNames.push(item.recipe.name)
      }
      cursor++
      return isLocked ? { recipe: item.recipe, grams, gramsLocked: true } : { recipe: item.recipe, grams }
    }),
  }))

  return { ...day, meals: newMeals, totals: computeMealsTotals(newMeals), cappedRecipeNames }
}
