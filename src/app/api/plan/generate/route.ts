/**
 * POST /api/plan/generate — turns a roadmap snapshot + week number into a
 * priced, food-filled diet plan. Node runtime (not edge): the OpenAI call
 * plus up to 3 retries with backoff can run long. See CLAUDE.md "THE ONE
 * RULE THAT MATTERS" — every number here comes from roadmap.ts /
 * exchange-solver.ts / quantity.ts; the LLM (inside selectFoods) only ever
 * returns food IDs.
 */

import { NextResponse } from "next/server"
import { z } from "zod"
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm"

import { db } from "@/db"
import {
  archetypeComponents,
  clients,
  counsellingSessions,
  dietitianKnowledgeChunks,
  dietitianKnowledgeDocs,
  dietPlanDays,
  dietPlanExamples as dietPlanExamplesTable,
  dietPlanItems,
  dietPlanMeals,
  dietPlanRecipeItems,
  dietPlans,
  foods,
  mealArchetypes,
  mealTemplates,
  planGenerationRuns,
  recipeAliases,
  recipes,
  roadmapOverrides,
  roadmaps,
  vegetableDishCombinationMembers,
  vegetableDishCombinations,
} from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { weekTargets, type RoadmapResult } from "@/lib/counselling/roadmap"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { env } from "@/lib/env"
import { REGIONS, SEASONS } from "@/lib/foods/vocab"
import { eligibleCuisinesFor, RECIPE_CUISINES, templateRegionForCuisine, type RecipeCuisine } from "@/lib/foods/recipe-cuisine-mapping"
import {
  ClientProfileError,
  clientAllergensFromAnswers,
  clientDislikesFromAnswers,
  clientRecipeAllergenTagsFromAnswers,
  dietTypeFromAnswers,
} from "@/lib/plan/client-profile-from-answers"
import { selectArchetypesForWeek, type ArchetypeAssignment, type ArchetypeCandidate } from "@/lib/plan/archetype-selector"
import { computeDailyPulseJitter } from "@/lib/plan/daily-macro-jitter"
import { retrieveDietPlanExamples, type DietPlanExampleForRetrieval, type DroppedDietPlanExample, type RetrievedDietPlanExample } from "@/lib/plan/diet-plan-example-retrieval"
import type { ParsedMealSlot } from "@/lib/plan/diet-plan-example-markdown-parser"
import { NoEligibleFoodsError, eligibleFoodsForSkeleton, type DishFamilyConstraintsBySlot } from "@/lib/plan/eligible-foods"
import { solveExchanges } from "@/lib/plan/exchange-solver"
import { inferGoalFromRoadmap } from "@/lib/plan/goal-inference"
import { retrieveKnowledgeChunks, type DroppedKnowledgeChunk, type KnowledgeDocForRetrieval, type RetrievedKnowledgeChunk } from "@/lib/plan/knowledge-retrieval"
import { distributeMeals, type MealSlotTemplate, type Skeleton } from "@/lib/plan/meal-distributor"
import { selectFoods, type AttemptLog } from "@/lib/plan/food-selector"
import { checkArchetypeAdherence } from "@/lib/plan/food-selector-validate"
import type { FoodSelectorInput, PreviousWeekItem } from "@/lib/plan/food-selector-types"
import { selectRecipes, RecipeSelectionRejectedError, type RecipeAttemptLog } from "@/lib/plan/recipe-selector"
import { filterRecipePool } from "@/lib/foods/recipe-pool-filters"
import { RECIPE_PIPELINE_COLUMNS } from "@/lib/plan/recipe-types"
import type { ClientRecipeConstraints } from "@/lib/plan/recipe-plausibility-validate"
import type { DailyRecipeTarget, MealSlotInfo, RecipeForPrompt, RecipeSelectorInput } from "@/lib/plan/recipe-types"
import { seasonFor } from "@/lib/plan/season"
import { sumExchanges, type AchievedMacros, type ExchangeCode, type ExchangeCounts } from "@/lib/plan/table-4-1"
import {
  ExchangeTypeMismatchError,
  PricedSelectionDeviationError,
  UnknownFoodError,
  WeeklyAverageDeviationError,
  assertWeeklyAverageWithinTolerance,
  assertWithinTolerance,
  priceSelection,
} from "@/lib/plan/quantity"
import { RateLimitExceededError, checkAndRecordPlanGenerationRequest } from "@/lib/plan/rate-limit"
import { isSameOrigin } from "@/lib/require-same-origin"

export const runtime = "nodejs"
// This was 60 (chosen for Vercel Hobby's old 60s ceiling) and that cap was
// self-inflicted: a real production log shows this account running another
// route with "Execution Duration / Maximum: 663ms / 5m", i.e. the platform
// allows 300s here (Fluid compute is active). Meanwhile /api/plan/generate
// reported "1m / 1m" — hitting OUR limit, not the platform's, and returning
// a 504 instead of a plan.
//
// 300 is headroom, not an expectation. The real budget is enforced where it
// belongs: openai-client.ts bounds every model call at 25s with no SDK
// retries, so best-of-3 costs ~25s worst case regardless of what the API
// does, and a healthy run measures 7-12s end to end. This ceiling exists so
// a slow-but-recoverable request finishes instead of being killed.
export const maxDuration = 300

const exchangeRequestSchema = z.object({
  engine: z.literal("exchange"),
  roadmapId: z.string().uuid(),
  weekNumber: z.number().int().min(1),
  region: z.enum(REGIONS),
  mealCount: z.number().int().positive().default(5),
  // Derived from week_start + region (season.ts) when omitted — a
  // dietitian override, not something the UI needs to ask for by default.
  season: z.enum(SEASONS).optional(),
})

const recipeRequestSchema = z.object({
  engine: z.literal("recipe"),
  roadmapId: z.string().uuid(),
  weekNumber: z.number().int().min(1),
  cuisine: z.enum(RECIPE_CUISINES),
  mealCount: z.number().int().positive().default(5),
  season: z.enum(SEASONS).optional(),
})

