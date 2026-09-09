/**
 * Everything a dietitian should be told about a generated week that the
 * write gate does not reject it for.
 *
 * Extracted from recipe-selector.ts so it can be reused by the plan-edit
 * path (a recipe swap re-balances the day and must recompute these) and
 * unit-tested — recipe-selector.ts imports openai-client.ts, which validates
 * server env at module load. Same separation as recipe-day-diagnosis.ts.
 */

import { describeMacroProblems, RECIPE_MACRO_TOLERANCE } from "./recipe-validate"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { findVarietyViolations, MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeAchievedMacros } from "./recipe-types"

const SUMMARISED_MACROS = [
  ["kcal", "kcal"],
  ["proteinG", "protein"],
  ["carbsG", "carbs"],
  ["fatG", "fat"],
] as const

/**
 * The headline a dietitian reads first: which macros this week misses, by how
 * much, and IN WHICH DIRECTION. Direction matters more than size — "protein
 * 11% under" and "protein 11% over" call for opposite corrections, and a bare
 * percentage hides that.
 *
 * Returns null when nothing is out of tolerance.
 */
export function offTargetSummary(
  weeklyAverage: RecipeAchievedMacros,
  target: DailyRecipeTarget,
  attempts: number
): string | null {
  const misses = SUMMARISED_MACROS.map(([key, label]) => ({
    label,
    pct: ((weeklyAverage[key] - target[key]) / target[key]) * 100,
  })).filter((m) => Math.abs(m.pct) > RECIPE_MACRO_TOLERANCE * 100)

  if (misses.length === 0) return null

  const described = misses.map((m) => `${m.label} ${Math.abs(m.pct).toFixed(0)}% ${m.pct > 0 ? "over" : "under"}`)
  return (
    `NEEDS DIETITIAN REVIEW — this is the closest of ${attempts} generated week(s), and its weekly ` +
    `average is outside the ${(RECIPE_MACRO_TOLERANCE * 100).toFixed(0)}% tolerance on: ${described.join(", ")}. ` +
    `Every day's own problems are listed below; decide whether it is usable, swap items, or regenerate.`
  )
}

/**
 * Per-day detail: macro misses, implausible plates, serving-limit hits, and
 * the week-level variety breaches. None of these block a write — they are
 * what the dietitian judges the plan on.
 */
export function buildRecipeWarnings(
  days: GroundedRecipeDay[],
  target: DailyRecipeTarget,
  constraints: ClientRecipeConstraints
): string[] {
  const warnings: string[] = []
  const overused = new Set(findVarietyViolations(days).map((v) => v.name))

  for (const day of days) {
    for (const problem of describeMacroProblems(day.totals, target)) {
      warnings.push(`Day ${day.dayIndex + 1}: ${problem}`)
    }
    for (const problem of describePlausibilityProblems(day, constraints)) {
      warnings.push(`Day ${day.dayIndex + 1}: ${problem}`)
    }
    if (day.cappedRecipeNames.length > 0) {
      warnings.push(`Day ${day.dayIndex + 1}: recipes hit their serving limit: ${day.cappedRecipeNames.join(", ")}`)
    }
  }
  if (overused.size > 0) {
    warnings.push(`Used more than ${MAX_RECIPE_REPEATS_PER_WEEK} times this week: ${[...overused].join(", ")}`)
  }
  return warnings
}
