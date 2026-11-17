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
import { MEAL_KCAL_SHARES, PROTEIN_RICH_SHARE, slotKcalTargets } from "./recipe-meal-balance"
import { getMealServingLimitsG, getServingLimitsG } from "./recipe-serving-limits"

const WEIGHTS = { kcal: 0.4, proteinG: 2.0, carbsG: 1.0, fatG: 1.0, fiberG: 0.5 }
const ITERATIONS = 200
const DAMPING_MIN = 0.3
const DAMPING_MAX = 3
const CAP_MARGIN_G = 2
// Each slot's share of the day's calories (breakfast 15-20%, lunch/dinner
// 25-30%, the rest to the snacks — recipe-meal-balance.ts), and the
// protein-rich meal's floor, as extra least-squares terms. A meal's kcal
// residual pulls with SLOT_KCAL_WEIGHT_FACTOR of the day kcal residual's
// weight. The factor is 0.6, not 1: five slots now carry a term where three
// did, and at full weight the aggregate pull against the macro terms cost
// macro convergence on replay (days within ±8% 326 -> 319 over 53 saved
// plans); at 0.6 it is 323 with the same number of weeks passing as before
// and MORE days inside the split (170 -> 177), since enforceMealShape() does
// the rest at the dish level. The protein-rich floor is scaled so a 1%
// shortfall pulls as hard as a 1% meal-kcal gap: in raw units (grams against
// kcal) it would otherwise be ~20x weaker and do nothing - measured on the
// saved plans, where it moved 0 of 287 days.
const SLOT_KCAL_WEIGHT_FACTOR = 0.6
const MEAL_KCAL_WEIGHT = WEIGHTS.kcal * SLOT_KCAL_WEIGHT_FACTOR

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

  // Per meal, not per dish alone: a roti that is a meal's only staple has a
  // two-roti floor (see getMealServingLimitsG).
  const limits = day.meals.flatMap((meal) =>
    meal.items.map((item) =>
      getMealServingLimitsG(
        item.recipe,
        meal.slot,
        meal.items.map((i) => i.recipe)
      )
    )
  )
  const perGram = flatItems.map((item) => macroPerGram(item.recipe))
  const locked = flatItems.map((item) => item.gramsLocked === true)
  // Which meal each flat item sits in, and which meals have food.
  const mealOf = day.meals.flatMap((meal, m) => meal.items.map(() => m))
  const mealsWithFood = day.meals.flatMap((meal, m) => (meal.items.length > 0 ? [m] : []))
  const richMeal = target.proteinRichSlot ? day.meals.findIndex((meal) => meal.slot === target.proteinRichSlot && meal.items.length > 0) : -1
  const richProteinTarget = PROTEIN_RICH_SHARE * target.proteinG
  // The protein-rich meal's own calorie share, so a 1% protein shortfall
  // there pulls like a 1% kcal gap on that same meal.
  const richShare = richMeal >= 0 ? (MEAL_KCAL_SHARES[day.meals[richMeal].slot] ?? 0.275) : 0.275
  const richWeight = richProteinTarget > 0 ? MEAL_KCAL_WEIGHT * ((richShare * target.kcal) / richProteinTarget) ** 2 : 0
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
    const mealKcal = day.meals.map(() => 0)
    const mealProtein = day.meals.map(() => 0)
    x.forEach((grams, i) => {
      mealKcal[mealOf[i]] += perGram[i].kcal * grams
      mealProtein[mealOf[i]] += perGram[i].proteinG * grams
    })
    // Wake-up/bedtime keep what they carry; every other slot with food is
    // pulled toward its share of what is left (recipe-meal-balance.ts).
    const slotTargets = slotKcalTargets(
      mealsWithFood.map((m) => ({ slot: day.meals[m].slot, kcal: mealKcal[m] })),
      target.kcal
    )
    // One-sided: a protein-rich meal already above its floor is not pulled down.
    const richBelow = richMeal >= 0 && mealProtein[richMeal] < richProteinTarget

    x = x.map((grams, i) => {
      if (locked[i]) return grams
      let num = 0
      let den = 0
      for (const key of Object.keys(WEIGHTS) as MacroKey[]) {
        num += WEIGHTS[key] * perGram[i][key] * target[key]
        den += WEIGHTS[key] * perGram[i][key] * predicted[key]
      }
      const m = mealOf[i]
      const slotTarget = slotTargets.get(day.meals[m].slot)
      if (slotTarget !== undefined) {
        num += MEAL_KCAL_WEIGHT * perGram[i].kcal * slotTarget
        den += MEAL_KCAL_WEIGHT * perGram[i].kcal * mealKcal[m]
      }
      if (richBelow && m === richMeal) {
        num += richWeight * perGram[i].proteinG * richProteinTarget
        den += richWeight * perGram[i].proteinG * mealProtein[m]
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
      // Against the dish's AUTHORED range: a roti held on its meal floor
      // (two rotis) is a rule working, not a serving limit worth a warning.
      const lim = getServingLimitsG(item.recipe)
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
