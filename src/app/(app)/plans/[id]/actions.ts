"use server"

import { and, eq, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { counsellingSessions, dietPlanDays, dietPlanItems, dietPlanMeals, dietPlanRecipeItems, dietPlans, foods, recipes, roadmaps } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { clientAllergensFromAnswers, clientDislikesFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { clientFoodRules, foodRuleViolation, recipeRuleViolation } from "@/lib/plan/client-food-rules"
import { dateLabel } from "@/lib/plan/plan-guidelines"
import { dayFoodRulesFromAnswers, foodDayRuleViolationOnDate } from "@/lib/plan/day-food-rules"
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
import { MealNoteValidationError, normalizeMealNote } from "@/lib/plan/meal-note"
import { recipeToCandidate as toCandidate, type SwapCandidate } from "@/lib/plan/recipe-candidate"
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
    .select({ item: dietPlanItems, meal: dietPlanMeals, day: dietPlanDays, plan: dietPlans })
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

  return { ...row, criteria, dayRules: dayFoodRulesFromAnswers(answers) }
}

// Moved to lib so the review page's fixed-menu picker builds the same rows.
export type { SwapCandidate } from "@/lib/plan/recipe-candidate"

export async function getSwapCandidates(itemId: string): Promise<SwapCandidate[]> {
  await requireStaffUser()
  itemId = uuidSchema.parse(itemId)

  // One action, both engines. The id identifies which table the item lives
  // in, so the UI never has to know which pipeline produced the plan.
  const ctx = await loadItemContext(itemId)
  if (!ctx) return recipeSwapCandidates(itemId)

  const sameType = await db.select().from(foods).where(eq(foods.exchangeType, ctx.item.exchangeType))
  const eligible = filterEligibleFoods(sameType, ctx.criteria).filter(
    (f) => f.mealSlots.includes(ctx.meal.slot) && foodDayRuleViolationOnDate(f, ctx.dayRules, ctx.day.date) === null
  )

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
    // The client page shows each week's kcal/protein — keep it current after every edit.
    revalidatePath("/clients", "layout")
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
  const dayViolation = foodDayRuleViolationOnDate(newFood, ctx.dayRules, ctx.day.date)
  if (dayViolation) throw new SwapValidationError(`${newFood.nameEn} cannot go on ${dateLabel(ctx.day.date)}: ${dayViolation}.`)

  // Exchange count never changes on a swap — same exchange type, same count,
  // only the food identity and its resulting gram weight change. Macros are
  // therefore unaffected: this is the exchange system's core guarantee (see
  // CLAUDE.md "THE ONE RULE THAT MATTERS").
  const servingRawG =
    newFood.servingRawG === null ? null : (ctx.item.exchangeCount / newFood.exchangeUnits) * newFood.servingRawG

  await db.update(dietPlanItems).set({ foodId: newFood.id, servingRawG }).where(eq(dietPlanItems.id, itemId))

  revalidatePath(`/plans/${ctx.plan.id}`)
  revalidatePath("/clients", "layout")
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

  // Never approve a plan carrying a dish this client must not have: the wrong
  // diet type (by the dish's own evidence), a declared allergen, or a dislike.
  // Read against the LIVE recipe/food rows and the LIVE counselling answers,
  // so this also catches a plan generated before a check existed, or before
  // the client's answers were corrected. Same rule as the plan page's red
  // banner (client-food-rules.ts), so the two cannot disagree.
  const [sessionRow] = await db
    .select({ answers: counsellingSessions.answers })
    .from(roadmaps)
    .innerJoin(counsellingSessions, eq(roadmaps.sessionId, counsellingSessions.id))
    .where(eq(roadmaps.id, plan.roadmapId))
    .limit(1)
  const rules = clientFoodRules((sessionRow?.answers ?? {}) as Answers, plan.dietType)
  const forbidden = new Set<string>()
  if (plan.engine === "recipe") {
    const items = await db
      .select({ name: recipes.name, dietTypes: recipes.dietTypes, allergenTags: recipes.allergenTags, date: dietPlanDays.date })
      .from(dietPlanRecipeItems)
      .innerJoin(dietPlanMeals, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
      .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
      .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
      .where(eq(dietPlanDays.dietPlanId, planId))
    for (const r of items) {
      const v = recipeRuleViolation(r, rules, r.date)
      if (v) forbidden.add(`${r.name} on ${dateLabel(r.date)} (${v})`)
    }
  } else {
    const items = await db
      .select({ nameEn: foods.nameEn, dietTypes: foods.dietTypes, allergens: foods.allergens, date: dietPlanDays.date })
      .from(dietPlanItems)
      .innerJoin(dietPlanMeals, eq(dietPlanItems.dietPlanMealId, dietPlanMeals.id))
      .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
      .innerJoin(foods, eq(dietPlanItems.foodId, foods.id))
      .where(eq(dietPlanDays.dietPlanId, planId))
    for (const f of items) {
      const v = foodRuleViolation(f, rules, f.date)
      if (v) forbidden.add(`${f.nameEn} on ${dateLabel(f.date)} (${v})`)
    }
  }
  if (forbidden.size > 0) {
    throw new Error(
      `This plan contains food this client must not have: ${[...forbidden].join("; ")}. Swap them out or regenerate the plan before approving.`
    )
  }

  await db.update(dietPlans).set({ status: "approved" }).where(eq(dietPlans.id, planId))
  revalidatePath(`/plans/${planId}`)
  revalidatePath("/clients", "layout")
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

async function recipeSwapCandidates(itemId: string): Promise<SwapCandidate[]> {
  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) return []

  const pool = await eligibleRecipesForPlan(loaded.ctx, loaded.day.date)
  return pool
    .filter((r) => r.id !== loaded.item.recipeId)
    .map(toCandidate)
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn))
}

