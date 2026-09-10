import type { WeekTargets } from "./roadmap"

/**
 * A prescribed daily supplement, and what the FOOD then has to supply.
 *
 * WHY THIS EXISTS. A client told to take a scoop of whey is getting protein
 * the diet plan does not cook. If the recipes are still solved against the
 * full protein target, the client eats a full day of food protein PLUS the
 * scoop — over target every day, invisibly. So the supplement's macros are
 * subtracted first, and the plan is built to fill only the remainder.
 *
 * This is deterministic dietitian-entered data, never a model's guess: the
 * numbers come off the tub's label, typed on the review page. The LLM never
 * sees them, never proposes them, and simply composes recipes against a
 * smaller protein figure — so CLAUDE.md's "THE ONE RULE THAT MATTERS" is
 * untouched. Pure functions, zero I/O, same category as roadmap.ts itself.
 */

/**
 * A prescription the system refuses outright, e.g. for a client recorded as
 * allergic to protein powder.
 *
 * Lives here rather than in the review page's actions file because a
 * "use server" module may only export async functions — exporting a class
 * from one fails the build.
 */
export class SupplementValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SupplementValidationError"
  }
}

/** As prescribed: per-serving figures off the label, plus how many servings a day. */
export interface PrescribedSupplement {
  name: string
  /** How one serving is described to the client — "1 scoop", "2 scoops", "1 sachet". */
  servingLabel: string
  servingsPerDay: number
  proteinGPerServing: number
  kcalPerServing: number
}

export interface SupplementDailyTotals {
  proteinG: number
  kcal: number
}

/**
 * CONFIRMED SCOPE: protein and calories only.
 *
 * Carbs and fat are not entered per-serving — a decision, not an oversight.
 * They are not ignored either: because weekTargets() derives carbs as the
 * residual `(kcal - protein*4 - fat*9) / 4`, the scoop's NON-protein calories
 * come out of the day's carbs automatically. A 120 kcal / 24 g scoop is 96
 * kcal of protein, so the remaining 24 kcal reduces carbs by ~6 g. That falls
 * out of the arithmetic rather than being applied separately.
 */
export function supplementDailyTotals(supplement: PrescribedSupplement): SupplementDailyTotals {
  return {
    proteinG: supplement.proteinGPerServing * supplement.servingsPerDay,
    kcal: supplement.kcalPerServing * supplement.servingsPerDay,
  }
}

export interface SupplementAdjustedTargets {
  /** What the recipes must supply — the prescribed target minus the supplement. */
  food: WeekTargets
  /** What the supplement contributes, for display beside the food figure. */
  supplement: SupplementDailyTotals
  /**
   * Reasons a dietitian should look again before generating. Never thrown:
   * an unusual prescription is their call to make, but it must not be silent.
   */
  warnings: string[]
}

/** Below this the remaining food protein is not a plannable target any more. */
const MIN_FOOD_PROTEIN_G = 20
/** Same idea for energy — a day of food this small is not a diet plan. */
const MIN_FOOD_KCAL = 500

/**
 * The prescribed target minus the supplement.
 *
 * Fat is carried through untouched and carbs are RECOMPUTED as the residual,
 * exactly as weekTargets() does. Subtracting protein and kcal while leaving
 * carbs at their original value would leave the target internally
 * inconsistent — kcal would no longer equal its own macros — and the
 * balancer optimises all of them at once, so it would be chasing a
 * combination that cannot exist.
 *
 * Everything is clamped at zero. A supplement bigger than the target is a
 * real prescribing error, and the warning says so rather than the plan
 * quietly inheriting a negative number.
 */
export function foodTargetsAfterSupplement(
  prescribed: WeekTargets,
  supplement: PrescribedSupplement | null
): SupplementAdjustedTargets {
  if (!supplement) {
    return { food: prescribed, supplement: { proteinG: 0, kcal: 0 }, warnings: [] }
  }

  const totals = supplementDailyTotals(supplement)
  const warnings: string[] = []

  const proteinG = Math.max(0, prescribed.proteinG - totals.proteinG)
  const kcal = Math.max(0, prescribed.kcal - totals.kcal)
  const fatG = prescribed.fatG
  const carbsG = Math.max(0, (kcal - proteinG * 4 - fatG * 9) / 4)

  if (totals.proteinG >= prescribed.proteinG) {
    warnings.push(
      `${supplement.name} supplies ${totals.proteinG.toFixed(0)} g protein, which is the client's entire ` +
        `${prescribed.proteinG.toFixed(0)} g daily target — the food plan would be left with none to provide.`
    )
  } else if (proteinG < MIN_FOOD_PROTEIN_G) {
    warnings.push(
      `After ${supplement.name}, the food only needs to supply ${proteinG.toFixed(0)} g protein a day. ` +
        `That is very little to build real meals around — check the per-serving figures.`
    )
  }

  if (totals.kcal >= prescribed.kcal) {
    warnings.push(
      `${supplement.name} supplies ${totals.kcal.toFixed(0)} kcal, at or above the client's entire ` +
        `${prescribed.kcal.toFixed(0)} kcal daily target.`
    )
  } else if (kcal < MIN_FOOD_KCAL) {
    warnings.push(`After ${supplement.name}, the food only needs to supply ${kcal.toFixed(0)} kcal a day.`)
  }

  // Fat alone can exceed the reduced energy budget, which is what drives
  // carbs to zero. Worth naming, since the plan will then be built with
  // effectively no carbohydrate.
  if (carbsG === 0 && kcal > 0) {
    warnings.push(
      `After ${supplement.name}, there are no calories left for carbohydrate once protein and fat are covered.`
    )
  }

  return { food: { kcal, proteinG, fatG, carbsG, fibreG: prescribed.fibreG }, supplement: totals, warnings }
}

/** One line for the plan banner and the PDF: what the client takes, and what it gives them. */
export function describeSupplement(supplement: PrescribedSupplement): string {
  const totals = supplementDailyTotals(supplement)
  const serving =
    supplement.servingsPerDay === 1
      ? supplement.servingLabel
      : `${supplement.servingsPerDay} × ${supplement.servingLabel}`
  return `Daily: ${serving} ${supplement.name} — ${totals.proteinG.toFixed(0)} g protein, ${totals.kcal.toFixed(0)} kcal`
}