// `engine` defaults to "exchange" when the caller omits it entirely — both
// existing UI callers (actions-bar.tsx, plan-actions-bar.tsx) send
// {roadmapId, weekNumber, region} with no `engine` field, and this keeps
// them working byte-identically. A caller wanting the recipe engine must
// pass `engine: "recipe"` and `cuisine` explicitly.
const requestSchema = z.preprocess((body) => {
  if (body && typeof body === "object" && !("engine" in (body as Record<string, unknown>))) {
    return { ...(body as Record<string, unknown>), engine: "exchange" }
  }
  return body
}, z.discriminatedUnion("engine", [exchangeRequestSchema, recipeRequestSchema]))

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * "Generate next week" (Prompt 8): continues the fallback selector's
 * rotation across weeks and gives the LLM prompt the prior week's last day,
 * so week N doesn't reuse week N-1's exact food set on day 0. Falls back to
 * a bare day-index offset (still avoids resetting the rotation to 0) if no
 * previous-week plan exists yet — e.g. week 3 generated before week 2.
 *
 * Also carries archetype continuity (Meal Archetype layer, additive): the
 * archetype ids used on the previous week's final two days, by slot,
 * mirroring the food-continuity role above — archetype-selector.ts's
 * RECENT_DAYS_AVOIDED is 2, so that's how far back this looks.
 */
async function loadPreviousWeekSeed(
  roadmapId: string,
  weekNumber: number
): Promise<{
  dayIndexOffset: number
  previousWeekLastDay?: Record<string, PreviousWeekItem[]>
  recentArchetypeIdsBySlot?: Record<string, string[]>
}> {
  if (weekNumber <= 1) return { dayIndexOffset: 0 }
  const dayIndexOffset = (weekNumber - 1) * 7

  const [previousPlan] = await db
    .select()
    .from(dietPlans)
    .where(and(eq(dietPlans.roadmapId, roadmapId), eq(dietPlans.weekNumber, weekNumber - 1)))
    .limit(1)
  if (!previousPlan) return { dayIndexOffset }

  const [lastDay] = await db
    .select()
    .from(dietPlanDays)
    .where(and(eq(dietPlanDays.dietPlanId, previousPlan.id), eq(dietPlanDays.dayIndex, 6)))
    .limit(1)

  let previousWeekLastDay: Record<string, PreviousWeekItem[]> | undefined
  if (lastDay) {
    const mealRows = await db.select().from(dietPlanMeals).where(eq(dietPlanMeals.dietPlanDayId, lastDay.id))
    if (mealRows.length > 0) {
      const itemRows = await db
        .select({ item: dietPlanItems, food: foods, slot: dietPlanMeals.slot })
        .from(dietPlanItems)
        .innerJoin(dietPlanMeals, eq(dietPlanItems.dietPlanMealId, dietPlanMeals.id))
        .innerJoin(foods, eq(dietPlanItems.foodId, foods.id))
        .where(
          inArray(
            dietPlanItems.dietPlanMealId,
            mealRows.map((m) => m.id)
          )
        )

      previousWeekLastDay = {}
      for (const row of itemRows) {
        const list = previousWeekLastDay[row.slot] ?? []
        list.push({ exchangeType: row.item.exchangeType as ExchangeCode, foodId: row.item.foodId, nameEn: row.food.nameEn })
        previousWeekLastDay[row.slot] = list
      }
    }
  }

  const recentDays = await db
    .select()
    .from(dietPlanDays)
    .where(and(eq(dietPlanDays.dietPlanId, previousPlan.id), gte(dietPlanDays.dayIndex, 5)))

  let recentArchetypeIdsBySlot: Record<string, string[]> | undefined
  if (recentDays.length > 0) {
    const recentMeals = await db
      .select()
      .from(dietPlanMeals)
      .where(
        inArray(
          dietPlanMeals.dietPlanDayId,
          recentDays.map((d) => d.id)
        )
      )
    recentArchetypeIdsBySlot = {}
    for (const meal of recentMeals) {
      if (!meal.archetypeId) continue
      const list = recentArchetypeIdsBySlot[meal.slot] ?? []
      list.push(meal.archetypeId)
      recentArchetypeIdsBySlot[meal.slot] = list
    }
  }

  return { dayIndexOffset, previousWeekLastDay, recentArchetypeIdsBySlot }
}

/**
 * Recipe-engine analog of loadPreviousWeekSeed() above — same "continue the
 * rotation across weeks" purpose, but queries diet_plan_recipe_items/recipes
 * instead of diet_plan_items/foods, and carries no archetype continuity
 * (meal archetypes are an exchange-system construct with no recipe-engine
 * analog — see CLAUDE.md "The recipe engine").
 */
