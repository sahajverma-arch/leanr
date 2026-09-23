/**
 * Editing a saved recipe-engine plan: everything the four edit paths share.
 *
 * WHY ONE FILE. Deleting an item, adding one, swapping one, and setting a
 * quantity by hand all end the same way - the day has to be re-balanced and
 * the plan's weekly figures recomputed - because recipe-balancer.ts solves a
 * whole day at once, not an item at a time. That tail was written once for
 * the swap path and is extracted here rather than copied four times, so the
 * four edits cannot drift apart on what they recompute or what target they
 * aim at.
 *
 * Nothing here lets a number drift. Every gram still comes out of the same
 * deterministic balancer generation uses, and no model is involved in an edit
 * at all (CLAUDE.md, "THE ONE RULE THAT MATTERS"). The one number a human
 * supplies is a hand-set quantity, which is locked and therefore explicitly
 * theirs, not something the code pretends it solved.
 *
 * Server-only: imports the database. The pure parts live in recipe-swap.ts
 * (re-balance/average/deviation) and recipe-quantity-step.ts (stepping).
 */

import { and, eq, inArray } from "drizzle-orm"

import { db } from "@/db"
import {
  counsellingSessions,
  dietPlanDays,
  dietPlanMeals,
  dietPlanRecipeItems,
  dietPlans,
  recipes,
  roadmaps,
} from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { weekTargets, type RoadmapResult } from "@/lib/counselling/roadmap"
import { foodTargetsAfterSupplement, type PrescribedSupplement } from "@/lib/counselling/supplement-adjusted-targets"
import { isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"
import { applyWeekTargetOverride, type WeekTargetOverride } from "@/lib/counselling/week-target-override"
import { eligibleCuisinesFor, type RecipeCuisine } from "@/lib/foods/recipe-cuisine-mapping"
import { recipeSeasonMatches } from "@/lib/foods/recipe-season-mapping"
import type { Season } from "@/lib/foods/vocab"
import { clientRecipeAllergenTagsFromAnswers } from "@/lib/plan/client-profile-from-answers"
import type { ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { deviationOf, rebalanceDay, weeklyAverageOf, type StoredRecipeMeal } from "./recipe-swap"
import { RECIPE_PIPELINE_COLUMNS, type DailyRecipeTarget, type RecipeForPipeline } from "./recipe-types"
import { buildRecipeWarnings, offTargetSummary } from "./recipe-warnings"
import { seasonFor } from "./season"

/** The transaction handle drizzle hands the callback - typed off db.transaction so it cannot drift from the driver. */
export type PlanTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A plan-edit already rejected before anything was written. Surfaced to the dietitian verbatim. */
export class PlanEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanEditError"
  }
}

export interface RecipePlanContext {
  planId: string
  status: string
  dietType: string
  cuisine: RecipeCuisine
  /**
   * The FOOD target, not the prescribed one. An edit re-balances the day, so
   * it must aim at exactly what generation aimed at - read from the plan's
   * OWN supplement snapshot rather than the live roadmap_supplements row, so
   * that editing a prescription later cannot silently re-balance a plan built
   * before the change.
   */
  target: DailyRecipeTarget
  /**
   * Re-derived live from the session's current answers, never snapshotted: an
   * allergy correction made after generation must immediately narrow what an
   * edit is allowed to put on the plate.
   */
  allergenTags: string[]
  season: Season
  constraints: ClientRecipeConstraints
}

async function contextForPlan(plan: typeof dietPlans.$inferSelect): Promise<RecipePlanContext | null> {
  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, plan.roadmapId)).limit(1)
  if (!roadmapRow) return null
  const [sessionRow] = await db
    .select()
    .from(counsellingSessions)
    .where(eq(counsellingSessions.id, roadmapRow.sessionId))
    .limit(1)
  const answers = (sessionRow?.answers ?? {}) as Answers

  // `region` carries the cuisine string for recipe-engine plans - the same
  // column reuse generation made (see CLAUDE.md "The recipe engine").
  const cuisine = plan.region as RecipeCuisine
  // The plan's OWN snapshot of any review-page week target override, for the
  // same reason the supplement is read from the snapshot below.
  const wt = applyWeekTargetOverride(
    weekTargets(roadmapRow.output as RoadmapResult, plan.weekNumber),
    (plan.targetOverride as WeekTargetOverride | null) ?? null
  )
  const { food } = foodTargetsAfterSupplement(wt, (plan.supplement as PrescribedSupplement | null) ?? null)
  const allergenTags = clientRecipeAllergenTagsFromAnswers(answers)

  return {
    planId: plan.id,
    status: plan.status,
    dietType: plan.dietType,
    cuisine,
    target: { kcal: food.kcal, proteinG: food.proteinG, carbsG: food.carbsG, fatG: food.fatG, fiberG: food.fibreG },
    allergenTags,
    season: seasonFor(plan.weekStart, cuisine),
    constraints: { dietType: plan.dietType, eligibleCuisines: eligibleCuisinesFor(cuisine), allergenTags },
  }
}

/** Context for an edit addressed by ITEM id (delete, quantity, swap). Null when the id is not a recipe item. */
export async function loadRecipeItemContext(itemId: string) {
  const [row] = await db
    .select({ item: dietPlanRecipeItems, meal: dietPlanMeals, day: dietPlanDays, plan: dietPlans })
    .from(dietPlanRecipeItems)
    .innerJoin(dietPlanMeals, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlans, eq(dietPlanDays.dietPlanId, dietPlans.id))
    .where(eq(dietPlanRecipeItems.id, itemId))
    .limit(1)
  if (!row) return null
  const ctx = await contextForPlan(row.plan)
  if (!ctx) return null
  return { ...row, ctx }
}

