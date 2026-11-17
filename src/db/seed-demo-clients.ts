/**
 * Seeds four demo clients matching the golden worked examples (see
 * src/lib/counselling/roadmap.test.ts — TEST-001 Priya, TEST-002 Rahul,
 * TEST-003 Sneha, TEST-004 Aadi), each with a generated week-1 plan, so a
 * fresh clone is demoable in one command: `npm run seed:demo`.
 *
 * Idempotent: deletes any existing clients with these exact demo names
 * first (cascades to their sessions/roadmaps/plans), then re-seeds fresh —
 * safe to re-run.
 *
 * The roadmap for each client is computed by calling roadmapFor() directly
 * with the SAME literal RoadmapInput the golden test uses (including
 * currentIntake), not via roadmapInputFromAnswers() — that adapter never
 * populates currentIntake (see its own doc comment), so going through it
 * would silently diverge from the golden numbers. The stored Answers object
 * is a separate, consistent record for display and for plan generation's
 * diet-type/allergen extraction, not the source of the roadmap math.
 *
 * Food selection uses the deterministic fallback selector directly, not the
 * LLM — a seed script must be fast and reproducible on every machine
 * regardless of Anthropic credentials; real generations from the UI still try
 * the LLM first via POST /api/plan/generate.
 */
import { eq, inArray } from "drizzle-orm"

import { db } from "./index"
import { clients, counsellingSessions, dietPlanDays, dietPlanItems, dietPlanMeals, dietPlans, foods, mealTemplates, roadmaps } from "./schema"
import type { Answers } from "@/lib/counselling/questions"
import { ENGINE_VERSION, roadmapFor, weekTargets, type RoadmapInput } from "@/lib/counselling/roadmap"
import { computeDailyPulseJitter } from "@/lib/plan/daily-macro-jitter"
import { eligibleFoodsForSkeleton } from "@/lib/plan/eligible-foods"
import { fallbackSelection } from "@/lib/plan/food-selector-fallback"
import { distributeMeals, type MealSlotTemplate, type Skeleton } from "@/lib/plan/meal-distributor"
import { solveExchanges, type DietType } from "@/lib/plan/exchange-solver"
import { assertWeeklyAverageWithinTolerance, assertWithinTolerance, priceSelection } from "@/lib/plan/quantity"
import { sumExchanges, type AchievedMacros, type ExchangeCode, type ExchangeCounts } from "@/lib/plan/table-4-1"

interface DemoClient {
  name: string
  region: string
  dietType: DietType
  answersDietLabel: string
  roadmapInput: RoadmapInput
}

const DEMO_CLIENTS: DemoClient[] = [
  {
    name: "Priya (Demo — TEST-001)",
    region: "north_indian",
    dietType: "vegetarian",
    answersDietLabel: "Vegetarian",
    roadmapInput: {
      ageYears: 32,
      sex: "female",
      heightCm: 160,
      weightKg: 74,
      activityLevel: "Lightly active",
      trainingDaysPerWeek: 3,
      sessionIntensity: "Light",
      sessionDuration: "30–45 minutes",
      category: "first_timer",
      currentIntake: { kcal: 1625, proteinG: 50, carbsG: 218, fatG: 60 },
    },
  },
  {
    name: "Sneha (Demo — TEST-003)",
    region: "north_indian",
    // The real worked example is eggetarian, not vegetarian — a vegetarian
    // diet type cannot hit this target's protein:carb ratio (see
    // exchange-solver.test.ts, same finding reached there independently).
    dietType: "eggetarian",
    answersDietLabel: "Eggetarian",
    roadmapInput: {
      ageYears: 35,
      sex: "female",
      heightCm: 158,
      weightKg: 68,
      activityLevel: "Mostly seated",
      trainingDaysPerWeek: 5,
      sessionIntensity: "Light",
      sessionDuration: "30–45 minutes",
      category: "plateaued",
      currentIntake: { kcal: 1755, proteinG: 63, carbsG: 214, fatG: 70 },
      weeksOnPlan: 11,
      weeksStagnant: 4,
    },
  },
  {
    name: "Rahul (Demo — TEST-002)",
    region: "north_indian",
    dietType: "non_vegetarian",
    answersDietLabel: "Non-vegetarian",
    roadmapInput: {
      ageYears: 29,
      sex: "male",
      heightCm: 175,
      weightKg: 82,
      activityLevel: "Mostly seated",
      trainingDaysPerWeek: 4,
      sessionIntensity: "Moderate",
      sessionDuration: "60–90 minutes",
      category: "re_starter",
      currentIntake: { kcal: 1960, proteinG: 98, carbsG: 240, fatG: 66 },
    },
  },
  {
    name: "Aadi (Demo — TEST-004)",
    region: "maharashtrian",
    dietType: "eggetarian",
    answersDietLabel: "Eggetarian",
    roadmapInput: {
      ageYears: 27,
      sex: "male",
      heightCm: 172,
      weightKg: 66,
      activityLevel: "Mostly seated",
      trainingDaysPerWeek: 4,
      sessionIntensity: "Moderate",
      sessionDuration: "45–60 minutes",
      category: "maintenance",
      currentIntake: { kcal: 1958, proteinG: 83, carbsG: 227, fatG: 77 },
    },
  },
]