async function loadPreviousWeekRecipeSeed(
  roadmapId: string,
  weekNumber: number
): Promise<{ dayIndexOffset: number; previousWeekLastDayRecipeNames?: Record<string, string[]> }> {
  if (weekNumber <= 1) return { dayIndexOffset: 0 }
  const dayIndexOffset = (weekNumber - 1) * 7

  const [previousPlan] = await db
    .select()
    .from(dietPlans)
    .where(and(eq(dietPlans.roadmapId, roadmapId), eq(dietPlans.weekNumber, weekNumber - 1), eq(dietPlans.engine, "recipe")))
    .limit(1)
  if (!previousPlan) return { dayIndexOffset }

  const [lastDay] = await db
    .select()
    .from(dietPlanDays)
    .where(and(eq(dietPlanDays.dietPlanId, previousPlan.id), eq(dietPlanDays.dayIndex, 6)))
    .limit(1)
  if (!lastDay) return { dayIndexOffset }

  const mealRows = await db.select().from(dietPlanMeals).where(eq(dietPlanMeals.dietPlanDayId, lastDay.id))
  if (mealRows.length === 0) return { dayIndexOffset }

  const itemRows = await db
    .select({ recipe: recipes, slot: dietPlanMeals.slot })
    .from(dietPlanRecipeItems)
    .innerJoin(dietPlanMeals, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
    .where(
      inArray(
        dietPlanRecipeItems.dietPlanMealId,
        mealRows.map((m) => m.id)
      )
    )

  const previousWeekLastDayRecipeNames: Record<string, string[]> = {}
  for (const row of itemRows) {
    const list = previousWeekLastDayRecipeNames[row.slot] ?? []
    list.push(row.recipe.name)
    previousWeekLastDayRecipeNames[row.slot] = list
  }
  return { dayIndexOffset, previousWeekLastDayRecipeNames }
}

interface RecipeEngineContext {
  user: { id: string }
  roadmapId: string
  weekNumber: number
  cuisine: RecipeCuisine
  mealCount: number
  clientId: string
  slots: MealSlotInfo[]
  weekStartDate: Date
  weekEndDate: Date
  season: string
  dailyTarget: DailyRecipeTarget
  dietType: ReturnType<typeof dietTypeFromAnswers>
  clientRecipeAllergenTags: string[]
  /** Dietitian Knowledge RAG layer (gated by DIETITIAN_KNOWLEDGE_ENABLED) — empty when off or nothing retrieved. See CLAUDE.md "Dietitian knowledge layer". */
  knowledgeChunks: RetrievedKnowledgeChunk[]
  knowledgeDroppedForBudget: DroppedKnowledgeChunk[]
  /** Diet Plan Examples RAG layer (gated by DIET_PLAN_EXAMPLES_ENABLED) — empty when off or nothing retrieved. See CLAUDE.md "Diet plan examples layer". */
  dietPlanExamples: RetrievedDietPlanExample[]
  dietPlanExamplesDroppedForBudget: DroppedDietPlanExample[]
}

/**
 * The recipe engine's generation path (gated by RECIPE_ENGINE_ENABLED — see
 * CLAUDE.md "The recipe engine"). Mirrors the exchange path's overall shape
 * (select -> log attempts -> DB transaction -> response) but skips every
 * exchange-specific layer entirely: no meal archetypes, no eligible-foods
 * narrowing, no exchange solver, no pulse jitter, no curated vegetable
 * pairs — none of those constructs apply once every recipe is already its
 * own complete, fully-specified identity and the LLM never proposes a
 * gram/macro number at all.
 *
 * Unlike every prior engine, a rejected selection (RecipeSelectionRejectedError)
 * is NOT written to the DB and NOT silently accepted with warnings — see
 * CLAUDE.md "The recipe engine"'s reject-semantics section.
 */
async function generateRecipeEnginePlan(ctx: RecipeEngineContext): Promise<NextResponse> {
  // Phase timings, logged on every generation. This route has hit a
  // production function timeout twice, and both times the dominant cost was
  // guessed at before it was measured. A few console.logs make the next
  // occurrence self-diagnosing from the Vercel runtime log alone.
  const t0 = Date.now()
  const phase: Record<string, number> = {}
  let mark = t0
  // Logs each phase AS IT COMPLETES, not once at the end: a function that
  // times out is killed, so an end-of-request summary is exactly the log you
  // never get when you most need it. Incremental lines survive the kill and
  // show which phase was still running.
  const lap = (name: string) => {
    const now = Date.now()
    phase[name] = now - mark
    mark = now
    console.log(`[plan/generate recipe] ${name}=${phase[name]}ms elapsed=${now - t0}ms`)
  }

  const eligibleCuisines = eligibleCuisinesFor(ctx.cuisine)
  // Explicit columns, omitting the audit-only rawCsvRow jsonb: it is 46%
  // of a 1.5 MB payload that no runtime path reads, fetched cross-region on
  // every generation. Contributed to a real 60s function timeout.
  const cuisineRows = await db
    .select(RECIPE_PIPELINE_COLUMNS)
    .from(recipes)
    .where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisines)))

  const eligible = cuisineRows.filter(
    (r) =>
      r.dietTypes.includes(ctx.dietType) &&
      (r.season === "all_year" || r.season === ctx.season) &&
      !r.allergenTags.some((t) => ctx.clientRecipeAllergenTags.includes(t))
  )
  // Drop rows that declare no energy at all, and dishes far fattier than
  // this client's own macro split, before the model ever sees the pool.
  // See recipe-pool-filters.ts for the real rejected week that motivated
  // both. The fat filter declines to narrow rather than starve the pool.
  const filtered = filterRecipePool(eligible)

  if (filtered.length === 0) {
    return NextResponse.json(
      { error: `No eligible recipes for cuisine "${ctx.cuisine}" / diet type "${ctx.dietType}" / season "${ctx.season}".` },
      { status: 422 }
    )
  }

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

  const { dayIndexOffset, previousWeekLastDayRecipeNames } = await loadPreviousWeekRecipeSeed(ctx.roadmapId, ctx.weekNumber)

  lap("dbReads")

  const recipeSelectorInput: RecipeSelectorInput = {
    cuisine: ctx.cuisine,
    dietType: ctx.dietType,
    mealCount: ctx.mealCount,
    dailyTarget: ctx.dailyTarget,
    slots: ctx.slots,
    eligibleRecipesForPrompt,
    allRecipesById: new Map(filtered.map((r) => [r.id, r])),
    eligibleCuisines,
    clientAllergenTags: ctx.clientRecipeAllergenTags,
    aliasRows,
    dayIndexOffset,
    previousWeekLastDayRecipeNames,
    knowledgeChunks: ctx.knowledgeChunks,
    dietPlanExamples: ctx.dietPlanExamples,
  }
  const constraints: ClientRecipeConstraints = { dietType: ctx.dietType, eligibleCuisines, allergenTags: ctx.clientRecipeAllergenTags }

  const attempts: RecipeAttemptLog[] = []
  let selectionResult: Awaited<ReturnType<typeof selectRecipes>> | undefined
  let rejectedError: RecipeSelectionRejectedError | undefined
  try {
    selectionResult = await selectRecipes(recipeSelectorInput, constraints, {
      onAttempt: (log) => attempts.push(log),
      bestOfN: env.RECIPE_BEST_OF_N,
    })
  } catch (err) {
    if (err instanceof RecipeSelectionRejectedError) {
      rejectedError = err
    } else {
      throw err
    }
  }
  lap("llm")

  // Same knowledge injection for every attempt log row within this one
  // generation call — retrieval runs once per request, not once per
  // attempt. Null (not {injected:[],droppedForBudget:[]}) when nothing was
  // ever retrieved, so a query can cheaply distinguish "layer off/empty"
  // from "layer on, genuinely nothing matched".
  const knowledgeChunksInjected =
    ctx.knowledgeChunks.length > 0 || ctx.knowledgeDroppedForBudget.length > 0
      ? { injected: ctx.knowledgeChunks.map((c) => c.slug), droppedForBudget: ctx.knowledgeDroppedForBudget.map((d) => d.slug) }
      : null
  // Sibling audit object, same shape, its own column — keeps the two RAG
  // layers independently queryable.
  const dietPlanExamplesInjected =
    ctx.dietPlanExamples.length > 0 || ctx.dietPlanExamplesDroppedForBudget.length > 0
      ? { injected: ctx.dietPlanExamples.map((e) => e.slug), droppedForBudget: ctx.dietPlanExamplesDroppedForBudget.map((d) => d.slug) }
      : null

  let runIds: string[] = []
  if (attempts.length > 0) {
    const inserted = await db
      .insert(planGenerationRuns)
      .values(
        attempts.map((log) => ({
          clientId: ctx.clientId,
          roadmapId: ctx.roadmapId,
          weekNumber: ctx.weekNumber,
          dietPlanId: null,
          attemptNumber: log.attemptNumber,
          dayIndex: log.dayIndex,
          model: log.model,
          promptHash: log.promptHash,
          rawResponse: log.rawResponse,
          validationResult: log.validationResult,
          latencyMs: log.latencyMs,
          knowledgeChunksInjected,
          dietPlanExamplesInjected,
        }))
      )
      .returning({ id: planGenerationRuns.id })
    runIds = inserted.map((r) => r.id)
  }

  if (rejectedError || !selectionResult) {
    console.log(`[plan/generate recipe] REJECTED after ${Date.now() - t0}ms`)
    return NextResponse.json(
      { error: rejectedError?.message ?? "Recipe selection failed", dayProblems: rejectedError?.dayProblems ?? [] },
      { status: 422 }
    )
  }

  const days = selectionResult.selection.days
  const weeklyAverageAchieved = {
    kcal: days.reduce((sum, d) => sum + d.totals.kcal, 0) / days.length,
    proteinG: days.reduce((sum, d) => sum + d.totals.proteinG, 0) / days.length,
    carbsG: days.reduce((sum, d) => sum + d.totals.carbsG, 0) / days.length,
    fatG: days.reduce((sum, d) => sum + d.totals.fatG, 0) / days.length,
    fibreG: days.reduce((sum, d) => sum + d.totals.fiberG, 0) / days.length,
  }
  // targets/achieved persist with the "fibreG" spelling to match Macros
  // (counselling/types.ts) — this module's own internal types spell it
  // "fiberG"; the mapping happens only at this DB-write boundary.
  const targetsForDb = {
    kcal: ctx.dailyTarget.kcal,
    proteinG: ctx.dailyTarget.proteinG,
    carbsG: ctx.dailyTarget.carbsG,
    fatG: ctx.dailyTarget.fatG,
    fibreG: ctx.dailyTarget.fiberG,
  }

  const deviations = days.map((day) => ({
    dayIndex: day.dayIndex,
    kcal: Math.abs(day.totals.kcal - ctx.dailyTarget.kcal) / ctx.dailyTarget.kcal,
    proteinG: Math.abs(day.totals.proteinG - ctx.dailyTarget.proteinG) / ctx.dailyTarget.proteinG,
    fatG: Math.abs(day.totals.fatG - ctx.dailyTarget.fatG) / ctx.dailyTarget.fatG,
    carbsG: Math.abs(day.totals.carbsG - ctx.dailyTarget.carbsG) / ctx.dailyTarget.carbsG,
    // Informational only — fiber never gates a write (see recipe-validate.ts).
    fiberDeviationPct: ctx.dailyTarget.fiberG > 0 ? Math.abs(day.totals.fiberG - ctx.dailyTarget.fiberG) / ctx.dailyTarget.fiberG : 0,
  }))

  const dietPlanId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(dietPlans)
      .values({
        clientId: ctx.clientId,
        roadmapId: ctx.roadmapId,
        weekNumber: ctx.weekNumber,
        weekStart: toIsoDate(ctx.weekStartDate),
        weekEnd: toIsoDate(ctx.weekEndDate),
        // dietPlans has no dedicated `cuisine` column — reusing `region` to
        // carry the cuisine string, the same pragmatic reuse the deleted
        // dish engine made of this column.
        region: ctx.cuisine,
        dietType: ctx.dietType,
        engine: "recipe",
        targets: targetsForDb,
        achieved: weeklyAverageAchieved,
        deviation: deviations,
        generationMode: selectionResult.generationMode,
        modelUsed: selectionResult.modelUsed,
        preparedBy: ctx.user.id,
        status: "draft",
      })
      .returning({ id: dietPlans.id })

    // Batched, not row-by-row. The original wrote 1 plan + 7 days + 35 meals
    // + 35 item-inserts as ~79 SEQUENTIAL round trips inside one transaction —
    // which cannot overlap by definition. Against a database in another
    // region (this deployment: function in iad1, Postgres in ap-northeast-1)
    // that is ~16s of pure latency, and was the dominant cost in a real 60s
    // function timeout. Four statements now do the same work.
    //
    // Rows are matched back by NATURAL KEY (dayIndex, then dayId+slot), never
    // by assuming multi-row RETURNING preserves insertion order.
    const dayRows = await tx
      .insert(dietPlanDays)
      .values(
        days.map((day) => ({
          dietPlanId: plan.id,
          dayIndex: day.dayIndex,
          date: toIsoDate(addDays(ctx.weekStartDate, day.dayIndex)),
          achieved: {
            kcal: day.totals.kcal,
            proteinG: day.totals.proteinG,
            carbsG: day.totals.carbsG,
            fatG: day.totals.fatG,
            fibreG: day.totals.fiberG,
          },
        }))
      )
      .returning({ id: dietPlanDays.id, dayIndex: dietPlanDays.dayIndex })
    const dayIdByIndex = new Map(dayRows.map((r) => [r.dayIndex, r.id]))

    const mealValues = days.flatMap((day) =>
      day.meals.map((meal) => ({
        dietPlanDayId: dayIdByIndex.get(day.dayIndex)!,
        slot: meal.slot,
        slotOrder: ctx.slots.find((s) => s.slot === meal.slot)?.slotOrder ?? 0,
        archetypeId: null,
      }))
    )
    const mealRows = mealValues.length
      ? await tx
          .insert(dietPlanMeals)
          .values(mealValues)
          .returning({ id: dietPlanMeals.id, dietPlanDayId: dietPlanMeals.dietPlanDayId, slot: dietPlanMeals.slot })
      : []
    const mealIdByDayAndSlot = new Map(mealRows.map((r) => [`${r.dietPlanDayId}:${r.slot}`, r.id]))

    const itemValues = days.flatMap((day) =>
      day.meals.flatMap((meal) => {
        const mealId = mealIdByDayAndSlot.get(`${dayIdByIndex.get(day.dayIndex)}:${meal.slot}`)!
        return meal.items.map((item) => ({
          dietPlanMealId: mealId,
          recipeId: item.recipe.id,
          grams: item.grams,
          proteinPer100GSnapshot: item.recipe.proteinPer100G,
          carbsPer100GSnapshot: item.recipe.carbsPer100G,
          fatPer100GSnapshot: item.recipe.fatPer100G,
          fiberPer100GSnapshot: item.recipe.fiberPer100G,
        }))
      })
    )
    if (itemValues.length > 0) {
      await tx.insert(dietPlanRecipeItems).values(itemValues)
    }

    if (runIds.length > 0) {
      await tx.update(planGenerationRuns).set({ dietPlanId: plan.id }).where(inArray(planGenerationRuns.id, runIds))
    }

    return plan.id
  })
  lap("dbWrite")
  console.log(
    `[plan/generate recipe] total=${Date.now() - t0}ms ` +
      Object.entries(phase)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(" ")
  )

  return NextResponse.json(
    {
      dietPlanId,
      engine: "recipe",
      generationMode: selectionResult.generationMode,
      modelUsed: selectionResult.modelUsed,
      attempts: selectionResult.attempts,
      warnings: selectionResult.warnings,
      season: ctx.season,
      weekStart: toIsoDate(ctx.weekStartDate),
      weekEnd: toIsoDate(ctx.weekEndDate),
      achieved: weeklyAverageAchieved,
      deviations,
    },
    { status: 201 }
  )
}

