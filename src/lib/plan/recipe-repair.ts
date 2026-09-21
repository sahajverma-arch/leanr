/**
 * Deterministic macro repair — the stage between "the model named some
 * dishes" and "the day is judged against the client's target".
 *
 * WHY THIS EXISTS, measured rather than reasoned. Across all 12 real saved
 * recipe-engine plans (84 days), 63 of those days had at least one macro
 * target sitting OUTSIDE the range the chosen dish set can physically
 * reach — `recipe-balancer.ts` only scales grams inside each recipe's
 * authored [minGrams, maxGrams], so once the model has named the dishes the
 * deviation is already decided. Re-solving those same dish sets with a
 * provably-optimal minimax solver still left 36-47% worst-macro deviation
 * on the worst three plans: the gram optimizer was never the binding
 * constraint, dish SELECTION was. That is the gap this file closes.
 *
 * WHY NOT MORE SAMPLING. The error is bias, not variance: weekly-average
 * protein came back HIGH on 11 of those 12 plans (+4.7% to +132%). N
 * independent samples of one skewed distribution are N skewed samples, so
 * raising RECIPE_BEST_OF_N buys nothing here — it is the wrong lever, and an
 * expensive one.
 *
 * THE MOVE SET IS DELIBERATELY MINIMAL: replace one dish with another dish
 * from the SAME category bucket (a sabzi for a sabzi, a roti for a roti).
 * The plate keeps its shape, its dish count and its meal structure by
 * construction — only the dish's identity moves, and its grams are then
 * re-solved by the SAME balanceDayToTargets() every other path uses.
 * Allowing the repair to ADD or DROP dishes as well was implemented and
 * measured against the same 12 plans: no better, sometimes worse, and
 * slower. So it is not here.
 *
 * THE ONE RULE IS UNTOUCHED. No model is involved in a repair at any point.
 * Every candidate is a real row from the same eligible pool the model chose
 * from, every gram still comes out of the one balancer, and the acceptance
 * test is arithmetic on verified per-100g data.
 */

