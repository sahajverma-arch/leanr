/**
 * How a day's calories and protein are spread across its meals.
 *
 * Two dietitian rules:
 *   1. CALORIE SPLIT (2026-10-15, replacing the equal three-way split of
 *      2026-10-12): breakfast carries about 15-20% of the day's calories,
 *      lunch and dinner 25-30% each, and the rest goes to the snacks
 *      (mid-morning and evening). MEAL_KCAL_SHARES holds the midpoints. The
 *      equal split had put breakfast at a median 26% of the day and the two
 *      snacks at 13% COMBINED, measured over the 12 plans saved after it
 *      landed — "breakfast is too big ... both the snacks combined are way
 *      too small, almost negligible". The optional wake-up and bedtime drinks
 *      keep whatever they carry and come off the top.
 *   2. The dietitian may pick ONE main meal to be protein-rich (review page).
 *      That meal should carry at least PROTEIN_RICH_SHARE of the day's protein
 *      target, and more protein than either of the other two.
 *
 * Both are steered in code by recipe-balancer.ts (extra least-squares terms,
 * so the grams move toward them), changed at the dish level by
 * recipe-repair.ts's enforceMealShape(), and reported, never rejected, by
 * describeMealBalanceProblems(): the write gate stays the weekly macro
 * average, exactly as before. A plate whose dishes simply cannot reach the
 * split is a selection problem worth telling the dietitian about, not a
 * reason to throw a week away.
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

/**
 * Each slot's share of the day's calories, as the dietitian stated it
 * (midpoints of "15-20%", "25-30%", "25-30%", "the rest to snacks"). A slot
 * not listed here (wake-up, bedtime) has no share: it keeps what it carries.
 * The shares of the slots a day actually has are renormalised to sum to 1,
 * so a three-meal day splits 24/38/38 and a four-slot day 20/32/32/16.
 */
export const MEAL_KCAL_SHARES: Readonly<Record<string, number>> = {
  breakfast: 0.175,
  mid_morning: 0.1375,
  lunch: 0.275,
  evening: 0.1375,
  dinner: 0.275,
}

export function isShareSlot(slot: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEAL_KCAL_SHARES, slot)
}

/** At least this share of the day's protein target in the protein-rich meal. A third would be an even split. */
export const PROTEIN_RICH_SHARE = 0.35

/**
 * A slot may sit this far from its share — as a fraction of the DAY's
 * calories, not of the slot's — before it is reported: ±2.5 points, the
 * half-width of the dietitian's own "15-20%" and "25-30%" ranges.
 */
export const MEAL_KCAL_SHARE_TOLERANCE = 0.025

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
 * The calories each slot should carry, for the slots that have food. Slots
 * with no share (wake-up, bedtime) keep what they carry and come off the day
 * target first; the remaining slots' shares are renormalised over what is
 * left. Empty when fewer than two share slots have food, or nothing is left
 * for them — then there is nothing to split.
 */
export function slotKcalTargets(meals: readonly { slot: string; kcal: number }[], dayKcalTarget: number): Map<string, number> {
  const shared = meals.filter((m) => isShareSlot(m.slot))
  if (shared.length < 2) return new Map()
  const fixed = meals.filter((m) => !isShareSlot(m.slot)).reduce((s, m) => s + m.kcal, 0)
  const remaining = dayKcalTarget - fixed
  if (remaining <= 0) return new Map()
  const total = shared.reduce((s, m) => s + MEAL_KCAL_SHARES[m.slot], 0)
  return new Map(shared.map((m) => [m.slot, (remaining * MEAL_KCAL_SHARES[m.slot]) / total]))
}

