/**
 * How a day's calories and protein are spread across its main meals.
 *
 * Two dietitian rules (2026-10-12, "phase two"):
 *   1. Breakfast, lunch and dinner carry an EQUAL share of the day's
 *      calories. Snacks (mid-morning, evening, wake-up, bedtime) keep
 *      whatever they get; the three main meals split the rest evenly.
 *   2. The dietitian may pick ONE main meal to be protein-rich (review page).
 *      That meal should carry at least PROTEIN_RICH_SHARE of the day's protein
 *      target, and more protein than either of the other two.
 *
 * Both are steered in code by recipe-balancer.ts (extra least-squares terms,
 * so the grams move toward them) and reported, never rejected, by
 * describeMealBalanceProblems(): the write gate stays the weekly macro
 * average, exactly as before. A plate whose dishes simply cannot reach an
 * equal split (a breakfast whose dishes all have small authored maxima) is
 * a selection problem worth telling the dietitian about, not a reason to
 * throw a week away.
 *
 * No model is involved: these are arithmetic on verified per-100g data,
 * the same as every other gram (CLAUDE.md, "THE ONE RULE THAT MATTERS").
 */

import type { GroundedRecipeDay, GroundedRecipeMeal } from "./recipe-types"

export const MAIN_MEAL_SLOTS = ["breakfast", "lunch", "dinner"] as const
export type MainMealSlot = (typeof MAIN_MEAL_SLOTS)[number]

export function isMainMealSlot(slot: string): slot is MainMealSlot {
  return (MAIN_MEAL_SLOTS as readonly string[]).includes(slot)
}

/** At least this share of the day's protein target in the protein-rich meal. A third would be an even split. */
export const PROTEIN_RICH_SHARE = 0.35

/** A main meal further than this from the equal share is reported. */
export const MEAL_KCAL_BALANCE_TOLERANCE = 0.15

const MEAL_LABEL: Record<MainMealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" }

export function mainMealLabel(slot: MainMealSlot): string {
  return MEAL_LABEL[slot]
}

function mealKcal(meal: GroundedRecipeMeal): number {
  return meal.items.reduce((s, i) => s + (i.recipe.kcalPer100G * i.grams) / 100, 0)
}

function mealProtein(meal: GroundedRecipeMeal): number {
  return meal.items.reduce((s, i) => s + (i.recipe.proteinPer100G * i.grams) / 100, 0)
}

/**
 * The equal share each main meal aims at: the day's kcal target minus what
 * the snacks currently carry, split over the main meals that have food.
 * Null when fewer than two main meals have food (nothing to balance).
 */
export function equalMainMealKcal(mainMealCount: number, dayKcalTarget: number, snackKcal: number): number | null {
  if (mainMealCount < 2) return null
  const remaining = dayKcalTarget - snackKcal
  return remaining > 0 ? remaining / mainMealCount : null
}

/**
 * The swap of lunch and dinner on a day carries the protein-rich meal with
 * it: if lunch was protein-rich and the two were swapped, that day's
 * protein-rich food is now at dinner.
 */
export function effectiveProteinRichSlot(slot: string | null | undefined, lunchDinnerSwapped: boolean): MainMealSlot | undefined {
  if (!slot || !isMainMealSlot(slot)) return undefined
  if (!lunchDinnerSwapped) return slot
  if (slot === "lunch") return "dinner"
  if (slot === "dinner") return "lunch"
  return slot
}

/** Dietitian-facing problems with this day's meal split. Empty when it is fine. */
export function describeMealBalanceProblems(day: GroundedRecipeDay, dayKcalTarget: number, dayProteinTarget: number, proteinRichSlot?: string): string[] {
  const problems: string[] = []
  const mains = day.meals.filter((m) => isMainMealSlot(m.slot) && m.items.length > 0)
  const snackKcal = day.meals.filter((m) => !isMainMealSlot(m.slot)).reduce((s, m) => s + mealKcal(m), 0)
  const share = equalMainMealKcal(mains.length, dayKcalTarget, snackKcal)

  if (share !== null) {
    const off = mains.filter((m) => Math.abs(mealKcal(m) - share) / share > MEAL_KCAL_BALANCE_TOLERANCE)
    if (off.length > 0) {
      const all = mains.map((m) => `${m.slot} ${Math.round(mealKcal(m))}`).join(", ")
      problems.push(`breakfast, lunch and dinner are not equal in calories (${all} kcal; about ${Math.round(share)} kcal each)`)
    }
  }

  if (proteinRichSlot && isMainMealSlot(proteinRichSlot)) {
    const rich = mains.find((m) => m.slot === proteinRichSlot)
    if (rich) {
      const richProtein = mealProtein(rich)
      const higher = mains.filter((m) => m !== rich && mealProtein(m) > richProtein)
      const minimum = PROTEIN_RICH_SHARE * dayProteinTarget
      if (higher.length > 0 || richProtein < minimum - 0.5) {
        const detail = higher.length > 0 ? `${higher.map((m) => `${m.slot} ${Math.round(mealProtein(m))} g`).join(", ")} has more` : `aim for at least ${Math.round(minimum)} g`
        problems.push(`${proteinRichSlot} is the protein-rich meal but has ${Math.round(richProtein)} g protein (${detail})`)
      }
    }
  }
  return problems
}

/**
 * One number for "how far this day's plate shape is from the two rules", as a
 * fraction: the worst main meal's gap from the equal kcal share PLUS the
 * protein-rich meal's protein shortfall (against the larger of its floor and
 * the best other main meal). A sum, not the worse of the two: with a max, a
 * move that fixes the protein-rich meal scores zero while breakfast is still
 * light, and is never taken. 0 = both rules met exactly. What
 * recipe-repair.ts's enforceMealShape() minimises.
 */
export function mealShapeScore(day: GroundedRecipeDay, target: { kcal: number; proteinG: number; proteinRichSlot?: string }): number {
  const mains = day.meals.filter((m) => isMainMealSlot(m.slot) && m.items.length > 0)
  const snackKcal = day.meals.filter((m) => !isMainMealSlot(m.slot)).reduce((s, m) => s + mealKcal(m), 0)
  const share = equalMainMealKcal(mains.length, target.kcal, snackKcal)
  const kcalGap = share === null ? 0 : Math.max(...mains.map((m) => Math.abs(mealKcal(m) - share) / share))

  let shortfall = 0
  const rich = target.proteinRichSlot ? mains.find((m) => m.slot === target.proteinRichSlot) : undefined
  if (rich && target.proteinG > 0) {
    const minimum = PROTEIN_RICH_SHARE * target.proteinG
    const floor = Math.max(minimum, ...mains.filter((m) => m !== rich).map(mealProtein))
    shortfall = Math.max(0, floor - mealProtein(rich)) / minimum
  }
  return kcalGap + shortfall
}
