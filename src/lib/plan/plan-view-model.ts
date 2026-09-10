/**
 * Shared data + derivation layer for the plan page and the PDF export — both
 * render the SAME PlanViewModel so the two can never drift. Every number
 * here is either read straight from the persisted plan (already validated
 * at generation time — see quantity.ts) or recomputed from exchange counts
 * x Table 4.1; nothing is re-derived from the LLM or from food rows.
 *
 * Layout target: the real Deepak Sharma week-1 PDF (see CLAUDE.md "The
 * exchange system" for how that PDF grounds the whole exchange system).
 *
 * The pure display types and the dynamic guidelines/narrative generation
 * live in plan-guidelines.ts, which has no "@/db" import and is unit
 * tested directly; this file is the DB-touching orchestrator around it.
 */

import { asc, eq, inArray } from "drizzle-orm"

import { db } from "@/db"
import {
  archetypeComponents,
  clients,
  dietPlanDays,
  dietPlanItems,
  dietPlanMeals,
  dietPlanRecipeItems,
  dietPlans,
  dishCombinations,
  foods,
  mealArchetypes,
  profiles,
  recipes,
  roadmaps,
  vegetableDishCombinationMembers,
  vegetableDishCombinations,
} from "@/db/schema"
import type { DishCombination, VegetableDishCombination, VegetableDishCombinationMember } from "@/db/schema"
import type { Category, Macros, RoadmapFlag } from "@/lib/counselling/types"
import type { ProteinRampRow } from "@/lib/counselling/protein-ramp"
import type { RoadmapResult } from "@/lib/counselling/roadmap"
import {
  buildGuidelines,
  CATEGORY_LABEL,
  dateLabel,
  dateRangeLabel,
  SLOT_LABEL,
  SLOT_TIME,
  slugify,
  type GuidelineBullet,
  type PlanViewDay,
  type PlanViewItem,
  type PlanViewMeal,
  type WeeklySummaryRow,
} from "./plan-guidelines"
import { buildRecipeGuidelines } from "./recipe-guidelines"
import { recipeItemToPlanViewItem } from "./recipe-view-adapter"
import { TABLE_4_1, ZERO_COUNTS, type ExchangeCode, type ExchangeCounts } from "./table-4-1"
import { describeSupplement, type PrescribedSupplement } from "@/lib/counselling/supplement-adjusted-targets"

export { CATEGORY_LABEL } from "./plan-guidelines"
export type { GuidelineBullet, PlanViewDay, PlanViewItem, PlanViewMeal, WeeklySummaryRow } from "./plan-guidelines"

export interface PlanViewModel {
  plan: {
    id: string
    weekNumber: number
    weekStart: string
    weekEnd: string
    status: "draft" | "approved"
    /** Which generation pipeline produced this plan — see CLAUDE.md "The recipe engine". Governs which item table days/meals' children were loaded from, and whether swap/exchange-specific affordances apply. */
    engine: "exchange" | "recipe"
    generationMode: "ai" | "fallback"
    modelUsed: string | null
    region: string
    dietType: string
    preparedByName: string | null
  }
  client: { id: string; name: string; slug: string }
  roadmap: {
    id: string
    category: Category
    categoryLabel: string
    bmiValue: number
    classification: string
    weightKg: number
    heightCm: number
    tdee: number
    toLoseKg: number
    fastestWeeks: number
    slowestWeeks: number
    flags: RoadmapFlag[]
    proteinRamp: ProteinRampRow[]
  }
  targets: Macros
  deviationPct: { kcal: number; proteinG: number; fatG: number; carbsG: number }
  /** Generation warnings recorded on the plan row. Empty when the plan was a clean pass, or predates the column. */
  warnings: string[]
  /** One line describing the prescribed supplement, or null. Snapshotted on the plan, never a live lookup. */
  supplementLine: string | null
  days: PlanViewDay[]
  weeklySummary: WeeklySummaryRow[]
  weeklyAvg: WeeklySummaryRow
  /** Null for a recipe-engine plan — there is no exchange-count concept once foods are named recipes (see CLAUDE.md "The recipe engine"); explicit null rather than a silently-wrong all-zero ExchangeCounts. */
  exchangeCounts: ExchangeCounts | null
  guidelines: GuidelineBullet[]
  foodsToAvoid: string[]
  narrative: string
  /** Dish Composition Layer, stage 2 input — see dish-combination.ts. All active rows, unfiltered by region (the consumer filters). */
  dishCombinations: DishCombination[]
  /** Dish Composition Layer, stage 3 input — see vegetable-dish-naming.ts. All active rows plus their member rows, unfiltered by region (the consumer filters). */
  vegetableDishCombinations: VegetableDishCombination[]
  vegetableDishCombinationMembers: VegetableDishCombinationMember[]
}

