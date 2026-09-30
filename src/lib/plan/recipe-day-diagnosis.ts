/**
 * What counts as a problem with a generated day, split into the two
 * genuinely different questions the pipeline asks:
 *
 *   blockingProblems() — does this day block the DB write?
 *   diagnoseDay()      — what do we tell the model when regenerating it?
 *
 * Lives outside recipe-selector.ts purely so it is unit-testable: that file
 * imports openai-client.ts, which validates server env at module load, so
 * anything reachable from it cannot be exercised in a plain Vitest run.
 * Same separation as recipe-validate.ts / recipe-plausibility-validate.ts.
 */

import { describeMacroProblems } from "./recipe-validate"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import type { GroundedRecipeDay, RecipeSelectorInput } from "./recipe-types"

/**
 * The problems that actually BLOCK a write: macro tolerance, plausibility,
 * an unresolvable recipe name, and the weekly variety cap. Mirrors
 * recipe-selector.ts's dayNeedsRetry() exactly, so the retry loop can
 * always in principle fix what the final gate rejects.
 *
 * Deliberately EXCLUDES cappedRecipeNames — a recipe sitting at its own
 * authored serving limit is advisory, not a defect: the grams are real,
 * still inside the recipe's honest range, and a day can be perfectly
 * on-macro with one. It is surfaced two other ways instead — in the retry
 * prompt via diagnoseDay() below, and in selectRecipes()'s returned
 * `warnings` for a dietitian to eyeball.
 *
 * It used to be a blocking problem, which was an unintended dead-end: caps
 * were absent from dayNeedsRetry(), so a day whose ONLY flaw was a capped
 * serving was never selected for retry, yet still rejected the whole plan
 * at the final gate — a failure the retry loop was structurally incapable
 * of repairing. The giveaway was selectRecipes()'s own `warnings` block: it
 * collects exactly these capped names, and was provably unreachable with
 * anything in it, since any capped day threw before it ran.
 *
 * Real serving-limit data makes this bite hard rather than rarely: of the
 * 1222 ingested recipes, 18% have a zero-width range (min == max, so they
 * trip the check no matter what the balancer does) and only 15% have real
 * headroom in both directions.
 */
export function blockingProblems(
  day: GroundedRecipeDay,
  input: Pick<RecipeSelectorInput, "dailyTarget">,
  constraints: ClientRecipeConstraints,
  overusedRecipeNames: Set<string>
): string[] {
  const problems = [
    ...describeMacroProblems(day.totals, input.dailyTarget),
    ...describePlausibilityProblems(day, constraints),
  ]
  if (day.unknownRecipeNames.length > 0) {
    problems.push(`Could not identify these recipe names, they were dropped: ${day.unknownRecipeNames.join(", ")}`)
  }
  for (const name of overusedRecipeNames) {
    if (day.meals.some((m) => m.items.some((i) => i.recipe.name === name))) {
      problems.push(`"${name}" has already been used more times this week than its variety limit allows — choose a different recipe for this day.`)
    }
  }
  return problems
}

/** Everything worth telling the model when a day is being regenerated — every blocking problem, plus the advisory serving-limit note. Always a superset of blockingProblems(). */
export function diagnoseDay(
  day: GroundedRecipeDay,
  input: Pick<RecipeSelectorInput, "dailyTarget">,
  constraints: ClientRecipeConstraints,
  overusedRecipeNames: Set<string>
): string[] {
  const problems = blockingProblems(day, input, constraints, overusedRecipeNames)
  if (day.cappedRecipeNames.length > 0) {
    problems.push(`These recipes hit their realistic serving limit without closing the gap — consider adding another dish instead: ${day.cappedRecipeNames.join(", ")}`)
  }
  return problems
}
