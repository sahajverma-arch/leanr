"use server"

import { and, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { counsellingSessions, dietPlanDays, dietPlanItems, dietPlanMeals, dietPlanRecipeItems, dietPlans, foods, recipes, roadmaps } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { clientAllergensFromAnswers, clientDislikesFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { filterEligibleFoods, type EligibilityCriteria } from "@/lib/plan/eligible-foods"
import {
  assertEditable,
  assertRecipeAllowed,
  eligibleRecipesForPlan,
  loadRecipeItemContext,
  loadRecipeMealContext,
  PlanEditError,
  recomputePlanAfterEdit,
} from "@/lib/plan/recipe-plan-edit"
import { setIngredientQuantity } from "@/lib/plan/ingredient-edit"
import {
  clearItemOverrides,
  loadItemPortion,
  toIngredientState,
  upsertItemOverride,
  writePortionToItem,
  type PlanItemIngredientState,
} from "@/lib/plan/plan-item-ingredients"
import { macroProfileTags, type MacroProfileTag } from "@/lib/plan/recipe-macro-profile"
import { MANUAL_GRAMS_CEILING_G, MANUAL_GRAMS_FLOOR_G } from "@/lib/plan/recipe-quantity-step"
import { RECIPE_PIPELINE_COLUMNS } from "@/lib/plan/recipe-types"
import { ACCEPTANCE_FRACTION } from "@/lib/plan/exchange-solver"

class SwapValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SwapValidationError"
  }
}

// Every ID here is normally sourced from server-rendered data (never
// user-typed), and Drizzle always parameterizes — so this isn't closing an
// injection hole, it's rejecting a malformed ID with a clear message
// instead of a confusing "not found" from a Server Action, which is
// reachable directly regardless of what the UI ever sends it.
const uuidSchema = z.string().uuid()

/**
 * Allergens/dislikes are re-derived live from the session's current
 * answers, not snapshotted on the plan — unlike region/dietType, an
 * allergy correction made after generation must immediately narrow what
 * the swap picker offers, never keep offering a food against stale data.
 */
async function loadItemContext(itemId: string) {
  const [row] = await db
    .select({ item: dietPlanItems, meal: dietPlanMeals, plan: dietPlans })
    .from(dietPlanItems)
    .innerJoin(dietPlanMeals, eq(dietPlanItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlans, eq(dietPlanDays.dietPlanId, dietPlans.id))
    .where(eq(dietPlanItems.id, itemId))
    .limit(1)
  if (!row) return null

  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, row.plan.roadmapId)).limit(1)
  const sessionRows = roadmapRow
    ? await db.select().from(counsellingSessions).where(eq(counsellingSessions.id, roadmapRow.sessionId)).limit(1)
    : []
  const answers = (sessionRows[0]?.answers ?? {}) as Answers

  const criteria: EligibilityCriteria = {
    region: row.plan.region,
    dietType: row.plan.dietType,
    clientAllergens: clientAllergensFromAnswers(answers),
    clientDislikes: clientDislikesFromAnswers(answers),
  }

  return { ...row, criteria }
}

export interface SwapCandidate {
  id: string
  nameEn: string
  householdMeasure: string | null
  /**
   * Recipe-engine only: what this dish would actually cost, at its own
   * typical portion. A picker that lists names alone tells a dietitian
   * nothing about the one thing they are choosing on - see CLAUDE.md
   * "Editing a saved plan".
   */
  preview?: { grams: number; kcal: number; proteinG: number; carbsG: number; fatG: number }
  /**
   * Recipe-engine only: which macro-profile filters this dish satisfies,
   * computed from its own verified per-100g macros (recipe-macro-profile.ts).
   * Sent with the candidate rather than recomputed in the browser so the chip
   * and the numbers printed beside it can never disagree.
   */
  macroTags?: MacroProfileTag[]
}

export async function getSwapCandidates(itemId: string): Promise<SwapCandidate[]> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  // One action, both engines. The id identifies which table the item lives
  // in, so the UI never has to know which pipeline produced the plan.
  const ctx = await loadItemContext(itemId)
  if (!ctx) return recipeSwapCandidates(itemId)

  const sameType = await db.select().from(foods).where(eq(foods.exchangeType, ctx.item.exchangeType))
  const eligible = filterEligibleFoods(sameType, ctx.criteria).filter((f) => f.mealSlots.includes(ctx.meal.slot))

  return eligible
    .filter((f) => f.id !== ctx.item.foodId)
    .map((f) => ({ id: f.id, nameEn: f.nameEn, householdMeasure: f.householdMeasure }))
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn))
}

