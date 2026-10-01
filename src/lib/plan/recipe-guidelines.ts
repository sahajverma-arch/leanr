/**
 * Real sibling to plan-guidelines.ts's buildGuidelines(), not a branch
 * inside it — several of that function's bullets are pure exchange
 * vocabulary ("Vegetable A/B may be swapped freely", "1 egg may replace one
 * pulse exchange") with no recipe-engine analog, and the raw-weight-
 * cereal/pulse bullet is actively wrong for recipes (CSV grams are
 * as-served/cooked weight, the opposite convention). Mirrors the deleted
 * dish engine's own dish-guidelines.ts.
 */

import type { RoadmapResult } from "@/lib/counselling/roadmap"

import { categoryNarrative, joinNatural, numberWord, type GuidelineBullet, type PlanViewDay } from "./plan-guidelines"
import { portionSizeReferenceText } from "./recipe-quantity-display"

export interface BuildRecipeGuidelinesInput {
  plan: { cuisine: string; dietType: string }
  days: PlanViewDay[]
  roadmapOutput: RoadmapResult
}

export interface BuildRecipeGuidelinesResult {
  guidelines: GuidelineBullet[]
  foodsToAvoid: string[]
  narrative: string
}

export function buildRecipeGuidelines({ plan, days, roadmapOutput }: BuildRecipeGuidelinesInput): BuildRecipeGuidelinesResult {
  const day0 = days[0]
  const guidelines: GuidelineBullet[] = []

  guidelines.push({
    text: "Every recipe is drawn from a verified nutrition database, with realistic portion sizes computed for your targets — never a rough estimate.",
  })

  for (const flag of roadmapOutput.flags.filter((f) => f.level === "block")) {
    if (flag.code === "GOAL_CATEGORY_CONFLICT") {
      guidelines.push({
        lead: "Review the roadmap classification before starting.",
        text: `The plan has been costed exactly to the ${Math.round(roadmapOutput.macrosAtTarget.kcal)} kcal prescription, but the same roadmap also records ${roadmapOutput.anthro.toLoseKg.toFixed(1)} kg to lose. That intake will not produce that loss. Confirm the intended goal with the dietitian at the first check-in.`,
      })
    } else {
      guidelines.push({ lead: "Review before starting.", text: flag.message })
    }
  }

  // An optional wake-up/bedtime meal the dietitian has not filled yet is not a meal.
  const mealCount = day0?.meals.filter((m) => m.items.length > 0).length ?? 0
  const hasBedtime = day0?.meals.some((m) => m.slot === "bedtime" && m.items.length > 0) ?? false
  guidelines.push({
    lead: `${numberWord(mealCount)} meals, fixed times.`,
    text: "Skipping a meal doesn't lower the day's total — it just makes the remaining meals harder to finish.",
  })

  guidelines.push({
    text: "Portion sizes shown are as-served/cooked weight, ready to plate — not raw ingredient weight (the recipe engine's own convention, the opposite of Table 4.1's raw-weight cereal/pulse figures).",
  })

  // The scale behind every container-sized portion on this plan — without
  // it, "small bowl" is unanchored. Whole fruits and countable items (roti,
  // dosa, idli, cutlet) are counted by the piece instead and need no legend.
  guidelines.push({ text: portionSizeReferenceText() })

  if (roadmapOutput.proteinRamp.length > 0) {
    const ramp = roadmapOutput.proteinRamp
    const chain = [ramp[0].beforeG, ...ramp.map((r) => r.afterG)]
    guidelines.push({
      text: `Protein rises ${chain.map((g) => Math.round(g)).join(" → ")} g over the first ${ramp.length} week${ramp.length === 1 ? "" : "s"} while calories hold at ${Math.round(roadmapOutput.macrosAtTarget.kcal)}.`,
    })
  }

  guidelines.push({
    text: "Fibre is tracked alongside calories and macros and shown on the plan, but — unlike calories, protein, carbs and fat — it is not a hard pass/fail target.",
  })

  guidelines.push({
    text: hasBedtime
      ? "Hydration: 3.5+ litres of water per day. After dinner, have only what is listed at bedtime."
      : "Hydration: 3.5+ litres of water per day. Dinner is the last meal of the day.",
  })

  const foodsToAvoid: string[] = [
    "Sweetened drinks, packaged juice, cold drinks",
    "Deep-fried snacks: samosa, pakora, kachori, namkeen, chips, puri",
    "Bakery and refined-flour items: biscuits, rusk, cake, white bread, maida-based food",
    "Any oil or ghee beyond what's already cooked into the listed recipes",
  ]

  const narrative = buildRecipeNarrative({ plan, days, roadmapOutput })

  return { guidelines, foodsToAvoid, narrative }
}

function buildRecipeNarrative({
  plan,
  days,
  roadmapOutput,
}: {
  plan: { cuisine: string; dietType: string }
  days: PlanViewDay[]
  roadmapOutput: RoadmapResult
}): string {
  const day0 = days[0]
  const dietTypeLabel = plan.dietType.replace(/_/g, "-")
  const recipeNames = (day0?.meals.flatMap((m) => m.items.map((i) => i.nameEn)) ?? []).slice(0, 4)

  const sentence1 = recipeNames.length
    ? `${plan.cuisine} ${dietTypeLabel} plan built around real recipes like ${joinNatural(recipeNames)}, with portions computed to hit your daily targets.`
    : `${plan.cuisine} ${dietTypeLabel} plan with portions computed to hit your daily targets.`

  const sentence2 = "Day-to-day totals vary slightly by design (a small, expected wobble) while the week's average lands on target."

  const sentence3 = categoryNarrative(roadmapOutput)

  return `${sentence1} ${sentence2} ${sentence3}`
}