function mealsWithFood(day: GroundedRecipeDay): { slot: string; kcal: number; meal: GroundedRecipeMeal }[] {
  return day.meals.filter((m) => m.items.length > 0).map((m) => ({ slot: m.slot, kcal: mealKcal(m), meal: m }))
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

const pctOfDay = (kcal: number, dayKcal: number) => `${Math.round((kcal / dayKcal) * 100)}%`

/** Dietitian-facing problems with this day's meal split. Empty when it is fine. */
export function describeMealBalanceProblems(day: GroundedRecipeDay, dayKcalTarget: number, dayProteinTarget: number, proteinRichSlot?: string): string[] {
  const problems: string[] = []
  const meals = mealsWithFood(day)
  const targets = slotKcalTargets(meals, dayKcalTarget)

  if (targets.size > 0 && dayKcalTarget > 0) {
    const off = meals.filter((m) => {
      const want = targets.get(m.slot)
      return want !== undefined && Math.abs(m.kcal - want) / dayKcalTarget > MEAL_KCAL_SHARE_TOLERANCE
    })
    if (off.length > 0) {
      const detail = off.map((m) => `${m.slot} ${pctOfDay(m.kcal, dayKcalTarget)} of the day (aim ~${pctOfDay(targets.get(m.slot)!, dayKcalTarget)})`).join(", ")
      problems.push(`calorie split is off: ${detail} — breakfast 15-20%, lunch and dinner 25-30% each, the rest to mid-morning and evening`)
    }
  }

  const mains = meals.filter((m) => isMainMealSlot(m.slot)).map((m) => m.meal)
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

interface ShapeTarget {
  kcal: number
  proteinG: number
  proteinRichSlot?: string
}

/** Each share slot's gap from its calorie target, as a fraction of the day's calories. */
function slotGaps(day: GroundedRecipeDay, target: ShapeTarget): number[] {
  const meals = mealsWithFood(day)
  const targets = slotKcalTargets(meals, target.kcal)
  if (targets.size === 0 || target.kcal <= 0) return []
  return meals.filter((m) => targets.has(m.slot)).map((m) => Math.abs(m.kcal - targets.get(m.slot)!) / target.kcal)
}

/** The protein-rich meal's shortfall against the larger of its floor and the best other main meal, as a fraction of the day's protein. */
function proteinRichShortfall(day: GroundedRecipeDay, target: ShapeTarget): number {
  const mains = day.meals.filter((m) => isMainMealSlot(m.slot) && m.items.length > 0)
  const rich = target.proteinRichSlot ? mains.find((m) => m.slot === target.proteinRichSlot) : undefined
  if (!rich || target.proteinG <= 0) return 0
  const minimum = PROTEIN_RICH_SHARE * target.proteinG
  const floor = Math.max(minimum, ...mains.filter((m) => m !== rich).map(mealProtein))
  return Math.max(0, floor - mealProtein(rich)) / target.proteinG
}

/**
 * One number for "how far this day's plate shape is from the two rules": the
 * SUM of every slot's gap from its calorie share (each as a fraction of the
 * DAY's calories) PLUS the protein-rich meal's protein shortfall as a
 * fraction of the day's protein. Both in "points of the day", so they add
 * honestly. 0 = both rules met exactly.
 *
 * A sum, twice over, and both for the same reason: with a max, a move that
 * fixes one problem scores nothing while another is still the worst, and is
 * never taken. Measured on the first version (worst slot only): topping up a
 * mid-morning snack from 5% to 13% of the day was refused because breakfast,
 * still 10 points over, remained the worst slot and the score barely moved.
 * What recipe-repair.ts's enforceMealShape() minimises.
 */
export function mealShapeScore(day: GroundedRecipeDay, target: ShapeTarget): number {
  return slotGaps(day, target).reduce((s, g) => s + g, 0) + proteinRichShortfall(day, target)
}

/**
 * Whether the day's shape is already acceptable: every slot within
 * MEAL_KCAL_SHARE_TOLERANCE of its share and the protein-rich meal (if any)
 * at its floor. The stopping rule for enforceMealShape(); mealShapeScore()
 * is what it ranks moves by.
 */
export function mealShapeWithinTolerance(day: GroundedRecipeDay, target: ShapeTarget): boolean {
  return slotGaps(day, target).every((g) => g <= MEAL_KCAL_SHARE_TOLERANCE) && proteinRichShortfall(day, target) <= 0
}