export async function swapPlanItem(itemId: string, newFoodId: string): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)
  newFoodId = uuidSchema.parse(newFoodId)

  const ctx = await loadItemContext(itemId)
  if (!ctx) {
    // Not an exchange item — a recipe item, which needs the whole day
    // re-balanced rather than a like-for-like substitution.
    const planId = await performRecipeSwap(itemId, newFoodId)
    revalidatePath(`/plans/${planId}`)
    return
  }
  if (ctx.plan.status === "approved") {
    throw new SwapValidationError("This plan is already approved — swaps are locked.")
  }

  const [newFood] = await db.select().from(foods).where(eq(foods.id, newFoodId)).limit(1)
  if (!newFood) throw new SwapValidationError("Food not found.")
  if (newFood.exchangeType !== ctx.item.exchangeType) {
    throw new SwapValidationError(`${newFood.nameEn} is exchange type ${newFood.exchangeType}, not ${ctx.item.exchangeType} — swap rejected.`)
  }

  const eligible = filterEligibleFoods([newFood], ctx.criteria)
  if (eligible.length === 0 || !newFood.mealSlots.includes(ctx.meal.slot)) {
    throw new SwapValidationError(`${newFood.nameEn} is not eligible for this client at ${ctx.meal.slot}.`)
  }

  // Exchange count never changes on a swap — same exchange type, same count,
  // only the food identity and its resulting gram weight change. Macros are
  // therefore unaffected: this is the exchange system's core guarantee (see
  // CLAUDE.md "THE ONE RULE THAT MATTERS").
  const servingRawG =
    newFood.servingRawG === null ? null : (ctx.item.exchangeCount / newFood.exchangeUnits) * newFood.servingRawG

  await db.update(dietPlanItems).set({ foodId: newFood.id, servingRawG }).where(eq(dietPlanItems.id, itemId))

  revalidatePath(`/plans/${ctx.plan.id}`)
}

export async function approvePlan(planId: string): Promise<void> {
  await requireStaffUser()
  planId = uuidSchema.parse(planId)

  const [plan] = await db.select().from(dietPlans).where(eq(dietPlans.id, planId)).limit(1)
  if (!plan) throw new Error("Plan not found.")

  const deviations = plan.deviation as Array<{ kcal: number; proteinG: number; fatG: number; carbsG: number }>
  const offending = deviations.some(
    (d) =>
      d.kcal >= ACCEPTANCE_FRACTION ||
      d.proteinG >= ACCEPTANCE_FRACTION ||
      d.fatG >= ACCEPTANCE_FRACTION ||
      d.carbsG >= ACCEPTANCE_FRACTION
  )
  if (offending) {
    throw new Error(
      `Plan deviation exceeds ${ACCEPTANCE_FRACTION * 100}% on at least one macro — cannot approve. Regenerate the plan instead.`
    )
  }

  await db.update(dietPlans).set({ status: "approved" }).where(eq(dietPlans.id, planId))
  revalidatePath(`/plans/${planId}`)
}

// ---------------------------------------------------------------------------
// Recipe-engine plan edits
//
// A separate path from the exchange swap above, because the two guarantee
// different things. An exchange swap keeps the exchange type and count, so
// macros are unchanged by construction. Every recipe-engine edit - swap,
// delete, add, or a hand-set quantity - changes the day's macros outright, so
// the whole day is re-balanced and the plan's totals recomputed. That shared
// tail lives in recipe-plan-edit.ts; these functions only do the edit itself.
//
// getSwapCandidates/swapPlanItem dispatch on which table the id belongs to,
// so swap-item-button.tsx needs no change and no knowledge of which engine
// produced the plan it is rendering.
// ---------------------------------------------------------------------------

/**
 * One recipe row as the picker needs it: its macros at its own authored
 * typical portion, plus the macro-profile tags the filter chips act on. Both
 * derived from the same per-100g figures, so a dish tagged "high protein"
 * always shows a protein figure that justifies it.
 */
function toCandidate(recipe: {
  id: string
  name: string
  unitLabel: string | null
  idealGrams: number
  kcalPer100G: number
  proteinPer100G: number
  carbsPer100G: number
  fatPer100G: number
}): SwapCandidate {
  const f = recipe.idealGrams / 100
  return {
    id: recipe.id,
    nameEn: recipe.name,
    householdMeasure: recipe.unitLabel,
    preview: {
      grams: recipe.idealGrams,
      kcal: recipe.kcalPer100G * f,
      proteinG: recipe.proteinPer100G * f,
      carbsG: recipe.carbsPer100G * f,
      fatG: recipe.fatPer100G * f,
    },
    macroTags: macroProfileTags(recipe),
  }
}

async function recipeSwapCandidates(itemId: string): Promise<SwapCandidate[]> {
  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) return []

  const pool = await eligibleRecipesForPlan(loaded.ctx)
  return pool
    .filter((r) => r.id !== loaded.item.recipeId)
    .map(toCandidate)
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn))
}