import { balanceDayToTargets } from "./recipe-balancer"
import { recipeCategoryBucket, type RecipeCategoryBucket } from "./recipe-category"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import type { DailyRecipeTarget, GroundedRecipeDay, GroundedRecipeItem, RecipeAchievedMacros, RecipeForPipeline } from "./recipe-types"
import { MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"

/**
 * The macros the repair steers on — the same four recipe-validate.ts gates
 * on, fiber deliberately excluded for the same soft-target reason. Repairing
 * toward a macro nothing rejects for would trade a gated miss for an
 * ungated one.
 */
const GATED_MACROS = ["kcal", "proteinG", "carbsG", "fatG"] as const
type GatedMacro = (typeof GATED_MACROS)[number]

type MacroTotals = Record<GatedMacro, number>

/**
 * Stop once a day is comfortably inside RECIPE_MACRO_TOLERANCE (0.08)
 * rather than grinding toward zero. Deliberately not equal to the tolerance:
 * a day parked exactly on the gate is one rounding step from failing it, and
 * every further swap spends another slice of the model's own composition for
 * a number nobody reads.
 */
export const REPAIR_TARGET_DEVIATION = 0.04

/**
 * At most this many swaps per day. A day converged in 2-5 swaps on every
 * real plan measured; the cap is what stops a pathological day (an
 * unreachable target — see the reachability note in CLAUDE.md) from
 * rewriting every dish the model chose in pursuit of a number it can never
 * hit.
 */
const MAX_SWAPS_PER_DAY = 6

/**
 * How many candidates get a full balance-and-validate per round. Candidates
 * are ranked first by a cheap exact one-dimensional estimate (see
 * bestAchievableWorst), so this is a budget on the expensive step, not a
 * blunt truncation of the search.
 */
const MAX_FULL_EVALUATIONS_PER_ROUND = 45

/** An improvement smaller than this (0.01 of a percentage point) is noise, not progress. */
const MIN_IMPROVEMENT = 1e-4

export interface RepairSwap {
  dayIndex: number
  slot: string
  from: string
  to: string
}

export interface RepairPool {
  byBucket: Map<RecipeCategoryBucket, RecipeForPipeline[]>
}

/**
 * Buckets the eligible pool once per generation. Built from
 * RecipeSelectorInput.allRecipesById — the identical pool the model was
 * offered, so a repair can never introduce a dish the client was not
 * already eligible for (diet type, cuisine, season, allergens and the
 * zero-kcal filter are all applied upstream of it).
 *
 * Each bucket is sorted by id so the candidate order — and therefore the
 * repaired week — is deterministic for a fixed input.
 */
export function buildRepairPool(pool: Iterable<RecipeForPipeline>): RepairPool {
  const byBucket = new Map<RecipeCategoryBucket, RecipeForPipeline[]>()
  for (const recipe of pool) {
    const bucket = recipeCategoryBucket(recipe.category, recipe.name)
    const existing = byBucket.get(bucket)
    if (existing) existing.push(recipe)
    else byBucket.set(bucket, [recipe])
  }
  for (const recipes of byBucket.values()) recipes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { byBucket }
}

/** Worst single-macro deviation as a fraction, directly comparable to RECIPE_MACRO_TOLERANCE. */
export function worstRelativeDeviation(totals: RecipeAchievedMacros, target: DailyRecipeTarget): number {
  return Math.max(
    ...GATED_MACROS.map((key) => {
      if (target[key] === 0) return totals[key] === 0 ? 0 : 1
      return Math.abs(totals[key] - target[key]) / target[key]
    })
  )
}

function contributionOf(item: GroundedRecipeItem): MacroTotals {
  const factor = item.grams / 100
  return {
    kcal: item.recipe.kcalPer100G * factor,
    proteinG: item.recipe.proteinPer100G * factor,
    carbsG: item.recipe.carbsPer100G * factor,
    fatG: item.recipe.fatPer100G * factor,
  }
}

function perGram(recipe: RecipeForPipeline): MacroTotals {
  return {
    kcal: recipe.kcalPer100G / 100,
    proteinG: recipe.proteinPer100G / 100,
    carbsG: recipe.carbsPer100G / 100,
    fatG: recipe.fatPer100G / 100,
  }
}

/**
 * The cheap ranking signal: holding every OTHER dish at the grams the
 * balancer just gave it, what is the best worst-macro deviation this
 * candidate could reach at any legal serving of its own?
 *
 * That one-dimensional question has an exact answer over a handful of
 * candidate gram values — each range end, plus the grams that would land
 * each macro exactly on target — because worst-deviation is piecewise
 * linear in a single item's grams and its minimum therefore sits at one of
 * those breakpoints or a range end. It is a lower bound on what the full
 * re-balance will find (the other dishes also move), which is exactly what a
 * ranking heuristic should be: optimistic and cheap.
 */
function bestAchievableWorst(othersTotals: MacroTotals, candidate: RecipeForPipeline, target: DailyRecipeTarget): number {
  const rate = perGram(candidate)
  const options = new Set<number>([candidate.minGrams, candidate.maxGrams, candidate.idealGrams])
  for (const key of GATED_MACROS) {
    if (rate[key] > 1e-9) {
      const exact = (target[key] - othersTotals[key]) / rate[key]
      options.add(Math.min(Math.max(exact, candidate.minGrams), candidate.maxGrams))
    }
  }
  let best = Number.POSITIVE_INFINITY
  for (const grams of options) {
    let worst = 0
    for (const key of GATED_MACROS) {
      const achieved = othersTotals[key] + rate[key] * grams
      const deviation = target[key] === 0 ? (achieved === 0 ? 0 : 1) : Math.abs(achieved - target[key]) / target[key]
      if (deviation > worst) worst = deviation
    }
    if (worst < best) best = worst
  }
  return best
}

function replaceItem(day: GroundedRecipeDay, mealIndex: number, itemIndex: number, recipe: RecipeForPipeline): GroundedRecipeDay {
  return {
    ...day,
    meals: day.meals.map((meal, mi) =>
      mi === mealIndex
        ? { ...meal, items: meal.items.map((item, ii) => (ii === itemIndex ? { recipe, grams: recipe.idealGrams } : item)) }
        : meal
    ),
  }
}

/**
 * Repair one day, given how many times each recipe is already used across
 * the whole week.
 *
 * `weeklyCounts` is MUTATED as swaps are accepted, so a later day's repair
 * sees what an earlier day's repair already spent. That is the point: the
 * variety cap is a week-level fact, and a per-day repair blind to it would
 * happily plate the same rescue dish seven times.
 *
 * A day carrying a hand-locked quantity is returned untouched. Repair only
 * ever runs during generation, which never sets that flag, so this is a
 * guard against a future caller rather than a live case — but a repair that
 * silently re-plans a day around a dietitian's pinned dish would be the
 * worst possible surprise.
 */
export function repairDay(
  day: GroundedRecipeDay,
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints,
  weeklyCounts: Map<string, number>
): { day: GroundedRecipeDay; swaps: RepairSwap[] } {
  const swaps: RepairSwap[] = []
  if (day.meals.some((meal) => meal.items.some((item) => item.gramsLocked))) return { day, swaps }

  let current = day
  let currentScore = worstRelativeDeviation(current.totals, target)

  for (let round = 0; round < MAX_SWAPS_PER_DAY; round++) {
    if (currentScore <= REPAIR_TARGET_DEVIATION) break

    // The model's own day may already carry plausibility problems —
    // best-of-N gates on the weekly average, not on plausibility, so saved
    // weeks routinely do. Requiring a candidate to be problem-FREE would
    // therefore reject every candidate on exactly the days most in need of
    // repair, and the stage would silently no-op. The rule is "no worse
    // than what the model produced", which is the honest one.
    const baselineProblems = describePlausibilityProblems(current, constraints).length

    const dayTotals: MacroTotals = {
      kcal: current.totals.kcal,
      proteinG: current.totals.proteinG,
      carbsG: current.totals.carbsG,
      fatG: current.totals.fatG,
    }

    interface Candidate {
      mealIndex: number
      itemIndex: number
      recipe: RecipeForPipeline
      estimate: number
    }
    const candidates: Candidate[] = []

    current.meals.forEach((meal, mealIndex) => {
      const namesInMeal = new Set(meal.items.map((item) => item.recipe.name))
      meal.items.forEach((item, itemIndex) => {
        const bucket = recipeCategoryBucket(item.recipe.category, item.recipe.name)
        const alternatives = pool.byBucket.get(bucket)
        if (!alternatives) return

        const own = contributionOf(item)
        const othersTotals: MacroTotals = {
          kcal: dayTotals.kcal - own.kcal,
          proteinG: dayTotals.proteinG - own.proteinG,
          carbsG: dayTotals.carbsG - own.carbsG,
          fatG: dayTotals.fatG - own.fatG,
        }

        for (const recipe of alternatives) {
          if (recipe.id === item.recipe.id) continue
          // A duplicate recipe inside one meal is a plausibility problem in
          // its own right — keep it out of the picker rather than offering
          // it and then rejecting it downstream.
          if (namesInMeal.has(recipe.name)) continue
          // Never push a recipe past the week's repeat cap. Swapping one
          // OUT only ever lowers its count, so this one check is enough to
          // guarantee repair introduces no new variety violation — while
          // leaving any the model already created alone rather than
          // refusing to repair the day at all.
          if ((weeklyCounts.get(recipe.name) ?? 0) >= MAX_RECIPE_REPEATS_PER_WEEK) continue
          candidates.push({ mealIndex, itemIndex, recipe, estimate: bestAchievableWorst(othersTotals, recipe, target) })
        }
      })
    })

    candidates.sort((a, b) => a.estimate - b.estimate || (a.recipe.id < b.recipe.id ? -1 : 1))

    let best: { day: GroundedRecipeDay; score: number; swap: RepairSwap } | null = null
    for (const candidate of candidates.slice(0, MAX_FULL_EVALUATIONS_PER_ROUND)) {
      // No point evaluating a candidate whose own optimistic bound cannot
      // beat what we already have.
      if (candidate.estimate >= currentScore - MIN_IMPROVEMENT) continue

      const rebalanced = balanceDayToTargets(
        replaceItem(current, candidate.mealIndex, candidate.itemIndex, candidate.recipe),
        target
      )
      if (describePlausibilityProblems(rebalanced, constraints).length > baselineProblems) continue

      const score = worstRelativeDeviation(rebalanced.totals, target)
      if (score >= currentScore - MIN_IMPROVEMENT) continue
      if (best === null || score < best.score) {
        best = {
          day: rebalanced,
          score,
          swap: {
            dayIndex: current.dayIndex,
            slot: current.meals[candidate.mealIndex].slot,
            from: current.meals[candidate.mealIndex].items[candidate.itemIndex].recipe.name,
            to: candidate.recipe.name,
          },
        }
      }
    }

    if (best === null) break

    weeklyCounts.set(best.swap.from, Math.max(0, (weeklyCounts.get(best.swap.from) ?? 1) - 1))
    weeklyCounts.set(best.swap.to, (weeklyCounts.get(best.swap.to) ?? 0) + 1)
    swaps.push(best.swap)
    current = best.day
    currentScore = best.score
  }

  return { day: current, swaps }
}

/** Every recipe name in the week, with how many days it appears on — the variety cap's own unit. */
function countWeeklyRecipeUse(days: GroundedRecipeDay[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) counts.set(item.recipe.name, (counts.get(item.recipe.name) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Repair a whole week, in day order, sharing one weekly recipe-use tally so
 * the days cannot collectively overspend a single rescue dish.
 */
export function repairWeek(
  days: GroundedRecipeDay[],
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints
): { days: GroundedRecipeDay[]; swaps: RepairSwap[] } {
  const weeklyCounts = countWeeklyRecipeUse(days)
  const swaps: RepairSwap[] = []
  const repaired = days.map((day) => {
    const result = repairDay(day, target, pool, constraints, weeklyCounts)
    swaps.push(...result.swaps)
    return result.day
  })
  return { days: repaired, swaps }
}
