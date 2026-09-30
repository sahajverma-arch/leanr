/**
 * "Same food on all days" — a client's fixed daily menu.
 *
 * Some clients want one routine they repeat every day rather than a week
 * that varies. The dietitian ticks "Same food on all days" on the review page
 * and chooses the dishes for each meal; generation builds that ONE day and
 * repeats it on all 7 days. No model runs at all.
 *
 * THE ONE RULE holds: the dietitian names dishes and may type an exact
 * quantity for any of them; every other gram comes from the same
 * recipe-balancer.ts every other path uses, aimed at the client's real target.
 * A typed quantity is `gramsLocked`, which the balancer holds exactly while
 * re-optimising the rest of the day around it.
 *
 * Off target is a WARNING here, not a rejection: every dish on this menu is
 * the dietitian's explicit choice, and there is nothing a retry could change.
 * The review page shows the day's macros against target before generating,
 * so the dietitian sees this before a plan exists.
 *
 * Pure functions, zero I/O.
 */

import { z } from "zod"

import { isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"
import { recipeAvoidanceConflict, type CompiledAvoidTerm } from "@/lib/foods/recipe-food-avoidance"

import { balanceDayToTargets } from "./recipe-balancer"
import { computeMealsTotals } from "./recipe-grounding"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import type { DailyRecipeTarget, GroundedRecipeDay, MealSlotInfo, RecipeForPipeline } from "./recipe-types"
import { describeMacroProblems } from "./recipe-validate"

export const FIXED_MENU_SLOTS = [
  { slot: "breakfast", label: "Breakfast", required: true },
  { slot: "mid_morning", label: "Mid-morning", required: false },
  { slot: "lunch", label: "Lunch", required: true },
  { slot: "evening", label: "Evening", required: false },
  { slot: "dinner", label: "Dinner", required: true },
] as const

export type FixedMenuSlot = (typeof FIXED_MENU_SLOTS)[number]["slot"]

const SLOT_VALUES = FIXED_MENU_SLOTS.map((s) => s.slot) as [FixedMenuSlot, ...FixedMenuSlot[]]
const MAX_ITEMS_PER_SLOT = 6

export const fixedMenuItemSchema = z.object({
  slot: z.enum(SLOT_VALUES),
  recipeId: z.string().uuid(),
  // The same 5-1000 g plausibility envelope ingestion applies to a serving.
  grams: z.number().min(5, "A quantity must be at least 5 g.").max(1000, "A quantity must be at most 1000 g.").nullable(),
})
export type FixedMenuItem = z.infer<typeof fixedMenuItemSchema>

export const fixedMenuItemsSchema = z.array(fixedMenuItemSchema).max(FIXED_MENU_SLOTS.length * MAX_ITEMS_PER_SLOT)

export class FixedMenuError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FixedMenuError"
  }
}

export function slotLabel(slot: string): string {
  return FIXED_MENU_SLOTS.find((s) => s.slot === slot)?.label ?? slot
}

/** Everything that stops a menu from being usable. Empty = usable. */
export function fixedMenuProblems(items: readonly FixedMenuItem[]): string[] {
  const problems: string[] = []
  for (const { slot, label, required } of FIXED_MENU_SLOTS) {
    const inSlot = items.filter((i) => i.slot === slot)
    if (required && inSlot.length === 0) problems.push(`${label} needs at least one dish.`)
    if (inSlot.length > MAX_ITEMS_PER_SLOT) problems.push(`${label} has more than ${MAX_ITEMS_PER_SLOT} dishes.`)
    if (new Set(inSlot.map((i) => i.recipeId)).size < inSlot.length) problems.push(`${label} has the same dish twice.`)
  }
  return problems
}

/**
 * The one day, balanced toward the target. Meals follow the client's own
 * meal-template order; a slot the dietitian left empty is simply absent.
 * Throws FixedMenuError if a dish or slot cannot be served — never silently
 * drops what the dietitian chose.
 */