async function performRecipeSwap(itemId: string, newRecipeId: string): Promise<string> {
  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found.")
  assertEditable(loaded.ctx)

  const [newRecipe] = await db.select(RECIPE_PIPELINE_COLUMNS).from(recipes).where(eq(recipes.id, newRecipeId)).limit(1)
  if (!newRecipe) throw new PlanEditError("Recipe not found.")
  assertRecipeAllowed(newRecipe, loaded.ctx)

  await db.transaction(async (tx) => {
    // Substitute the recipe, snapshotting macros from the row as it is today
    // - this item is being written now, so today's figures are its honest
    // provenance. Every other item keeps its own snapshot.
    //
    // The new dish starts at its OWN typical portion rather than inheriting
    // the replaced dish's grams, which may sit far outside its serving range:
    // that is the same seed generation uses, so the re-balance below starts
    // where generation would have. A hand-set lock is cleared for the same
    // reason - the quantity a dietitian chose was for a different dish.
    await tx
      .update(dietPlanRecipeItems)
      .set({
        recipeId: newRecipe.id,
        grams: newRecipe.idealGrams,
        gramsLocked: false,
        proteinPer100GSnapshot: newRecipe.proteinPer100G,
        carbsPer100GSnapshot: newRecipe.carbsPer100G,
        fatPer100GSnapshot: newRecipe.fatPer100G,
        fiberPer100GSnapshot: newRecipe.fiberPer100G,
      })
      .where(eq(dietPlanRecipeItems.id, itemId))

    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  return loaded.ctx.planId
}

/**
 * Remove one item from a meal.
 *
 * A meal CAN be emptied this way, and that is deliberate. The plausibility
 * checker already reports an empty slot ("breakfast has no resolved items")
 * and recomputePlanAfterEdit re-runs it, so the plan page says so in the
 * amber banner immediately. Refusing the delete outright would be the system
 * overruling the dietitian on a judgement that is theirs; saying nothing
 * would hide it. Warning loudly is the honest middle.
 */
export async function deletePlanItem(itemId: string): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  await db.transaction(async (tx) => {
    await tx.delete(dietPlanRecipeItems).where(eq(dietPlanRecipeItems.id, itemId))
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}

/**
 * Set one item's quantity by hand, and LOCK it.
 *
 * Locking is what makes the feature mean anything: every edit re-balances the
 * whole day, so an unlocked hand-set quantity would be optimised straight
 * back on the next edit. Locked, the balancer holds this item exactly where
 * the dietitian put it and re-optimises the rest of the day around it - which
 * is what "make it three rotis" actually asks for.
 *
 * The grams come from the stepper, which steps by the recipe's own piece
 * weight when it has one (recipe-quantity-step.ts). Bounds here are the
 * ingestion plausibility envelope, NOT the recipe's authored serving range: a
 * fourth roti past a max of three is a clinical call, not a data error.
 */
export async function setPlanItemGrams(itemId: string, grams: number): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)
  const parsedGrams = z.number().finite().min(MANUAL_GRAMS_FLOOR_G).max(MANUAL_GRAMS_CEILING_G).parse(grams)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  await db.transaction(async (tx) => {
    await tx
      .update(dietPlanRecipeItems)
      .set({ grams: parsedGrams, gramsLocked: true })
      .where(eq(dietPlanRecipeItems.id, itemId))
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}

/**
 * The ingredient breakdown of one plan item, with each ingredient's current
 * amount and what it contributes.
 *
 * Returns `available: false` — never an error — when this recipe is not in the
 * ingredient trial, which is the honest answer for 259 of the 1222 recipes.
 * The panel says so rather than listing a breakdown that cannot be trusted.
 *
 * The amounts are what is on THIS plate, scaled to the item's own weight, not
 * one nominal portion of the recipe.
 */
export async function getPlanItemIngredients(itemId: string): Promise<PlanItemIngredientState> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")

  const [recipe] = await db
    .select({ name: recipes.name })
    .from(recipes)
    .where(eq(recipes.id, loaded.item.recipeId))
    .limit(1)

  const portion = await loadItemPortion(db, itemId, loaded.item.recipeId, loaded.item.grams)
  return toIngredientState(itemId, recipe?.name ?? "", portion, loaded.item.gramsLocked)
}

/**
 * Change how much of one ingredient is in one plan item — "make it 3 eggs".
 *
 * The macro consequence is exact: it comes from that ingredient's own verified
 * per-100g. The dish's plated weight moves by the added raw grams scaled by
 * the recipe's yield factor, which is an estimate, so the gram figure can
 * drift slightly while every macro stays correct.
 *
 * Like every other edit on this page, the whole day is re-balanced afterwards
 * and the plan's weekly average, deviation and warnings are recomputed.
 *
 * A dish whose weight the dietitian pinned keeps that weight: the edit changes
 * what is in those grams and nothing else. See writePortionToItem.
 */
export async function setPlanItemIngredientQuantity(
  itemId: string,
  ingredientId: string,
  quantity: number,
): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)
  ingredientId = uuidSchema.parse(ingredientId)
  const parsedQuantity = z.number().finite().min(0).max(1000).parse(quantity)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  await db.transaction(async (tx) => {
    const portion = await loadItemPortion(tx, itemId, loaded.item.recipeId, loaded.item.grams)
    if (!portion) throw new PlanEditError("This dish has no ingredient breakdown to edit.")

    const name = [...portion.idByName.entries()].find(([, id]) => id === ingredientId)?.[0]
    if (!name) throw new PlanEditError("That ingredient is not part of this dish.")

    const edited = setIngredientQuantity(portion.portion, name, parsedQuantity)
    await upsertItemOverride(tx, itemId, ingredientId, parsedQuantity)
    await writePortionToItem(tx, itemId, edited.recipe, loaded.item.gramsLocked)
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}

/** Drop every ingredient change on an item and return it to the dish as generated. */
export async function resetPlanItemIngredients(itemId: string): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  await db.transaction(async (tx) => {
    await clearItemOverrides(tx, itemId)
    const portion = await loadItemPortion(tx, itemId, loaded.item.recipeId, loaded.item.grams)
    if (portion) await writePortionToItem(tx, itemId, portion.portion, loaded.item.gramsLocked)
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}

/** Hand the quantity back to the solver. The re-balance that follows immediately is free to move it. */
export async function unlockPlanItemGrams(itemId: string): Promise<void> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  await db.transaction(async (tx) => {
    await tx.update(dietPlanRecipeItems).set({ gramsLocked: false }).where(eq(dietPlanRecipeItems.id, itemId))
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}

/**
 * Every dish that could be added to this meal. The same pool generation drew
 * from, minus whatever is already in the meal - a duplicate recipe in one
 * slot is a plausibility problem (recipe-plausibility-validate.ts), so it is
 * kept out of the picker rather than offered and then warned about.
 */
export async function getAddItemCandidates(mealId: string): Promise<SwapCandidate[]> {
  await requireStaffUser()
  mealId = uuidSchema.parse(mealId)

  const loaded = await loadRecipeMealContext(mealId)
  if (!loaded) return []

  const existing = await db
    .select({ recipeId: dietPlanRecipeItems.recipeId })
    .from(dietPlanRecipeItems)
    .where(eq(dietPlanRecipeItems.dietPlanMealId, mealId))
  const alreadyHere = new Set(existing.map((e) => e.recipeId))

  const pool = await eligibleRecipesForPlan(loaded.ctx)
  return pool
    .filter((r) => !alreadyHere.has(r.id))
    .map(toCandidate)
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn))
}

/**
 * Add a dish to a meal.
 *
 * It goes in at the recipe's own authored typical portion (`idealGrams`, the
 * same seed the generator uses) and is then immediately re-balanced with the
 * rest of the day, so the added dish does not simply pile its macros on top
 * of a day that was already on target - everything unlocked shrinks to make
 * room for it.
 */
export async function addPlanItem(mealId: string, recipeId: string): Promise<void> {
  await requireStaffUser()
  mealId = uuidSchema.parse(mealId)
  recipeId = uuidSchema.parse(recipeId)

  const loaded = await loadRecipeMealContext(mealId)
  if (!loaded) throw new PlanEditError("Meal not found, or this plan's items are not editable.")
  assertEditable(loaded.ctx)

  const [recipe] = await db.select(RECIPE_PIPELINE_COLUMNS).from(recipes).where(eq(recipes.id, recipeId)).limit(1)
  if (!recipe) throw new PlanEditError("Recipe not found.")
  assertRecipeAllowed(recipe, loaded.ctx)

  const [duplicate] = await db
    .select({ id: dietPlanRecipeItems.id })
    .from(dietPlanRecipeItems)
    .where(and(eq(dietPlanRecipeItems.dietPlanMealId, mealId), eq(dietPlanRecipeItems.recipeId, recipeId)))
    .limit(1)
  if (duplicate) throw new PlanEditError(`${recipe.name} is already in this meal.`)

  await db.transaction(async (tx) => {
    await tx.insert(dietPlanRecipeItems).values({
      dietPlanMealId: mealId,
      recipeId: recipe.id,
      grams: recipe.idealGrams,
      proteinPer100GSnapshot: recipe.proteinPer100G,
      carbsPer100GSnapshot: recipe.carbsPer100G,
      fatPer100GSnapshot: recipe.fatPer100G,
      fiberPer100GSnapshot: recipe.fiberPer100G,
    })
    await recomputePlanAfterEdit(tx, loaded.ctx)
  })

  revalidatePath(`/plans/${loaded.ctx.planId}`)
}
