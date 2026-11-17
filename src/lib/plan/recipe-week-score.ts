/**
 * Ranking for the best-of-N generation strategy: given several independently
 * generated candidate weeks, which one best matches the client's target?
 *
 * Lives outside recipe-selector.ts purely so it is unit-testable — that file
 * imports anthropic-client.ts, which validates server env at module load. Same
 * separation as recipe-day-diagnosis.ts / recipe-validate.ts.
 *
 * Ranking is two-level: a candidate that clears the acceptance gate always
 * beats one that does not, and ties within each group break on the score
 * below. See pickBestWeek() for why ranking on the score alone was wrong.
 *
 * WHY MEAN DEVIATION OF THE WEEKLY AVERAGE as that score. Measured on
 * real runs, a single-call week lands 0-2 of 7 days inside the per-day
 * tolerance, so ranking on "days passing" would mostly compare zeroes and
 * decide the winner by noise. The weekly average is both the quantity the
 * best-of-N path actually gates on and a continuous signal that separates
 * candidates cleanly. Plausibility and variety counts are deliberately NOT
 * folded into the score — mixing them in would quietly reintroduce the
 * per-day gate this strategy exists to replace, and they are surfaced as
 * warnings instead.
 */

import { isRecipeWeekOffTarget } from "./recipe-validate"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeAchievedMacros } from "./recipe-types"

/** The macros the score considers. Fiber is excluded for the same reason recipe-validate.ts excludes it: it is a soft target. */
const SCORED_MACROS = ["kcal", "proteinG", "carbsG", "fatG"] as const

export function computeWeeklyAverage(days: GroundedRecipeDay[]): RecipeAchievedMacros {
  const n = days.length || 1
  return {
    kcal: days.reduce((s, d) => s + d.totals.kcal, 0) / n,
    proteinG: days.reduce((s, d) => s + d.totals.proteinG, 0) / n,
    carbsG: days.reduce((s, d) => s + d.totals.carbsG, 0) / n,
    fatG: days.reduce((s, d) => s + d.totals.fatG, 0) / n,
    fiberG: days.reduce((s, d) => s + d.totals.fiberG, 0) / n,
  }
}

/**
 * Mean absolute deviation of a week's average from target, as a FRACTION
 * (0.03 = 3%), averaged across kcal/protein/carbs/fat. Lower is better.
 * Directly comparable to RECIPE_MACRO_TOLERANCE.
 */
export function weeklyDeviationScore(days: GroundedRecipeDay[], target: DailyRecipeTarget): number {
  const avg = computeWeeklyAverage(days)
  const total = SCORED_MACROS.reduce((sum, k) => sum + Math.abs(avg[k] - target[k]) / target[k], 0)
  return total / SCORED_MACROS.length
}

/**
 * The best of several candidate weeks.
 *
 * A candidate that CLEARS the acceptance gate always beats one that does
 * not, whatever their mean scores. Ranking on mean deviation alone was a
 * real defect: the gate (isRecipeWeekOffTarget) checks each macro
 * individually against the tolerance, while the mean can hide a single macro
 * far outside it. Observed on a real run — a candidate scored 3.84% mean and
 * still failed, because one macro was over 8%. Picking purely by mean can
 * therefore choose a failing week over a passing one and reject the whole
 * plan when an acceptable week was available.
 *
 * Ties resolve to the earliest candidate, so the result is deterministic for
 * a fixed input order rather than depending on sort stability. Returns null
 * for an empty list — the caller decides what "every attempt failed" means.
 */
export function pickBestWeek(
  candidates: GroundedRecipeDay[][],
  target: DailyRecipeTarget
): { days: GroundedRecipeDay[]; score: number; index: number; passes: boolean } | null {
  let best: { days: GroundedRecipeDay[]; score: number; index: number; passes: boolean } | null = null

  for (let index = 0; index < candidates.length; index++) {
    const days = candidates[index]
    const candidate = {
      days,
      score: weeklyDeviationScore(days, target),
      index,
      passes: !isRecipeWeekOffTarget(computeWeeklyAverage(days), target),
    }
    if (best === null) {
      best = candidate
    } else if (candidate.passes !== best.passes) {
      if (candidate.passes) best = candidate
    } else if (candidate.score < best.score) {
      best = candidate
    }
  }

  return best
}