/** Context for an edit addressed by MEAL id (add an item). Null when the meal does not belong to a recipe-engine plan. */
export async function loadRecipeMealContext(mealId: string) {
  const [row] = await db
    .select({ meal: dietPlanMeals, day: dietPlanDays, plan: dietPlans })
    .from(dietPlanMeals)
    .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlans, eq(dietPlanDays.dietPlanId, dietPlans.id))
    .where(eq(dietPlanMeals.id, mealId))
    .limit(1)
  if (!row || row.plan.engine !== "recipe") return null
  const ctx = await contextForPlan(row.plan)
  if (!ctx) return null
  return { ...row, ctx }
}

/** Throws unless this plan is still a draft. An approved plan is what a client was handed; edits are locked. */
export function assertEditable(ctx: RecipePlanContext): void {
  if (ctx.status === "approved") {
    throw new PlanEditError("This plan is already approved - edits are locked.")
  }
}

/**
 * Every recipe this client could be given, filtered exactly as generation
 * filters its pool: diet type, cuisine, season, live allergens, and the same
 * "a row claiming to be food with no energy is not offerable" rule
 * (recipe-pool-filters.ts). Eligibility is re-checked server-side on the
 * write too, never trusted from whatever the picker last showed.
 */
export async function eligibleRecipesForPlan(ctx: RecipePlanContext): Promise<RecipeForPipeline[]> {
  const rows = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisinesFor(ctx.cuisine))))

  return rows.filter(
    (r) =>
      isRecipeAllowedForDiet(r, ctx.dietType) &&
      recipeSeasonMatches(r.season, ctx.season) &&
      !r.allergenTags.some((t) => ctx.allergenTags.includes(t)) &&
      r.kcalPer100G > 0
  )
}

/** The same checks eligibleRecipesForPlan applies, as a hard gate on one chosen recipe. Message names the real reason. */
export function assertRecipeAllowed(recipe: RecipeForPipeline, ctx: RecipePlanContext): void {
  if (!isRecipeAllowedForDiet(recipe, ctx.dietType)) {
    throw new PlanEditError(`${recipe.name} is not suitable for a ${ctx.dietType} client.`)
  }
  const blocked = recipe.allergenTags.filter((t) => ctx.allergenTags.includes(t))
  if (blocked.length > 0) {
    throw new PlanEditError(`${recipe.name} contains ${blocked.join(", ")}, which this client must avoid.`)
  }
  // Must use the SAME rule the picker used. Checking `recipe.season !== ctx.season`
  // here would reject exactly the dishes the monsoon relaxation just made
  // offerable — the picker would list them and the write would refuse them.
  if (!recipeSeasonMatches(recipe.season, ctx.season)) {
    throw new PlanEditError(`${recipe.name} is a ${recipe.season} recipe and this plan's week is ${ctx.season}.`)
  }
  if (recipe.kcalPer100G <= 0) {
    throw new PlanEditError(`${recipe.name} has no recorded energy, so it cannot be counted in a plan.`)
  }
}

/**
 * Re-balance every day of the plan and rewrite the figures a dietitian judges
 * it on. Called as the last step of every edit, inside the edit's own
 * transaction, AFTER the edit itself has been written.
 *
 * All seven days are loaded even though only the edited one can move, because
 * the plan-level figure is the weekly AVERAGE - the same quantity generation
 * stores and the best-of-N gate measures. An edit must not quietly change
 * `diet_plans.achieved` from meaning "the week" to meaning "one day".
 */
export async function recomputePlanAfterEdit(tx: PlanTx, ctx: RecipePlanContext): Promise<void> {
  const dayRows = await tx.select().from(dietPlanDays).where(eq(dietPlanDays.dietPlanId, ctx.planId))
  const mealRows = dayRows.length
    ? await tx
        .select()
        .from(dietPlanMeals)
        .where(
          inArray(
            dietPlanMeals.dietPlanDayId,
            dayRows.map((d) => d.id)
          )
        )
    : []
  const itemRows = mealRows.length
    ? await tx
        .select({ item: dietPlanRecipeItems, recipe: RECIPE_PIPELINE_COLUMNS })
        .from(dietPlanRecipeItems)
        .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
        .where(
          inArray(
            dietPlanRecipeItems.dietPlanMealId,
            mealRows.map((m) => m.id)
          )
        )
    : []

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
            gramsLocked: r.item.gramsLocked,
            recipe: r.recipe,
            proteinPer100GSnapshot: r.item.proteinPer100GSnapshot,
            carbsPer100GSnapshot: r.item.carbsPer100GSnapshot,
            fatPer100GSnapshot: r.item.fatPer100GSnapshot,
            fiberPer100GSnapshot: r.item.fiberPer100GSnapshot,
          })),
      }))

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

  // The warnings banner is recomputed too, not just the numbers: an edit can
  // fix a macro miss or empty a meal, and the page must stop - or start -
  // saying so.
  const achieved = weeklyAverageOf(balancedDays.map((d) => d.totals))
  const warnings = buildRecipeWarnings(balancedDays, ctx.target, ctx.constraints)
  const summary = offTargetSummary(achieved, ctx.target, balancedDays.length)
  if (summary) warnings.unshift(summary)

  await tx
    .update(dietPlans)
    .set({ achieved, deviation: deviationOf(achieved, ctx.target), warnings })
    .where(eq(dietPlans.id, ctx.planId))
}