export class PlanNotFoundError extends Error {
  constructor(id: string) {
    super(`Diet plan ${id} not found.`)
    this.name = "PlanNotFoundError"
  }
}

export async function loadPlanViewModel(planId: string): Promise<PlanViewModel> {
  const [planRow] = await db
    .select({ plan: dietPlans, client: clients, roadmap: roadmaps })
    .from(dietPlans)
    .innerJoin(clients, eq(dietPlans.clientId, clients.id))
    .innerJoin(roadmaps, eq(dietPlans.roadmapId, roadmaps.id))
    .where(eq(dietPlans.id, planId))
    .limit(1)
  if (!planRow) throw new PlanNotFoundError(planId)
  const { plan, client, roadmap } = planRow

  const preparedByRows = plan.preparedBy
    ? await db.select().from(profiles).where(eq(profiles.id, plan.preparedBy)).limit(1)
    : []
  const preparedByName = preparedByRows[0]?.fullName ?? preparedByRows[0]?.email?.split("@")[0] ?? null

  const dayRows = await db
    .select()
    .from(dietPlanDays)
    .where(eq(dietPlanDays.dietPlanId, planId))
    .orderBy(asc(dietPlanDays.dayIndex))

  const mealRows = dayRows.length
    ? await db
        .select()
        .from(dietPlanMeals)
        .where(
          inArray(
            dietPlanMeals.dietPlanDayId,
            dayRows.map((d) => d.id)
          )
        )
        .orderBy(asc(dietPlanMeals.slotOrder))
    : []

  // Forks by engine — the two item tables are mutually exclusive per plan
  // (see CLAUDE.md "The recipe engine"): a recipe-engine plan's meals have
  // zero diet_plan_items children and N diet_plan_recipe_items children, and
  // vice versa. Both branches converge on the SAME PlanViewItem[] shape, so
  // every downstream consumer (meal grouping, quantity formatting,
  // guidelines) is unaware of which engine produced a given plan.
  const itemsByMealId = new Map<string, PlanViewItem[]>()
  if (plan.engine === "recipe") {
    const recipeItemRows = mealRows.length
      ? await db
          .select({ item: dietPlanRecipeItems, recipe: recipes })
          .from(dietPlanRecipeItems)
          .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
          .where(
            inArray(
              dietPlanRecipeItems.dietPlanMealId,
              mealRows.map((m) => m.id)
            )
          )
      : []
    for (const { item, recipe } of recipeItemRows) {
      const list = itemsByMealId.get(item.dietPlanMealId) ?? []
      list.push(recipeItemToPlanViewItem(item, recipe))
      itemsByMealId.set(item.dietPlanMealId, list)
    }
  } else {
    const itemRows = mealRows.length
      ? await db
          .select({ item: dietPlanItems, food: foods })
          .from(dietPlanItems)
          .innerJoin(foods, eq(dietPlanItems.foodId, foods.id))
          .where(
            inArray(
              dietPlanItems.dietPlanMealId,
              mealRows.map((m) => m.id)
            )
          )
      : []
    for (const { item, food } of itemRows) {
      const exchangeType = item.exchangeType as ExchangeCode
      const macros = TABLE_4_1[exchangeType]
      const list = itemsByMealId.get(item.dietPlanMealId) ?? []
      list.push({
        id: item.id,
        foodId: item.foodId,
        nameEn: food.nameEn,
        householdMeasure: food.householdMeasure,
        servingRawG: item.servingRawG,
        exchangeType,
        exchangeCount: item.exchangeCount,
        kcal: macros.kcal * item.exchangeCount,
        proteinG: macros.proteinG * item.exchangeCount,
        carbsG: macros.carbsG * item.exchangeCount,
        fatG: macros.fatG * item.exchangeCount,
        dishFamilyId: food.dishFamilyId,
        tags: food.tags,
      })
      itemsByMealId.set(item.dietPlanMealId, list)
    }
  }

  // Dish Composition Layer, stage 1 input — names for whichever
  // meal_archetypes were actually used at generation time (currently South
  // Indian breakfast only; every other meal's archetypeId is null and gets
  // archetypeName: null below). Presentation only — never affects which
  // foods were selected, only what a meal is later labelled as.
  const archetypeIds = [...new Set(mealRows.map((m) => m.archetypeId).filter((id): id is string => id !== null))]
  const archetypeNameById = new Map<string, string>()
  // Each archetype's OWN declared dish_family_ids, keyed by exchange type —
  // see dish-combination.ts's archetype-name-merge gate. The weekly-union
  // narrowing (eligibleFoodsBySlot is day-invariant) means the food
  // actually selected on a given day can drift from what that day's
  // archetype intended (checkArchetypeAdherence's "partial" case), so the
  // merge must verify the SPECIFIC selected foods' dish_family_ids against
  // this, not just "does the archetype have a pulse role at all".
  const dishFamilyIdsByExchangeTypeByArchetype = new Map<string, Partial<Record<ExchangeCode, string[]>>>()
  if (archetypeIds.length > 0) {
    const archetypeRows = await db
      .select({ id: mealArchetypes.id, name: mealArchetypes.name })
      .from(mealArchetypes)
      .where(inArray(mealArchetypes.id, archetypeIds))
    for (const a of archetypeRows) archetypeNameById.set(a.id, a.name)

    const componentRows = await db
      .select({
        archetypeId: archetypeComponents.archetypeId,
        exchangeType: archetypeComponents.exchangeType,
        dishFamilyIds: archetypeComponents.dishFamilyIds,
      })
      .from(archetypeComponents)
      .where(inArray(archetypeComponents.archetypeId, archetypeIds))
    for (const row of componentRows) {
      const byType = dishFamilyIdsByExchangeTypeByArchetype.get(row.archetypeId) ?? {}
      const exchangeType = row.exchangeType as ExchangeCode
      byType[exchangeType] = [...(byType[exchangeType] ?? []), ...row.dishFamilyIds]
      dishFamilyIdsByExchangeTypeByArchetype.set(row.archetypeId, byType)
    }
  }

  const mealsByDayId = new Map<string, PlanViewMeal[]>()
  for (const meal of mealRows) {
    const items = itemsByMealId.get(meal.id) ?? []
    const totals = items.reduce(
      (acc, i) => ({
        kcal: acc.kcal + i.kcal,
        proteinG: acc.proteinG + i.proteinG,
        carbsG: acc.carbsG + i.carbsG,
        fatG: acc.fatG + i.fatG,
        fiberG: (acc.fiberG ?? 0) + (i.fiberG ?? 0),
      }),
      { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
    )
    const list = mealsByDayId.get(meal.dietPlanDayId) ?? []
    list.push({
      slot: meal.slot,
      slotLabel: SLOT_LABEL[meal.slot] ?? meal.slot,
      timeLabel: SLOT_TIME[meal.slot] ?? "",
      items,
      totals,
      calPercent: 0, // filled in once the day total is known
      archetypeId: meal.archetypeId,
      archetypeName: meal.archetypeId ? (archetypeNameById.get(meal.archetypeId) ?? null) : null,
      archetypeDishFamilyIdsByExchangeType: meal.archetypeId
        ? (dishFamilyIdsByExchangeTypeByArchetype.get(meal.archetypeId) ?? {})
        : {},
    })
    mealsByDayId.set(meal.dietPlanDayId, list)
  }

  const days: PlanViewDay[] = dayRows.map((day) => {
    const meals = mealsByDayId.get(day.id) ?? []
    const dayTotals = meals.reduce(
      (acc, m) => ({
        kcal: acc.kcal + m.totals.kcal,
        proteinG: acc.proteinG + m.totals.proteinG,
        carbsG: acc.carbsG + m.totals.carbsG,
        fatG: acc.fatG + m.totals.fatG,
        fiberG: (acc.fiberG ?? 0) + (m.totals.fiberG ?? 0),
      }),
      { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
    )
    const mealsWithPct = meals.map((m) => ({
      ...m,
      calPercent: dayTotals.kcal > 0 ? (m.totals.kcal / dayTotals.kcal) * 100 : 0,
    }))
    return {
      dayIndex: day.dayIndex,
      date: day.date,
      dateLabel: dateLabel(day.date),
      meals: mealsWithPct,
      totals: dayTotals,
    }
  })

  const weeklySummary: WeeklySummaryRow[] = days.map((d) => ({
    label: d.dateLabel,
    kcal: d.totals.kcal,
    proteinG: d.totals.proteinG,
    carbsG: d.totals.carbsG,
    fatG: d.totals.fatG,
    fiberG: d.totals.fiberG,
    proteinPct: d.totals.kcal > 0 ? ((d.totals.proteinG * 4) / d.totals.kcal) * 100 : 0,
    carbsPct: d.totals.kcal > 0 ? ((d.totals.carbsG * 4) / d.totals.kcal) * 100 : 0,
    fatPct: d.totals.kcal > 0 ? ((d.totals.fatG * 9) / d.totals.kcal) * 100 : 0,
  }))

  const weeklyAvg: WeeklySummaryRow = weeklySummary.length
    ? {
        label: "Weekly Avg",
        kcal: avg(weeklySummary.map((r) => r.kcal)),
        proteinG: avg(weeklySummary.map((r) => r.proteinG)),
        carbsG: avg(weeklySummary.map((r) => r.carbsG)),
        fatG: avg(weeklySummary.map((r) => r.fatG)),
        fiberG: avg(weeklySummary.map((r) => r.fiberG ?? 0)),
        proteinPct: avg(weeklySummary.map((r) => r.proteinPct)),
        carbsPct: avg(weeklySummary.map((r) => r.carbsPct)),
        fatPct: avg(weeklySummary.map((r) => r.fatPct)),
      }
    : { label: "Weekly Avg", kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0, proteinPct: 0, carbsPct: 0, fatPct: 0 }

  let exchangeCounts: ExchangeCounts | null = null
  if (plan.engine === "exchange") {
    const counts: ExchangeCounts = { ...ZERO_COUNTS }
    for (const meal of days[0]?.meals ?? []) {
      for (const item of meal.items) {
        if (item.exchangeType !== null) counts[item.exchangeType] += item.exchangeCount
      }
    }
    exchangeCounts = counts
  }

  const targets = plan.targets as Macros
  // Computed from plan.achieved (the week's average across all 7 days —
  // see route.ts) against the true prescribed target, NOT read from
  // plan.deviation[0]: since daily-macro-jitter.ts, each stored per-day
  // deviation is a day checked against its OWN jittered expectation (see
  // quantity.ts's assertWithinTolerance), which is ~0 by construction and no
  // longer means "how far this plan is from the client's actual target" —
  // that clinical QA figure is exactly what assertWeeklyAverageWithinTolerance
  // validates, so it's what gets shown here too.
  const achieved = plan.achieved as Macros
  const deviationPct = {
    kcal: (Math.abs(achieved.kcal - targets.kcal) / targets.kcal) * 100,
    proteinG: (Math.abs(achieved.proteinG - targets.proteinG) / targets.proteinG) * 100,
    fatG: (Math.abs(achieved.fatG - targets.fatG) / targets.fatG) * 100,
    carbsG: (Math.abs(achieved.carbsG - targets.carbsG) / targets.carbsG) * 100,
  }

  const roadmapOutput = roadmap.output as RoadmapResult

  // Dish Composition Layer inputs (dish_combinations, vegetable_dish_
  // combinations) and buildGuidelines()'s own allFoods load are exchange-
  // system constructs with no recipe-engine analog — every recipe is
  // already its own complete named identity, so this layer never applies
  // to a recipe-engine plan. Skipping the queries entirely for plan.engine
  // === "recipe" is honest self-documentation that this data is
  // exchange-only, not just an unused-but-loaded value.
  let guidelines: GuidelineBullet[]
  let foodsToAvoid: string[]
  let narrative: string
  let dishCombinationRows: DishCombination[] = []
  let vegetableDishCombinationRows: VegetableDishCombination[] = []
  let vegetableDishCombinationMemberRows: VegetableDishCombinationMember[] = []

  if (plan.engine === "recipe") {
    // dietPlans has no dedicated `cuisine` column — the recipe engine
    // reuses `region` to carry the cuisine string, the same pragmatic reuse
    // the deleted dish engine made of this column.
    ;({ guidelines, foodsToAvoid, narrative } = buildRecipeGuidelines({ plan: { cuisine: plan.region, dietType: plan.dietType }, days, roadmapOutput }))
  } else {
    const allFoods = await db.select().from(foods)
    ;({ guidelines, foodsToAvoid, narrative } = buildGuidelines({
      plan,
      days,
      exchangeCounts: exchangeCounts!,
      roadmapOutput,
      allFoods,
    }))

    // Dish Composition Layer, stage 2 input — every active combination row;
    // combineDishGroups() filters by region and matches by dish_family_id at
    // render time. Small, unconditionally cheap to load (a handful of rows).
    dishCombinationRows = await db.select().from(dishCombinations).where(eq(dishCombinations.isActive, true))

    // Dish Composition Layer, stage 3 input — see vegetable-dish-naming.ts.
    vegetableDishCombinationRows = await db
      .select()
      .from(vegetableDishCombinations)
      .where(eq(vegetableDishCombinations.isActive, true))
    vegetableDishCombinationMemberRows = vegetableDishCombinationRows.length
      ? await db
          .select()
          .from(vegetableDishCombinationMembers)
          .where(
            inArray(
              vegetableDishCombinationMembers.vegetableDishCombinationId,
              vegetableDishCombinationRows.map((c) => c.id)
            )
          )
      : []
  }

  return {
    plan: {
      id: plan.id,
      weekNumber: plan.weekNumber,
      weekStart: plan.weekStart,
      weekEnd: plan.weekEnd,
      status: plan.status,
      engine: plan.engine,
      generationMode: plan.generationMode,
      modelUsed: plan.modelUsed,
      region: plan.region,
      dietType: plan.dietType,
      preparedByName,
    },
    client: { id: client.id, name: client.name, slug: slugify(client.name) },
    roadmap: {
      id: roadmap.id,
      category: roadmapOutput.category,
      categoryLabel: CATEGORY_LABEL[roadmapOutput.category] ?? roadmapOutput.category,
      bmiValue: roadmapOutput.anthro.bmiValue,
      classification: roadmapOutput.anthro.classification,
      weightKg: roadmapOutput.projection.weightKg,
      heightCm: 0, // filled by caller if needed — not on RoadmapResult directly
      tdee: roadmapOutput.energy.tdee,
      toLoseKg: roadmapOutput.anthro.toLoseKg,
      fastestWeeks: roadmapOutput.anthro.fastestWeeks,
      slowestWeeks: roadmapOutput.anthro.slowestWeeks,
      flags: roadmapOutput.flags,
      proteinRamp: roadmapOutput.proteinRamp,
    },
    targets,
    deviationPct,
    warnings: (plan.warnings as string[] | null) ?? [],
    supplementLine: plan.supplement ? describeSupplement(plan.supplement as PrescribedSupplement) : null,
    days,
    weeklySummary,
    weeklyAvg,
    exchangeCounts,
    guidelines,
    foodsToAvoid,
    narrative,
    dishCombinations: dishCombinationRows,
    vegetableDishCombinations: vegetableDishCombinationRows,
    vegetableDishCombinationMembers: vegetableDishCombinationMemberRows,
  }
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

export function planDateRangeLabel(plan: PlanViewModel["plan"]): string {
  return dateRangeLabel(plan.weekStart, plan.weekEnd)
}
