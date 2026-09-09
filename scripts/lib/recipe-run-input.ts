/**
 * Shared input builder for the recipe-engine dev tools. Rebuilds exactly the
 * RecipeSelectorInput the production route would build for a given roadmap +
 * cuisine, so a script's result is comparable to a real generation.
 *
 * Extracted so best-of-n-week.ts and live-test-recipe-engine.ts cannot drift
 * apart on eligibility/season/target construction — a difference there would
 * silently make two runs incomparable.
 *
 * Never imported by production code.
 */
import { and, eq, inArray } from "drizzle-orm"

import { db } from "../../src/db"
import { clients, counsellingSessions, mealTemplates, recipeAliases, recipes, roadmaps } from "../../src/db/schema"
import type { Answers } from "../../src/lib/counselling/questions"
import { weekTargets, type RoadmapResult } from "../../src/lib/counselling/roadmap"
import { clientRecipeAllergenTagsFromAnswers, dietTypeFromAnswers } from "../../src/lib/plan/client-profile-from-answers"
import { eligibleCuisinesFor, templateRegionForCuisine, type RecipeCuisine } from "../../src/lib/foods/recipe-cuisine-mapping"
import { filterRecipePool } from "../../src/lib/foods/recipe-pool-filters"
import { RECIPE_PIPELINE_COLUMNS } from "../../src/lib/plan/recipe-types"
import { buildRecipeIndex, type RecipeIndex } from "../../src/lib/plan/recipe-grounding"
import type { ClientRecipeConstraints } from "../../src/lib/plan/recipe-plausibility-validate"
import type { DailyRecipeTarget, MealSlotInfo, RecipeForPrompt, RecipeSelectorInput } from "../../src/lib/plan/recipe-types"
import { seasonFor } from "../../src/lib/plan/season"

export interface RecipeRunContext {
  clientName: string
  cuisine: RecipeCuisine
  dietType: string
  season: string
  slots: MealSlotInfo[]
  dailyTarget: DailyRecipeTarget
  input: RecipeSelectorInput
  constraints: ClientRecipeConstraints
  index: RecipeIndex
  poolSize: number
}

export async function buildRecipeRunContext(
  roadmapId: string,
  cuisine: RecipeCuisine,
  mealCount = 5,
  weekNumber = 1
): Promise<RecipeRunContext> {
  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, roadmapId)).limit(1)
  if (!roadmapRow) throw new Error("roadmap not found")

  const [sessionRow] = await db
    .select({ session: counsellingSessions, client: clients })
    .from(counsellingSessions)
    .innerJoin(clients, eq(counsellingSessions.clientId, clients.id))
    .where(eq(counsellingSessions.id, roadmapRow.sessionId))
    .limit(1)
  if (!sessionRow) throw new Error("session not found")
  const { session, client } = sessionRow

  const wt = weekTargets(roadmapRow.output as RoadmapResult, weekNumber)
  const dietType = dietTypeFromAnswers(session.answers as Answers)
  const dailyTarget: DailyRecipeTarget = {
    kcal: wt.kcal,
    proteinG: wt.proteinG,
    carbsG: wt.carbsG,
    fatG: wt.fatG,
    fiberG: wt.fibreG,
  }

  const templateRegion = templateRegionForCuisine(cuisine)
  const season = seasonFor(new Date().toISOString().slice(0, 10), cuisine)
  const slotRows = await db
    .select({ slot: mealTemplates.slot, slotOrder: mealTemplates.slotOrder, timeHint: mealTemplates.timeHint })
    .from(mealTemplates)
    .where(and(eq(mealTemplates.region, templateRegion), eq(mealTemplates.mealCount, mealCount)))
  const slots: MealSlotInfo[] = slotRows.map((r) => ({ slot: r.slot, slotOrder: r.slotOrder, timeHint: r.timeHint }))

  const eligibleCuisines = eligibleCuisinesFor(cuisine)
  const cuisineRows = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisines)))
  const clientAllergenTags = clientRecipeAllergenTagsFromAnswers(session.answers as Answers)
  const eligible = cuisineRows.filter(
    (r) =>
      r.dietTypes.includes(dietType) &&
      (r.season === "all_year" || r.season === season) &&
      !r.allergenTags.some((t) => clientAllergenTags.includes(t))
  )
  // Same pool filters the production route applies, so a script run stays
  // comparable to a real generation.
  const filtered = filterRecipePool(eligible)

  const eligibleRecipesForPrompt: RecipeForPrompt[] = filtered.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    consistency: r.consistency,
    mainOrMid: r.mainOrMid as "main" | "mid",
    cuisine: r.cuisine,
    macroCategory: r.macroCategory,
    commonality: r.commonality,
    mustHaveCategories: r.mustHaveCategories,
    goodToHaveCategories: r.goodToHaveCategories,
    mustHaveRecipeNames: r.mustHaveRecipeNames,
    goodToHaveRecipeNames: r.goodToHaveRecipeNames,
    proteinPer100G: r.proteinPer100G,
    carbsPer100G: r.carbsPer100G,
    fatPer100G: r.fatPer100G,
    fiberPer100G: r.fiberPer100G,
    kcalPer100G: r.kcalPer100G,
  }))

  const aliasRows = await db
    .select({ recipeId: recipeAliases.recipeId, alias: recipeAliases.alias })
    .from(recipeAliases)
    .where(
      inArray(
        recipeAliases.recipeId,
        filtered.map((r) => r.id)
      )
    )

  const input: RecipeSelectorInput = {
    cuisine,
    dietType,
    mealCount,
    dailyTarget,
    slots,
    eligibleRecipesForPrompt,
    allRecipesById: new Map(filtered.map((r) => [r.id, r])),
    eligibleCuisines,
    clientAllergenTags,
    aliasRows,
  }

  return {
    clientName: client.name,
    cuisine,
    dietType,
    season,
    slots,
    dailyTarget,
    input,
    constraints: { dietType, eligibleCuisines, allergenTags: clientAllergenTags },
    index: buildRecipeIndex(filtered, aliasRows),
    poolSize: filtered.length,
  }
}