export function buildFixedMenuDay(
  items: readonly FixedMenuItem[],
  recipesById: ReadonlyMap<string, RecipeForPipeline>,
  slots: readonly MealSlotInfo[],
  target: DailyRecipeTarget
): GroundedRecipeDay {
  const problems = fixedMenuProblems(items)
  if (problems.length > 0) throw new FixedMenuError(problems.join(" "))

  const templateSlots = new Set(slots.map((s) => s.slot))
  for (const item of items) {
    if (!templateSlots.has(item.slot)) {
      throw new FixedMenuError(`${slotLabel(item.slot)} is not one of this client's meals — remove its dishes or change the meal count.`)
    }
  }

  const meals = [...slots]
    .sort((a, b) => a.slotOrder - b.slotOrder)
    .map((s) => ({
      slot: s.slot,
      items: items
        .filter((i) => i.slot === s.slot)
        .map((i) => {
          const recipe = recipesById.get(i.recipeId)
          if (!recipe) throw new FixedMenuError(`A dish on the fixed menu (${slotLabel(i.slot)}) no longer exists — remove it and choose again.`)
          return i.grams === null ? { recipe, grams: recipe.idealGrams } : { recipe, grams: i.grams, gramsLocked: true }
        }),
    }))
    .filter((m) => m.items.length > 0)

  const unbalanced: GroundedRecipeDay = { dayIndex: 0, meals, totals: computeMealsTotals(meals), cappedRecipeNames: [], unknownRecipeNames: [] }
  return balanceDayToTargets(unbalanced, target)
}

/** The same day on every day of the week. Each day gets its own objects, so a later per-day edit can never leak into another day. */
export function repeatFixedMenuDay(day: GroundedRecipeDay, dayCount = 7): GroundedRecipeDay[] {
  return Array.from({ length: dayCount }, (_, dayIndex) => ({
    ...day,
    dayIndex,
    meals: day.meals.map((m) => ({ ...m, items: m.items.map((i) => ({ ...i })) })),
    totals: { ...day.totals },
    cappedRecipeNames: [...day.cappedRecipeNames],
    unknownRecipeNames: [...day.unknownRecipeNames],
  }))
}

/**
 * What the dietitian is told about the plan. Stated once, not seven times —
 * every day is identical. Variety warnings are deliberately absent: repeating
 * the same dishes is the point of this plan, not a flaw in it.
 */
export function fixedMenuWarnings(day: GroundedRecipeDay, target: DailyRecipeTarget, constraints: ClientRecipeConstraints): string[] {
  const warnings = [
    ...describeMacroProblems(day.totals, target).map((p) => `Every day: ${p}`),
    ...describePlausibilityProblems(day, constraints).map((p) => `Every day: ${p}`),
  ]
  if (warnings.length > 0) {
    warnings.unshift(
      "NEEDS DIETITIAN REVIEW — this fixed menu (same food on all days) has the problems below, which apply to every day. " +
        "Change the dishes or quantities on the review page and generate again, or accept it as it is."
    )
  }
  return warnings
}

export interface FixedMenuClient {
  dietType: string
  allergenTags: readonly string[]
  avoidTerms: readonly CompiledAvoidTerm[]
}

/**
 * Why this dish may not go on this client's fixed menu, or null if it may.
 * The picker, the save and generation all ask this one question.
 *
 * Diet type, allergies and dislikes are the same hard rules every other
 * recipe path applies. Cuisine and season are deliberately NOT checked: the
 * dietitian is choosing the client's own routine by hand, and "the client
 * eats poha every morning" is not wrong because poha is tagged Maharashtrian.
 */
export function fixedMenuRecipeRefusal(
  recipe: Pick<RecipeForPipeline, "name" | "dietTypes" | "allergenTags" | "isActive" | "kcalPer100G">,
  client: FixedMenuClient
): string | null {
  if (!recipe.isActive) return `${recipe.name} has been retired from the recipe list.`
  if (recipe.kcalPer100G <= 0) return `${recipe.name} has no recorded energy, so it cannot be counted in a plan.`
  if (!isRecipeAllowedForDiet(recipe, client.dietType)) return `${recipe.name} is not suitable for a ${client.dietType} client.`
  const avoidance = recipeAvoidanceConflict(recipe, client.allergenTags, client.avoidTerms)
  if (avoidance) return `${recipe.name} ${avoidance}.`
  return null
}

/** Every reason the saved menu cannot be served to this client right now. Answers can change after the menu was saved. */
export function fixedMenuRefusals(
  items: readonly FixedMenuItem[],
  recipesById: ReadonlyMap<string, RecipeForPipeline>,
  client: FixedMenuClient
): string[] {
  const refusals: string[] = []
  for (const item of items) {
    const recipe = recipesById.get(item.recipeId)
    const refusal = recipe
      ? fixedMenuRecipeRefusal(recipe, client)
      : `A dish on the fixed menu (${slotLabel(item.slot)}) no longer exists.`
    if (refusal) refusals.push(`${slotLabel(item.slot)}: ${refusal}`)
  }
  return refusals
}
