"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { counsellingSessions, dietPlanDays, dietPlanItems, dietPlanMeals, dietPlanRecipeItems, dietPlans, foods, recipes, roadmaps } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { clientAllergensFromAnswers, clientDislikesFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { filterEligibleFoods, type EligibilityCriteria } from "@/lib/plan/eligible-foods"
import { and, inArray } from "drizzle-orm"
import { weekTargets, type RoadmapResult } from "@/lib/counselling/roadmap"
import { clientRecipeAllergenTagsFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { eligibleCuisinesFor, type RecipeCuisine } from "@/lib/foods/recipe-cuisine-mapping"
import { RECIPE_PIPELINE_COLUMNS, type DailyRecipeTarget } from "@/lib/plan/recipe-types"
import { deviationOf, rebalanceDay, weeklyAverageOf, type StoredRecipeMeal } from "@/lib/plan/recipe-swap"
import { buildRecipeWarnings, offTargetSummary } from "@/lib/plan/recipe-warnings"
import { seasonFor } from "@/lib/plan/season"
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
// Recipe-engine swaps
//
// A separate path from the exchange swap above, because the two guarantee
// different things. An exchange swap keeps the exchange type and count, so
// macros are unchanged by construction. A recipe swap replaces a dish with
// one that has entirely different per-100g macros and its own serving range,
// so the whole day must be re-balanced and the plan's totals recomputed.
//
// getSwapCandidates/swapPlanItem dispatch on which table the id belongs to,
// so swap-item-button.tsx needs no change and no knowledge of which engine
// produced the plan it is rendering.
// ---------------------------------------------------------------------------

async function loadRecipeItemContext(itemId: string) {
  const [row] = await db
    .select({ item: dietPlanRecipeItems, meal: dietPlanMeals, day: dietPlanDays, plan: dietPlans })
    .from(dietPlanRecipeItems)
    .innerJoin(dietPlanMeals, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlans, eq(dietPlanDays.dietPlanId, dietPlans.id))
    .where(eq(dietPlanRecipeItems.id, itemId))
    .limit(1)
  if (!row) return null

  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, row.plan.roadmapId)).limit(1)
  if (!roadmapRow) return null
  const [sessionRow] = await db
    .select()
    .from(counsellingSessions)
    .where(eq(counsellingSessions.id, roadmapRow.sessionId))
    .limit(1)
  const answers = (sessionRow?.answers ?? {}) as Answers

  // `region` carries the cuisine string for recipe-engine plans — the same
  // column reuse generation made (see CLAUDE.md "The recipe engine").
  const cuisine = row.plan.region as RecipeCuisine
  const wt = weekTargets(roadmapRow.output as RoadmapResult, row.plan.weekNumber)
  const target: DailyRecipeTarget = {
    kcal: wt.kcal,
    proteinG: wt.proteinG,
    carbsG: wt.carbsG,
    fatG: wt.fatG,
    fiberG: wt.fibreG,
  }

  return {
    ...row,
    cuisine,
    target,
    // Re-derived live, not snapshotted: an allergy correction made after
    // generation must immediately narrow what the picker offers — the same
    // reasoning the exchange swap's own context already uses.
    allergenTags: clientRecipeAllergenTagsFromAnswers(answers),
    season: seasonFor(row.plan.weekStart, cuisine),
  }
}

async function recipeSwapCandidates(itemId: string): Promise<SwapCandidate[]> {
  const ctx = await loadRecipeItemContext(itemId)
  if (!ctx) return []

  const rows = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisinesFor(ctx.cuisine))))

  return rows
    .filter(
      (r) =>
        r.id !== ctx.item.recipeId &&
        r.dietTypes.includes(ctx.plan.dietType) &&
        (r.season === "all_year" || r.season === ctx.season) &&
        !r.allergenTags.some((t) => ctx.allergenTags.includes(t)) &&
        // Same rule the generator's pool filter applies: a row claiming to be
        // food with no energy is not offerable (recipe-pool-filters.ts).
        r.kcalPer100G > 0
    )
    .map((r) => ({ id: r.id, nameEn: r.name, householdMeasure: r.unitLabel }))
    .sort((a, b) => a.nameEn.localeCompare(b.nameEn))
}