async function performRecipeSwap(itemId: string, newRecipeId: string): Promise<string> {
  const loaded = await loadRecipeItemContext(itemId)
  if (!loaded) throw new PlanEditError("Item not found.")
  assertEditable(loaded.ctx)

  // Inactive = retired by a dietitian (recipe-curation-overrides.ts); the picker never offers it.
  const [newRecipe] = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.id, newRecipeId), eq(recipes.isActive, true)))
    .limit(1)
  if (!newRecipe) throw new PlanEditError("Recipe not found, or no longer in use.")
  assertRecipeAllowed(newRecipe, loaded.ctx, loaded.day.date)

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
  revalidatePath("/clients", "layout")
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
  revalidatePath("/clients", "layout")
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
  revalidatePath("/clients", "layout")
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
  revalidatePath("/clients", "layout")
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
  revalidatePath("/clients", "layout")
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

  const pool = await eligibleRecipesForPlan(loaded.ctx, loaded.day.date)
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

  // Inactive = retired by a dietitian (recipe-curation-overrides.ts); the picker never offers it.
  const [recipe] = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.id, recipeId), eq(recipes.isActive, true)))
    .limit(1)
  if (!recipe) throw new PlanEditError("Recipe not found, or no longer in use.")
  assertRecipeAllowed(recipe, loaded.ctx, loaded.day.date)

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
  revalidatePath("/clients", "layout")
}

// ---------------------------------------------------------------------------
// Meal notes
// ---------------------------------------------------------------------------

export type SetMealNoteResult = { ok: true; mealsUpdated: number } | { ok: false; error: string }

/**
 * Saves (or, with an empty note, clears) the dietitian's note on one meal.
 * With `applyToSameSlotEveryDay`, the same note is written to that slot on
 * every day of the plan — "every lunch: have with a glass of chaas" — which
 * is just the same write to seven rows; each day's note stays independently
 * editable afterwards.
 *
 * Works for both engines: a note is display text, so it never touches the
 * items, re-balances nothing and recomputes nothing. Locked once the plan is
 * approved, like every other edit, since the approved PDF is what the client
 * was given.
 *
 * A validation problem (too long, a character the PDF font can't print) is
 * RETURNED rather than thrown, so its message reaches the dialog intact —
 * Next.js replaces a thrown Server Action error's message in production.
 */
export async function setMealNote(
  mealId: string,
  note: string,
  applyToSameSlotEveryDay: boolean
): Promise<SetMealNoteResult> {
  await requireStaffUser()
  mealId = uuidSchema.parse(mealId)
  const rawNote = z.string().max(5000).parse(note)
  const applyAll = z.boolean().parse(applyToSameSlotEveryDay)

  let normalized: string | null
  try {
    normalized = normalizeMealNote(rawNote)
  } catch (err) {
    if (err instanceof MealNoteValidationError) return { ok: false, error: err.message }
    throw err
  }

  const [row] = await db
    .select({ slot: dietPlanMeals.slot, planId: dietPlans.id, status: dietPlans.status })
    .from(dietPlanMeals)
    .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlans, eq(dietPlanDays.dietPlanId, dietPlans.id))
    .where(eq(dietPlanMeals.id, mealId))
    .limit(1)
  if (!row) return { ok: false, error: "Meal not found." }
  if (row.status === "approved") return { ok: false, error: "This plan is already approved - edits are locked." }

  let mealsUpdated = 1
  if (applyAll) {
    const sameSlot = await db
      .select({ id: dietPlanMeals.id })
      .from(dietPlanMeals)
      .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
      .where(and(eq(dietPlanDays.dietPlanId, row.planId), eq(dietPlanMeals.slot, row.slot)))
    const ids = sameSlot.map((m) => m.id)
    await db.update(dietPlanMeals).set({ note: normalized }).where(inArray(dietPlanMeals.id, ids))
    mealsUpdated = ids.length
  } else {
    await db.update(dietPlanMeals).set({ note: normalized }).where(eq(dietPlanMeals.id, mealId))
  }

  revalidatePath(`/plans/${row.planId}`)
  revalidatePath("/clients", "layout")
  return { ok: true, mealsUpdated }
}