export async function POST(request: Request) {
  // Route Handlers don't get Next's Server Action CSRF protection —
  // cookie auth alone can't stop a cross-site request from riding an
  // authenticated session. This is the app's only mutating Route Handler
  // (everything else is a Server Action).
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 })
  }

  const user = await requireStaffUser()

  try {
    await checkAndRecordPlanGenerationRequest(user.id)
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      return NextResponse.json(
        { error: err.message, retryAfterSeconds: err.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } }
      )
    }
    throw err
  }

  const bodyResult = requestSchema.safeParse(await request.json().catch(() => null))
  if (!bodyResult.success) {
    return NextResponse.json({ error: "Invalid request body", details: bodyResult.error.flatten() }, { status: 400 })
  }
  const { roadmapId, weekNumber, mealCount, season: seasonOverride } = bodyResult.data

  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, roadmapId)).limit(1)
  if (!roadmapRow) {
    return NextResponse.json({ error: "Roadmap not found" }, { status: 404 })
  }

  const [sessionRow] = await db
    .select({ session: counsellingSessions, client: clients })
    .from(counsellingSessions)
    .innerJoin(clients, eq(counsellingSessions.clientId, clients.id))
    .where(eq(counsellingSessions.id, roadmapRow.sessionId))
    .limit(1)
  if (!sessionRow) {
    return NextResponse.json({ error: "Counselling session for this roadmap not found" }, { status: 404 })
  }
  const { session, client } = sessionRow

  // Moved ahead of eligible-foods (was previously computed just before the
  // DB transaction, much further down) so the seasonal filter can derive
  // from the real week_start instead of "now" — the week a plan covers can
  // start in a different season than the day it's generated on. seasonFor's
  // second argument is unused (only one calendar exists today — see
  // season.ts) so a cuisine string works exactly as well as a region one.
  const anchorDate = session.submittedAt ?? session.createdAt
  const weekStartDate = addDays(anchorDate, (weekNumber - 1) * 7)
  const weekEndDate = addDays(weekStartDate, 6)
  const seasonLookupKey = bodyResult.data.engine === "exchange" ? bodyResult.data.region : templateRegionForCuisine(bodyResult.data.cuisine)
  const season = seasonOverride ?? seasonFor(toIsoDate(weekStartDate), seasonLookupKey)

  const roadmapOutput = roadmapRow.output as RoadmapResult
  const overrides = await db.select().from(roadmapOverrides).where(eq(roadmapOverrides.roadmapId, roadmapId))
  const overriddenCodes = new Set(overrides.map((o) => o.flagCode))
  const blockFlags = roadmapOutput.flags.filter((f) => f.level === "block" || f.level === "stop")
  const unresolvedBlocks = blockFlags.filter((f) => !overriddenCodes.has(f.code))
  if (unresolvedBlocks.length > 0) {
    return NextResponse.json(
      {
        error: "Roadmap has unresolved block-level flags — record a dietitian override on the review page first.",
        flags: unresolvedBlocks,
      },
      { status: 422 }
    )
  }

  const dailyTarget = weekTargets(roadmapOutput, weekNumber)

  let dietType
  try {
    dietType = dietTypeFromAnswers(session.answers as Answers)
  } catch (err) {
    if (err instanceof ClientProfileError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    throw err
  }

  if (bodyResult.data.engine === "recipe") {
    if (!env.RECIPE_ENGINE_ENABLED) {
      return NextResponse.json({ error: "The recipe engine is not enabled." }, { status: 422 })
    }
    const { cuisine } = bodyResult.data
    const templateRegion = templateRegionForCuisine(cuisine)
    const slotRows = await db
      .select({ slot: mealTemplates.slot, slotOrder: mealTemplates.slotOrder, timeHint: mealTemplates.timeHint })
      .from(mealTemplates)
      .where(and(eq(mealTemplates.region, templateRegion), eq(mealTemplates.mealCount, mealCount)))
    if (slotRows.length === 0) {
      return NextResponse.json(
        { error: `No meal-slot templates seeded for region "${templateRegion}" (used for cuisine "${cuisine}") with mealCount ${mealCount}.` },
        { status: 422 }
      )
    }
    const slots: MealSlotInfo[] = slotRows.map((r) => ({ slot: r.slot, slotOrder: r.slotOrder, timeHint: r.timeHint }))
    const clientRecipeAllergenTags = clientRecipeAllergenTagsFromAnswers(session.answers as Answers)
    const dailyRecipeTarget: DailyRecipeTarget = {
      kcal: dailyTarget.kcal,
      proteinG: dailyTarget.proteinG,
      carbsG: dailyTarget.carbsG,
      fatG: dailyTarget.fatG,
      fiberG: dailyTarget.fibreG,
    }

    // Dietitian Knowledge RAG layer (see CLAUDE.md "Dietitian knowledge
    // layer") — deterministic tag-filtered retrieval only, no embeddings in
    // v1. Off by default (DIETITIAN_KNOWLEDGE_ENABLED); `knowledgeChunks`
    // stays [] and formatKnowledgeSection() renders nothing, so the prompt
    // is byte-identical to before this layer existed.
    let knowledgeChunks: RetrievedKnowledgeChunk[] = []
    let knowledgeDroppedForBudget: DroppedKnowledgeChunk[] = []
    if (env.DIETITIAN_KNOWLEDGE_ENABLED) {
      const goal = inferGoalFromRoadmap(roadmapOutput, weekNumber)
      const [docRows, chunkRows] = await Promise.all([db.select().from(dietitianKnowledgeDocs), db.select().from(dietitianKnowledgeChunks)])
      const chunksByDocId = new Map<string, typeof chunkRows>()
      for (const chunk of chunkRows) {
        const list = chunksByDocId.get(chunk.docId) ?? []
        list.push(chunk)
        chunksByDocId.set(chunk.docId, list)
      }
      const docsForRetrieval: KnowledgeDocForRetrieval[] = docRows.map((doc) => ({
        slug: doc.slug,
        category: doc.category,
        regions: doc.regions,
        dietTypes: doc.dietTypes,
        goals: doc.goals,
        mealSlots: doc.mealSlots,
        weight: doc.weight,
        chunks: (chunksByDocId.get(doc.id) ?? []).map((c) => ({
          slug: c.slug,
          heading: c.heading,
          content: c.content,
          estimatedTokens: c.estimatedTokens,
        })),
      }))
      const retrieval = retrieveKnowledgeChunks(docsForRetrieval, {
        cuisine,
        dietType,
        goal,
        mealSlots: slots.map((s) => s.slot),
      })
      knowledgeChunks = retrieval.chunks
      knowledgeDroppedForBudget = retrieval.droppedForBudget
      if (knowledgeDroppedForBudget.length > 0) {
        console.warn(`Dietitian knowledge retrieval dropped ${knowledgeDroppedForBudget.length} chunk(s) for token budget:`, knowledgeDroppedForBudget)
      }
    }

    // Diet Plan Examples RAG layer (see CLAUDE.md "Diet plan examples
    // layer") — a second, independent layer from the knowledge layer
    // above: complete real (and real/synthetic-tiered) example days,
    // ranked above the knowledge chunks in the rendered prompt. Off by
    // default (DIET_PLAN_EXAMPLES_ENABLED); dietPlanExamples stays [] and
    // formatExamplesSection() renders nothing, so the prompt is
    // byte-identical to before this layer existed.
    let dietPlanExamples: RetrievedDietPlanExample[] = []
    let dietPlanExamplesDroppedForBudget: DroppedDietPlanExample[] = []
    if (env.DIET_PLAN_EXAMPLES_ENABLED) {
      // inferGoalFromRoadmap() is pure/cheap — called again independently
      // rather than hoisting the call above out of the knowledge-layer
      // block, since that block is otherwise untouched by this layer.
      const goal = inferGoalFromRoadmap(roadmapOutput, weekNumber)
      const exampleRows = await db.select().from(dietPlanExamplesTable)
      const examplesForRetrieval: DietPlanExampleForRetrieval[] = exampleRows.map((row) => ({
        slug: row.slug,
        goal: row.goal,
        dietTypes: row.dietTypes,
        region: row.region,
        gender: row.gender,
        calorieMin: row.calorieMin,
        calorieMax: row.calorieMax,
        mealCount: row.mealCount,
        // jsonb column, untyped in schema.ts (same convention as
        // rawCsvRow/validationResult elsewhere) — the real shape is owned
        // by diet-plan-example-markdown-parser.ts's ParsedMealSlot.
        mealStructure: row.mealStructure as ParsedMealSlot[],
        reasoning: row.reasoning,
        weight: row.weight,
        sourceType: row.sourceType,
        estimatedTokens: row.estimatedTokens,
      }))
      const exampleRetrieval = retrieveDietPlanExamples(examplesForRetrieval, {
        goal,
        dietType,
        cuisine,
        dailyTargetKcal: dailyRecipeTarget.kcal,
        mealCount,
      })
      dietPlanExamples = exampleRetrieval.examples
      dietPlanExamplesDroppedForBudget = exampleRetrieval.droppedForBudget
      if (dietPlanExamplesDroppedForBudget.length > 0) {
        console.warn(
          `Diet plan example retrieval dropped ${dietPlanExamplesDroppedForBudget.length} example(s) for token budget:`,
          dietPlanExamplesDroppedForBudget
        )
      }
    }

    return generateRecipeEnginePlan({
      user,
      roadmapId,
      weekNumber,
      cuisine,
      mealCount,
      clientId: client.id,
      slots,
      weekStartDate,
      weekEndDate,
      season,
      dailyTarget: dailyRecipeTarget,
      dietType,
      clientRecipeAllergenTags,
      knowledgeChunks,
      knowledgeDroppedForBudget,
      dietPlanExamples,
      dietPlanExamplesDroppedForBudget,
    })
  }

  // engine === "exchange" — everything below is byte-identical to before
  // the recipe engine existed; the exchange path is never touched by it.
  const { region } = bodyResult.data
  const templateRows = await db
    .select({
      slot: mealTemplates.slot,
      slotOrder: mealTemplates.slotOrder,
      kcalShare: mealTemplates.kcalShare,
      allowedExchangeTypes: mealTemplates.allowedExchangeTypes,
    })
    .from(mealTemplates)
    .where(and(eq(mealTemplates.region, region), eq(mealTemplates.mealCount, mealCount)))
  if (templateRows.length === 0) {
    return NextResponse.json(
      { error: `No meal templates seeded for region "${region}" with mealCount ${mealCount}.` },
      { status: 422 }
    )
  }
  const templates: MealSlotTemplate[] = templateRows.map((r) => ({
    ...r,
    allowedExchangeTypes: r.allowedExchangeTypes as ExchangeCode[],
  }))

  const clientAllergens = clientAllergensFromAnswers(session.answers as Answers)
  const clientDislikes = clientDislikesFromAnswers(session.answers as Answers)

  const solverResult = solveExchanges({
    kcal: dailyTarget.kcal,
    proteinG: dailyTarget.proteinG,
    fatG: dailyTarget.fatG,
    carbsG: dailyTarget.carbsG,
    fibreG: dailyTarget.fibreG,
    dietType,
    sugarEnabled: false,
  })
  if (!solverResult.ok) {
    return NextResponse.json(
      { error: solverResult.reason, best: solverResult.best },
      { status: 422 }
    )
  }

  // Day-to-day macro variety (dietitian request): the week's AVERAGE protein
  // still lands exactly on dailyTarget (solverResult already validated that
  // within tolerance), but individual days wobble a small, bounded amount —
  // see daily-macro-jitter.ts for why this is scoped to pulse alone and why
  // the 7 deltas are guaranteed to sum to exactly 0.
  const pulseJitterDeltas = computeDailyPulseJitter(solverResult.exchangeCounts.pulse, dietType, `${roadmapId}:${weekNumber}`)
  const exchangeCountsByDay: ExchangeCounts[] = pulseJitterDeltas.map((delta) => ({
    ...solverResult.exchangeCounts,
    pulse: solverResult.exchangeCounts.pulse + delta,
  }))
  const skeletonsByDay: Skeleton[] = exchangeCountsByDay.map((counts) => distributeMeals(counts, templates))
  // Each day's own expected achieved macros, from its own (possibly
  // jittered) exchange counts — the correct reference for assertWithinTolerance
  // now that days can legitimately differ from the flat weekly target.
  const expectedAchievedByDay: AchievedMacros[] = exchangeCountsByDay.map((counts) => sumExchanges(counts))

  const neededSlotsByExchangeType = new Map<ExchangeCode, Set<string>>()
  for (const skeleton of skeletonsByDay) {
    for (const [slot, items] of Object.entries(skeleton)) {
      for (const item of items) {
        const slots = neededSlotsByExchangeType.get(item.exchangeType) ?? new Set<string>()
        slots.add(slot)
        neededSlotsByExchangeType.set(item.exchangeType, slots)
      }
    }
  }

  // Moved ahead of eligible-foods so the archetype layer below can use
  // dayIndexOffset/recentArchetypeIdsBySlot — otherwise unchanged from
  // before this layer existed, still a single self-contained read.
  const { dayIndexOffset, previousWeekLastDay, recentArchetypeIdsBySlot } = await loadPreviousWeekSeed(
    roadmapId,
    weekNumber
  )

  // --- Meal Archetype layer (additive) -----------------------------------
  // Sits between meal distribution and eligible-foods filtering, exactly
  // as approved: never touches solverResult/skeleton (nutrition is already
  // fully decided above this line), only narrows which foods are eligible
  // to fill a slot the solver+distributor already solved. Querying
  // archetype tables is skipped entirely when the kill switch is off — "no
  // archetype behavior should execute" is true at the DB-access level, not
  // just the output level.
  const archetypeCandidatesBySlot: Record<string, ArchetypeCandidate[]> = {}
  if (env.ARCHETYPE_SELECTION_ENABLED) {
    const archetypeRows = await db
      .select({
        id: mealArchetypes.id,
        code: mealArchetypes.code,
        name: mealArchetypes.name,
        slot: mealArchetypes.slot,
        dietTypes: mealArchetypes.dietTypes,
        authenticityScore: mealArchetypes.authenticityScore,
        componentRole: archetypeComponents.componentRole,
        dishFamilyIds: archetypeComponents.dishFamilyIds,
        componentExchangeType: archetypeComponents.exchangeType,
        isRequired: archetypeComponents.isRequired,
      })
      .from(mealArchetypes)
      .innerJoin(archetypeComponents, eq(archetypeComponents.archetypeId, mealArchetypes.id))
      .where(and(eq(mealArchetypes.region, region), eq(mealArchetypes.isActive, true)))

    const archetypesById = new Map<string, ArchetypeCandidate>()
    for (const row of archetypeRows) {
      if (!row.dietTypes.includes(dietType)) continue
      let candidate = archetypesById.get(row.id)
      if (!candidate) {
        candidate = { id: row.id, code: row.code, name: row.name, authenticityScore: row.authenticityScore, components: [] }
        archetypesById.set(row.id, candidate)
        ;(archetypeCandidatesBySlot[row.slot] ??= []).push(candidate)
      }
      candidate.components.push({
        role: row.componentRole,
        dishFamilyIds: row.dishFamilyIds,
        exchangeType: row.componentExchangeType as ExchangeCode,
        isRequired: row.isRequired,
      })
    }
  }

  const archetypeAssignmentsByDay: ArchetypeAssignment[][] = selectArchetypesForWeek({
    slots: templates.map((t) => t.slot),
    candidatesBySlot: archetypeCandidatesBySlot,
    dayIndexOffset,
    recentArchetypeIdsBySlot,
    enabled: env.ARCHETYPE_SELECTION_ENABLED,
  })

  // Weekly union, per (slot, exchangeType), of every day's chosen
  // archetype's acceptable dish families — narrows eligibility once for
  // the whole week (matching how eligibleFoodsBySlot has always been
  // day-invariant), then the existing, UNCHANGED rotation logic (LLM
  // anti-repetition rules, fallback's stableHash rotation) picks day to
  // day within that narrower, coherence-biased pool. Empty when no
  // archetype applied anywhere, which produces byte-identical eligibility
  // output to before this layer existed (see eligible-foods.ts).
  const dishFamilyConstraints: DishFamilyConstraintsBySlot = {}
  for (const dayAssignments of archetypeAssignmentsByDay) {
    for (const assignment of dayAssignments) {
      if (!assignment.archetypeId) continue
      const bucket = (dishFamilyConstraints[assignment.slot] ??= {})
      for (const component of assignment.components) {
        const existing = bucket[component.exchangeType] ?? []
        bucket[component.exchangeType] = [...new Set([...existing, ...component.dishFamilyIds])]
      }
    }
  }
  // -------------------------------------------------------------------------

  const allFoods = await db.select().from(foods)

  // Fed into food-selector-fallback.ts so it can let vegetable_a/vegetable_b
  // co-occur in one slot when it's a real named dish (Aloo Gobi etc.) —
  // previously this data only ever got loaded at DISPLAY time
  // (plan-view-model.ts), too late for the selector to use it. Same
  // sorted-pair convention as pairKey() in food-selector-fallback.ts.
  const curatedVegetableCombinationRows = await db
    .select()
    .from(vegetableDishCombinations)
    .where(and(eq(vegetableDishCombinations.isActive, true), or(isNull(vegetableDishCombinations.region), eq(vegetableDishCombinations.region, region))))
  const curatedVegetableFamilyPairs = new Set<string>()
  if (curatedVegetableCombinationRows.length > 0) {
    const memberRows = await db
      .select()
      .from(vegetableDishCombinationMembers)
      .where(
        inArray(
          vegetableDishCombinationMembers.vegetableDishCombinationId,
          curatedVegetableCombinationRows.map((c) => c.id)
        )
      )
    const familiesByCombo = new Map<string, string[]>()
    for (const m of memberRows) {
      const list = familiesByCombo.get(m.vegetableDishCombinationId) ?? []
      list.push(m.dishFamilyId)
      familiesByCombo.set(m.vegetableDishCombinationId, list)
    }
    for (const combo of curatedVegetableCombinationRows) {
      const families = familiesByCombo.get(combo.id) ?? []
      // Only a genuine vegetable_a + vegetable_b PAIR is relevant here —
      // composeMealDisplay() always resolves each type to exactly one food
      // per slot, so a cross-type co-occurrence is always exactly 2 items.
      if (families.length === 2) curatedVegetableFamilyPairs.add([...families].sort().join("|"))
    }
  }

  let eligibleFoodsBySlot
  try {
    eligibleFoodsBySlot = eligibleFoodsForSkeleton(
      allFoods,
      { region, dietType, clientAllergens, clientDislikes, season },
      neededSlotsByExchangeType,
      dishFamilyConstraints
    )
  } catch (err) {
    if (err instanceof NoEligibleFoodsError) {
      return NextResponse.json(
        { error: err.message, exchangeType: err.exchangeType, slot: err.slot, failedFilter: err.failedFilter },
        { status: 422 }
      )
    }
    throw err
  }

  const foodSelectorInput: FoodSelectorInput = {
    region,
    dietType,
    mealCount,
    skeletonsByDay,
    eligibleFoodsBySlot,
    dayIndexOffset,
    previousWeekLastDay,
    archetypeAssignmentsByDay,
    curatedVegetableFamilyPairs,
  }

  const attempts: AttemptLog[] = []
  const selectionResult = await selectFoods(foodSelectorInput, { onAttempt: (log) => attempts.push(log) })

  // Informational only (Meal Archetype layer) — never affects generation
  // success/failure. Computed against whichever selection actually won
  // (LLM or fallback), attached below to the LAST logged attempt purely
  // for observability; nutrition validation (assertWithinTolerance,
  // further down) is entirely separate and unaffected by this.
  const archetypeAdherence = checkArchetypeAdherence(selectionResult.selection, archetypeAssignmentsByDay, foodSelectorInput)

  // Persisted immediately — independent of whether the rest of generation
  // succeeds, so a failure downstream (deviation check, DB write) never
  // silently drops the audit trail a dietitian needs to self-diagnose
  // (/settings/generation-log). Linked to a plan once one exists below.
  let runIds: string[] = []
  if (attempts.length > 0) {
    const inserted = await db
      .insert(planGenerationRuns)
      .values(
        attempts.map((log, i) => ({
          clientId: client.id,
          roadmapId,
          weekNumber,
          dietPlanId: null,
          attemptNumber: log.attemptNumber,
          model: log.model,
          promptHash: log.promptHash,
          rawResponse: log.rawResponse,
          validationResult:
            i === attempts.length - 1 && archetypeAdherence.length > 0
              ? { ...log.validationResult, archetypeAdherence }
              : log.validationResult,
          latencyMs: log.latencyMs,
        }))
      )
      .returning({ id: planGenerationRuns.id })
    runIds = inserted.map((r) => r.id)
  }

  const foodsById = new Map(allFoods.map((f) => [f.id, f]))
  let priced
  try {
    priced = priceSelection(selectionResult.selection, foodsById)
  } catch (err) {
    if (err instanceof UnknownFoodError || err instanceof ExchangeTypeMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    throw err
  }

  let deviations
  try {
    deviations = assertWithinTolerance(priced, expectedAchievedByDay)
    assertWeeklyAverageWithinTolerance(priced, dailyTarget)
  } catch (err) {
    if (err instanceof PricedSelectionDeviationError) {
      return NextResponse.json({ error: err.message, deviations: err.deviations }, { status: 500 })
    }
    if (err instanceof WeeklyAverageDeviationError) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    throw err
  }

  // No longer identical every day (see daily-macro-jitter.ts) — the plan-
  // level figure is the week's average across all 7 days, which is the
  // actual clinical guarantee assertWeeklyAverageWithinTolerance() just
  // checked, not an arbitrary single day's snapshot.
  const weeklyAverageAchieved: AchievedMacros = {
    kcal: priced.days.reduce((sum, d) => sum + d.achieved.kcal, 0) / priced.days.length,
    proteinG: priced.days.reduce((sum, d) => sum + d.achieved.proteinG, 0) / priced.days.length,
    carbsG: priced.days.reduce((sum, d) => sum + d.achieved.carbsG, 0) / priced.days.length,
    fatG: priced.days.reduce((sum, d) => sum + d.achieved.fatG, 0) / priced.days.length,
  }

  const dietPlanId = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(dietPlans)
      .values({
        clientId: client.id,
        roadmapId,
        weekNumber,
        weekStart: toIsoDate(weekStartDate),
        weekEnd: toIsoDate(weekEndDate),
        region,
        dietType,
        targets: dailyTarget,
        // Days are no longer identical (see daily-macro-jitter.ts) — this is
        // the week's average across all 7 days, not one day's snapshot.
        achieved: weeklyAverageAchieved,
        deviation: deviations,
        generationMode: selectionResult.generationMode,
        modelUsed: selectionResult.modelUsed,
        preparedBy: user.id,
        status: "draft",
      })
      .returning({ id: dietPlans.id })

    for (const day of priced.days) {
      const [dayRow] = await tx
        .insert(dietPlanDays)
        .values({
          dietPlanId: plan.id,
          dayIndex: day.dayIndex,
          date: toIsoDate(addDays(weekStartDate, day.dayIndex)),
          achieved: day.achieved,
        })
        .returning({ id: dietPlanDays.id })

      for (const meal of day.meals) {
        // Real display order, looked up by slot name from the meal
        // templates rather than trusted from the meal's position in
        // day.meals — that array's order matches slot_order only
        // incidentally (it falls out of Object.entries(skeleton) at
        // generation time), so this is the authoritative source regardless.
        const slotOrder = templates.find((t) => t.slot === meal.slot)?.slotOrder ?? 0
        // Observability only (Meal Archetype layer) — never read by
        // nutrition math. null whenever no archetype applied, which is
        // exactly what every diet_plan_meals row looked like before this
        // layer existed.
        const archetypeId =
          archetypeAssignmentsByDay[day.dayIndex]?.find((a) => a.slot === meal.slot)?.archetypeId ?? null
        const [mealRow] = await tx
          .insert(dietPlanMeals)
          .values({ dietPlanDayId: dayRow.id, slot: meal.slot, slotOrder, archetypeId })
          .returning({ id: dietPlanMeals.id })

        if (meal.items.length > 0) {
          await tx.insert(dietPlanItems).values(
            meal.items.map((item) => ({
              dietPlanMealId: mealRow.id,
              foodId: item.foodId,
              exchangeType: item.exchangeType,
              exchangeCount: item.exchangeCount,
              servingRawG: item.servingRawG,
            }))
          )
        }
      }
    }

    if (runIds.length > 0) {
      await tx.update(planGenerationRuns).set({ dietPlanId: plan.id }).where(inArray(planGenerationRuns.id, runIds))
    }

    return plan.id
  })

  return NextResponse.json(
    {
      dietPlanId,
      generationMode: selectionResult.generationMode,
      modelUsed: selectionResult.modelUsed,
      attempts: selectionResult.attempts,
      season,
      weekStart: toIsoDate(weekStartDate),
      weekEnd: toIsoDate(weekEndDate),
      achieved: weeklyAverageAchieved,
      deviations,
    },
    { status: 201 }
  )
}