async function performRecipeSwap(itemId: string, newRecipeId: string): Promise<string> {
  const ctx = await loadRecipeItemContext(itemId)
  if (!ctx) throw new SwapValidationError("Item not found.")
  if (ctx.plan.status === "approved") {
    throw new SwapValidationError("This plan is already approved — swaps are locked.")
  }

  const [newRecipe] = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(eq(recipes.id, newRecipeId))
    .limit(1)
  if (!newRecipe) throw new SwapValidationError("Recipe not found.")
  if (!newRecipe.dietTypes.includes(ctx.plan.dietType)) {
    throw new SwapValidationError(`${newRecipe.name} is not suitable for a ${ctx.plan.dietType} client — swap rejected.`)
  }
  const blocked = newRecipe.allergenTags.filter((t) => ctx.allergenTags.includes(t))
  if (blocked.length > 0) {
    throw new SwapValidationError(
      `${newRecipe.name} contains ${blocked.join(", ")}, which this client must avoid — swap rejected.`
    )
  }

  await db.transaction(async (tx) => {
    // 1. Substitute the recipe, snapshotting macros from the row as it is
    //    today — this item is being written now, so today's figures are its
    //    honest provenance. Every other item keeps its own snapshot.
    await tx
      .update(dietPlanRecipeItems)
      .set({
        recipeId: newRecipe.id,
        proteinPer100GSnapshot: newRecipe.proteinPer100G,
        carbsPer100GSnapshot: newRecipe.carbsPer100G,
        fatPer100GSnapshot: newRecipe.fatPer100G,
        fiberPer100GSnapshot: newRecipe.fiberPer100G,
      })
      .where(eq(dietPlanRecipeItems.id, itemId))

    // 2. Load the whole plan. Only the edited day's grams can actually move,
    //    but the plan's weekly average is computed across all seven, so all
    //    are needed.
    const dayRows = await tx.select().from(dietPlanDays).where(eq(dietPlanDays.dietPlanId, ctx.plan.id))
    const mealRows = await tx
      .select()
      .from(dietPlanMeals)
      .where(
        inArray(
          dietPlanMeals.dietPlanDayId,
          dayRows.map((d) => d.id)
        )
      )
    const itemRows = await tx
      .select({ item: dietPlanRecipeItems, recipe: RECIPE_PIPELINE_COLUMNS })
      .from(dietPlanRecipeItems)
      .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
      .where(
        inArray(
          dietPlanRecipeItems.dietPlanMealId,
          mealRows.map((m) => m.id)
        )
      )

    const balancedDays = []
    for (const dayRow of [...dayRows].sort((a, b) => a.dayIndex - b.dayIndex)) {
      const meals: StoredRecipeMeal[] = mealRows
        .filter((m) => m.dietPlanDayId === dayRow.id)
        .sort((a, b) => a.slotOrder - b.slotOrder)
        .map((m) => ({
          slot: m.slot,
          items: itemRows
            .filter((r) => r.item.dietPlanMealId === m.id)
            .map((r) => ({
              id: r.item.id,
              grams: r.item.grams,
              recipe: r.recipe,
              proteinPer100GSnapshot: r.item.proteinPer100GSnapshot,
              carbsPer100GSnapshot: r.item.carbsPer100GSnapshot,
              fatPer100GSnapshot: r.item.fatPer100GSnapshot,
              fiberPer100GSnapshot: r.item.fiberPer100GSnapshot,
            })),
        }))

      // 3. Re-optimise the day. Item identity is untouched; only grams move,
      //    and they come from the same deterministic balancer the generator
      //    uses — no model is involved in a swap at all.
      const balanced = rebalanceDay(dayRow.dayIndex, meals, ctx.target)
      balancedDays.push(balanced)

      const flatStored = meals.flatMap((m) => m.items)
      const flatBalanced = balanced.meals.flatMap((m) => m.items)
      for (let i = 0; i < flatStored.length; i++) {
        if (flatStored[i].grams !== flatBalanced[i].grams) {
          await tx
            .update(dietPlanRecipeItems)
            .set({ grams: flatBalanced[i].grams })
            .where(eq(dietPlanRecipeItems.id, flatStored[i].id))
        }
      }

      await tx
        .update(dietPlanDays)
        .set({
          achieved: {
            kcal: balanced.totals.kcal,
            proteinG: balanced.totals.proteinG,
            carbsG: balanced.totals.carbsG,
            fatG: balanced.totals.fatG,
            fibreG: balanced.totals.fiberG,
          },
        })
        .where(eq(dietPlanDays.id, dayRow.id))
    }

    // 4. Recompute the plan-level figures the dietitian judges the plan on,
    //    including the warnings banner — a swap can fix a macro miss, and the
    //    page must stop claiming it if so.
    const achieved = weeklyAverageOf(balancedDays.map((d) => d.totals))
    const warnings = buildRecipeWarnings(balancedDays, ctx.target, {
      dietType: ctx.plan.dietType,
      eligibleCuisines: eligibleCuisinesFor(ctx.cuisine),
      allergenTags: ctx.allergenTags,
    })
    const summary = offTargetSummary(achieved, ctx.target, balancedDays.length)
    if (summary) warnings.unshift(summary)

    await tx
      .update(dietPlans)
      .set({ achieved, deviation: deviationOf(achieved, ctx.target), warnings })
      .where(eq(dietPlans.id, ctx.plan.id))
  })

  return ctx.plan.id
}
