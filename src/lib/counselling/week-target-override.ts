import type { WeekTargets } from "./roadmap"

/**
 * A dietitian's hand-set daily target for one week, entered on the review
 * page before generation.
 *
 * The roadmap computes a target for every week (weekTargets()), but a client
 * can prefer a different split — more protein, fewer carbs, a softer calorie
 * step — and that is the dietitian's call to make. The override REPLACES the
 * computed target for that week; it never mutates the roadmap snapshot, the
 * same shape roadmap_overrides and roadmap_supplements already use.
 *
 * CONFIRMED SCOPE: kcal, protein and carbs are entered. Fat is not — it is
 * derived as the residual `(kcal - protein*4 - carbs*4) / 9`, so the target
 * can never be internally inconsistent (kcal always equals its own macros,
 * which recipe-balancer.ts relies on: it optimises all of them at once and
 * would otherwise chase a combination that cannot exist). This mirrors how
 * weekTargets() itself derives carbs as the residual, just with the free
 * macro moved to the one the dietitian did not type. Fibre is untouched.
 *
 * Deterministic dietitian-entered numbers — no model ever proposes or sees
 * them as anything but the target, so THE ONE RULE is untouched. Pure
 * functions, zero I/O.
 */
export interface WeekTargetOverride {
  kcal: number
  proteinG: number
  carbsG: number
}

/**
 * An override the system refuses outright. Lives here rather than in the
 * review page's actions file because a "use server" module may only export
 * async functions.
 */
export class WeekTargetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WeekTargetValidationError"
  }
}

/** Below this, fat is not a plannable daily amount — warned, not refused. */
const MIN_REASONABLE_FAT_G = 20

/** Fat implied by an override. Can be negative — that is what validation catches. */
export function impliedFatG(override: WeekTargetOverride): number {
  return (override.kcal - override.proteinG * 4 - override.carbsG * 4) / 9
}

/**
 * Throws when the numbers cannot describe a real day: protein and carbs
 * alone already exceed the calories, which would leave negative fat.
 */
export function assertWeekTargetOverride(override: WeekTargetOverride): void {
  const fromProteinAndCarbs = override.proteinG * 4 + override.carbsG * 4
  if (fromProteinAndCarbs > override.kcal) {
    throw new WeekTargetValidationError(
      `Protein and carbs alone come to ${Math.round(fromProteinAndCarbs)} kcal, more than the ` +
        `${Math.round(override.kcal)} kcal target — there is no room left for fat. ` +
        `Raise the calories or lower protein/carbs.`
    )
  }
}

/** Reasons a dietitian should look again. Never thrown — their call, but not silent. */
export function weekTargetOverrideWarnings(override: WeekTargetOverride): string[] {
  const fatG = impliedFatG(override)
  if (fatG >= 0 && fatG < MIN_REASONABLE_FAT_G) {
    return [`These numbers leave only ${Math.round(fatG)} g fat a day, which is very low for a real diet.`]
  }
  return []
}

/**
 * The target generation should aim at for a week: the computed one, or the
 * dietitian's override of it. The supplement (if any) is subtracted AFTER
 * this — the override is a change to the prescription, not to the food.
 */
export function applyWeekTargetOverride(computed: WeekTargets, override: WeekTargetOverride | null): WeekTargets {
  if (!override) return computed
  assertWeekTargetOverride(override)
  return {
    kcal: override.kcal,
    proteinG: override.proteinG,
    carbsG: override.carbsG,
    fatG: impliedFatG(override),
    fibreG: computed.fibreG,
  }
}
