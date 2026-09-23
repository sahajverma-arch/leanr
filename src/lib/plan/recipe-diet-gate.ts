import { detectRecipeAnimalContent, isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"
import type { GroundedRecipeDay } from "./recipe-types"

/**
 * The LAST check before a recipe-engine week is written: every dish on every
 * day must be allowed for the client's diet type, by its own evidence as well
 * as its label (recipe-animal-content.ts).
 *
 * This is a hard gate, not a warning, and deliberately separate from
 * recipe-plausibility-validate.ts. That validator also re-checks diet type,
 * but on the default best-of-N path its problems are downgraded to
 * `warnings` (weekly-average gating) — which is correct for a slightly odd
 * plate and never acceptable for fish on a vegetarian's plate. A diet breach
 * rejects the whole week, whatever path produced it.
 *
 * Returns one message per offending item; empty means safe to write.
 */
export function recipeDietViolations(days: readonly GroundedRecipeDay[], dietType: string): string[] {
  const violations: string[] = []
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        if (!isRecipeAllowedForDiet(item.recipe, dietType)) {
          const evidence = detectRecipeAnimalContent(item.recipe).reasons
          violations.push(
            `Day ${day.dayIndex + 1} ${meal.slot}: "${item.recipe.name}" is not ${dietType}` +
              (evidence.length > 0 ? ` (${[...new Set(evidence)].join(", ")})` : "")
          )
        }
      }
    }
  }
  return violations
}