const MEAL_COUNT = 5

function answersFor(demo: DemoClient): Answers {
  const genderLabel = demo.roadmapInput.sex === "male" ? "Male" : "Female"
  const categoryLabel = {
    first_timer: "First-timer — never dieted with structure before",
    plateaued: "Plateaued — dieting now, weight has stopped moving",
    re_starter: "Re-starter — lost weight before and regained it",
    maintenance: "Maintenance — at or near goal, holding it",
  }[demo.roadmapInput.category]

  return {
    q9_age: demo.roadmapInput.ageYears,
    gender: genderLabel,
    q9_height: demo.roadmapInput.heightCm,
    q9_weight: demo.roadmapInput.weightKg,
    q54c: demo.roadmapInput.activityLevel,
    q44a: String(demo.roadmapInput.trainingDaysPerWeek),
    q44e: demo.roadmapInput.sessionIntensity,
    q44b: demo.roadmapInput.sessionDuration,
    q76_category: categoryLabel,
    q76_weeks_on_plan: demo.roadmapInput.weeksOnPlan,
    q76_weeks_stagnant: demo.roadmapInput.weeksStagnant,
    q33: demo.answersDietLabel,
    q27: ["No known allergy or intolerance"],
    q36: "",
  }
}

async function seedOne(demo: DemoClient) {
  console.log(`Seeding ${demo.name}...`)

  const [client] = await db.insert(clients).values({ name: demo.name }).returning()
  const answers = answersFor(demo)
  const [session] = await db
    .insert(counsellingSessions)
    .values({ clientId: client.id, type: "full", status: "submitted", answers, submittedAt: new Date() })
    .returning()

  const roadmapOutput = roadmapFor(demo.roadmapInput)
  const [roadmapRow] = await db
    .insert(roadmaps)
    .values({ sessionId: session.id, engineVersion: ENGINE_VERSION, input: demo.roadmapInput, output: roadmapOutput })
    .returning()

  const blockFlags = roadmapOutput.flags.filter((f) => f.level === "block" || f.level === "stop")
  if (blockFlags.length > 0) {
    console.warn(`  ${demo.name}: roadmap has unresolved block flags (${blockFlags.map((f) => f.code).join(", ")}) — skipping plan generation.`)
    return
  }

  const dailyTarget = weekTargets(roadmapOutput, 1)

  const templateRows = await db
    .select({ slot: mealTemplates.slot, slotOrder: mealTemplates.slotOrder, kcalShare: mealTemplates.kcalShare, allowedExchangeTypes: mealTemplates.allowedExchangeTypes })
    .from(mealTemplates)
    .where(eq(mealTemplates.region, demo.region))
  const templates: MealSlotTemplate[] = templateRows.map((r) => ({ ...r, allowedExchangeTypes: r.allowedExchangeTypes as ExchangeCode[] }))

  const solverResult = solveExchanges({
    kcal: dailyTarget.kcal,
    proteinG: dailyTarget.proteinG,
    fatG: dailyTarget.fatG,
    carbsG: dailyTarget.carbsG,
    fibreG: dailyTarget.fibreG,
    dietType: demo.dietType,
    sugarEnabled: false,
  })
  if (!solverResult.ok) {
    console.warn(`  ${demo.name}: solver could not hit tolerance (${solverResult.reason}) — skipping plan generation.`)
    return
  }

  // Day-to-day macro variety — see daily-macro-jitter.ts and route.ts's
  // mirror of this same block for the full rationale.
  const pulseJitterDeltas = computeDailyPulseJitter(solverResult.exchangeCounts.pulse, demo.dietType, `${roadmapRow.id}:1`)
  const exchangeCountsByDay: ExchangeCounts[] = pulseJitterDeltas.map((delta) => ({
    ...solverResult.exchangeCounts,
    pulse: solverResult.exchangeCounts.pulse + delta,
  }))
  const skeletonsByDay: Skeleton[] = exchangeCountsByDay.map((counts) => distributeMeals(counts, templates))
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

  const allFoods = await db.select().from(foods)
  const eligibleFoodsBySlot = eligibleFoodsForSkeleton(
    allFoods,
    { region: demo.region, dietType: demo.dietType, clientAllergens: [], clientDislikes: [] },
    neededSlotsByExchangeType
  )

  const selection = fallbackSelection({ region: demo.region, dietType: demo.dietType, mealCount: MEAL_COUNT, skeletonsByDay, eligibleFoodsBySlot })
  const foodsById = new Map(allFoods.map((f) => [f.id, f]))
  const priced = priceSelection(selection, foodsById)
  const deviations = assertWithinTolerance(priced, expectedAchievedByDay)
  assertWeeklyAverageWithinTolerance(priced, dailyTarget)
  const weeklyAverageAchieved: AchievedMacros = {
    kcal: priced.days.reduce((sum, d) => sum + d.achieved.kcal, 0) / priced.days.length,
    proteinG: priced.days.reduce((sum, d) => sum + d.achieved.proteinG, 0) / priced.days.length,
    carbsG: priced.days.reduce((sum, d) => sum + d.achieved.carbsG, 0) / priced.days.length,
    fatG: priced.days.reduce((sum, d) => sum + d.achieved.fatG, 0) / priced.days.length,
  }

  const anchor = session.submittedAt ?? session.createdAt
  const weekStartDate = new Date(anchor)
  const weekEndDate = new Date(weekStartDate.getTime() + 6 * 86_400_000)
  const toIso = (d: Date) => d.toISOString().slice(0, 10)

  const [plan] = await db
    .insert(dietPlans)
    .values({
      clientId: client.id,
      roadmapId: roadmapRow.id,
      weekNumber: 1,
      weekStart: toIso(weekStartDate),
      weekEnd: toIso(weekEndDate),
      region: demo.region,
      dietType: demo.dietType,
      targets: dailyTarget,
      achieved: weeklyAverageAchieved,
      deviation: deviations,
      generationMode: "fallback",
      modelUsed: null,
      preparedBy: null,
      status: "draft",
    })
    .returning()

  for (const day of priced.days) {
    const [dayRow] = await db
      .insert(dietPlanDays)
      .values({
        dietPlanId: plan.id,
        dayIndex: day.dayIndex,
        date: toIso(new Date(weekStartDate.getTime() + day.dayIndex * 86_400_000)),
        achieved: day.achieved,
      })
      .returning()

    for (const [slotOrder, meal] of day.meals.entries()) {
      const [mealRow] = await db.insert(dietPlanMeals).values({ dietPlanDayId: dayRow.id, slot: meal.slot, slotOrder }).returning()
      if (meal.items.length > 0) {
        await db.insert(dietPlanItems).values(
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

  console.log(`  ${demo.name}: client ${client.id}, plan ${plan.id} (${Math.round(dailyTarget.kcal)} kcal/day)`)
}

async function main() {
  const names = DEMO_CLIENTS.map((d) => d.name)
  const existing = await db.select({ id: clients.id }).from(clients).where(inArray(clients.name, names))
  if (existing.length > 0) {
    console.log(`Removing ${existing.length} existing demo client(s) for a clean reseed...`)
    await db.delete(clients).where(
      inArray(
        clients.id,
        existing.map((c) => c.id)
      )
    )
  }

  for (const demo of DEMO_CLIENTS) {
    await seedOne(demo)
  }

  console.log("Done.")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Demo seed failed:", err)
    process.exit(1)
  })
