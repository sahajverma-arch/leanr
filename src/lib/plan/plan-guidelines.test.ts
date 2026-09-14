import { describe, expect, it } from "vitest"

import type { RoadmapResult } from "@/lib/counselling/roadmap"
import { buildGuidelines, buildNarrative, categoryNarrative, dateLabel, joinNatural, numberWord, slugify, topFoodNames } from "./plan-guidelines"
import { makeFood } from "./test-fixtures"
import type { PlanViewDay, PlanViewMeal } from "./plan-guidelines"
import { ZERO_COUNTS } from "./table-4-1"

function makeRoadmapOutput(overrides: Partial<RoadmapResult> = {}): RoadmapResult {
  return {
    engineVersion: "1.0.0",
    energy: { bmr: 1500, neat: 1.2, met: 3, hours: 0.5, kcalPerSession: 100, activityAndTraining: 300, tdee: 2100 },
    anthro: {
      bmiValue: 25,
      classification: "Overweight",
      criteria: "Indian consensus",
      targetWeightKg: 65,
      healthyRangeKg: [55, 70],
      toLoseKg: 5,
      firstMilestoneKg: 2,
      fastestWeeks: 10,
      slowestWeeks: 20,
      fastestDivisor: 0.74,
      slowestDivisor: 0.37,
    },
    category: "first_timer",
    phases: [],
    macrosAtTarget: {
      dosingWeightKg: 65,
      proteinG: 80,
      fatG: 50,
      fatFromPercentG: 50,
      fatFromFloorG: 45,
      carbsG: 200,
      fibreG: 30,
      proteinHeld: false,
      flags: [],
      kcal: 1800,
    },
    proteinRamp: [],
    projection: { label: "At goal weight", weightKg: 65, kcal: 2000, proteinG: 97.5, fatG: 55, carbsG: 220, fibreG: 30, proteinHeldOrGoalBand: 1.5 },
    flags: [],
    ...overrides,
  }
}

function makeDay(dayIndex: number, mealsInput: Omit<PlanViewMeal, "id" | "archetypeId" | "archetypeName" | "archetypeDishFamilyIdsByExchangeType">[]): PlanViewDay {
  // `id` (the diet_plan_meals row) only exists so the plan page can add an
  // item to a specific meal — nothing in buildGuidelines reads it, so the
  // fixtures synthesise one rather than every case restating it.
  const meals: PlanViewMeal[] = mealsInput.map((m, i) => ({ ...m, id: `meal-${dayIndex}-${i}`, archetypeId: null, archetypeName: null, archetypeDishFamilyIdsByExchangeType: {} }))
  const totals = meals.reduce(
    (acc, m) => ({
      kcal: acc.kcal + m.totals.kcal,
      proteinG: acc.proteinG + m.totals.proteinG,
      carbsG: acc.carbsG + m.totals.carbsG,
      fatG: acc.fatG + m.totals.fatG,
    }),
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  )
  return { dayIndex, date: `2026-08-1${dayIndex}`, dateLabel: `Day ${dayIndex}`, meals, totals }
}

describe("joinNatural", () => {
  it("handles 0, 1, 2 and 3+ items", () => {
    expect(joinNatural([])).toBe("")
    expect(joinNatural(["roti"])).toBe("roti")
    expect(joinNatural(["roti", "rice"])).toBe("roti and rice")
    expect(joinNatural(["roti", "rice", "poha"])).toBe("roti, rice and poha")
  })
})

describe("numberWord", () => {
  it("spells out 0-8 and falls back to digits beyond that", () => {
    expect(numberWord(0)).toBe("Zero")
    expect(numberWord(5)).toBe("Five")
    expect(numberWord(9)).toBe("9")
  })
})

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Deepak Sharma")).toBe("deepak-sharma")
    expect(slugify("  Anjali   Joshi! ")).toBe("anjali-joshi")
  })
})

describe("dateLabel", () => {
  it("formats an ISO date as weekday, day and month", () => {
    expect(dateLabel("2026-08-08")).toBe("Saturday, 08 Aug")
  })
})

describe("topFoodNames", () => {
  const roti = makeFood({ id: "roti", nameEn: "Roti", exchangeType: "cereal" })
  const rice = makeFood({ id: "rice", nameEn: "Rice", exchangeType: "cereal" })
  const poha = makeFood({ id: "poha", nameEn: "Poha", exchangeType: "cereal" })

  const days: PlanViewDay[] = [
    makeDay(0, [{ slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 100, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(roti)] }]),
    makeDay(1, [{ slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 100, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(roti)] }]),
    makeDay(2, [{ slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 100, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(rice)] }]),
    makeDay(3, [{ slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 100, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(poha)] }]),
  ]

  it("ranks by frequency, ties broken alphabetically", () => {
    // roti: 2 days, rice/poha: 1 day each (tie) -> "poha" < "rice" alphabetically.
    expect(topFoodNames(days, "cereal", 4)).toEqual(["roti", "poha", "rice"])
  })

  it("respects the limit", () => {
    expect(topFoodNames(days, "cereal", 2)).toEqual(["roti", "poha"])
  })

  it("returns empty for an exchange type that never appears", () => {
    expect(topFoodNames(days, "pulse", 4)).toEqual([])
  })
})

function itemFor(food: ReturnType<typeof makeFood>) {
  return {
    id: `item-${food.id}`,
    foodId: food.id,
    nameEn: food.nameEn,
    householdMeasure: food.householdMeasure,
    servingRawG: food.servingRawG,
    exchangeType: food.exchangeType as "cereal",
    exchangeCount: 1,
    kcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    dishFamilyId: food.dishFamilyId,
    tags: food.tags,
  }
}

describe("categoryNarrative", () => {
  it("describes maintenance as no-deficit", () => {
    expect(categoryNarrative(makeRoadmapOutput({ category: "maintenance" }))).toContain("no deficit is applied")
  })

  it("describes first_timer as a moderate deficit", () => {
    expect(categoryNarrative(makeRoadmapOutput({ category: "first_timer" }))).toContain("moderate deficit")
  })
})

describe("buildNarrative", () => {
  const roti = makeFood({ id: "roti", nameEn: "Roti", exchangeType: "cereal" })
  const dal = makeFood({ id: "dal", nameEn: "Moong Dal", exchangeType: "pulse" })
  const palak = makeFood({ id: "palak", nameEn: "Palak", exchangeType: "vegetable_a" })
  const bhindi = makeFood({ id: "bhindi", nameEn: "Bhindi", exchangeType: "vegetable_a" })
  const apple = makeFood({ id: "apple", nameEn: "Apple", exchangeType: "fruit" })

  const days: PlanViewDay[] = [
    makeDay(0, [
      { slot: "breakfast", slotLabel: "Breakfast", timeLabel: "08:00", calPercent: 30, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(roti), itemFor(apple)] },
      {
        slot: "dinner",
        slotLabel: "Dinner",
        timeLabel: "20:00",
        calPercent: 70,
        totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
        items: [itemFor(dal), itemFor(palak), itemFor(bhindi)],
      },
      { slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 0, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(dal)] },
    ]),
  ]

  it("names the region/dietType, dal-at-both-main-meals, dinner sabzi count and fruit slot count", () => {
    const narrative = buildNarrative({ plan: { region: "north_indian", dietType: "vegetarian" }, days, roadmapOutput: makeRoadmapOutput() })
    expect(narrative).toContain("North indian vegetarian plan built on roti")
    expect(narrative).toContain("a dal at both main meals")
    expect(narrative).toContain("two sabzis at dinner")
    expect(narrative).toContain("fruit spread across 1 slot")
    expect(narrative).toContain("week's average lands exactly on target")
  })
})

describe("buildGuidelines", () => {
  const roti = makeFood({ id: "roti", nameEn: "Roti", exchangeType: "cereal", regions: ["north_indian"], dietTypes: ["vegetarian"] })
  const dal = makeFood({ id: "dal", nameEn: "Moong Dal", exchangeType: "pulse", regions: ["north_indian"], dietTypes: ["vegetarian"] })
  const ghee = makeFood({ id: "ghee", nameEn: "Ghee", exchangeType: "fat", regions: ["north_indian"], dietTypes: ["vegetarian"], servingRawG: 5, mealSlots: ["lunch", "dinner"] })
  const lauki = makeFood({ id: "lauki", nameEn: "Lauki", exchangeType: "vegetable_a", regions: ["north_indian"], dietTypes: ["vegetarian"] })
  const carrot = makeFood({ id: "carrot", nameEn: "Carrot", exchangeType: "vegetable_b", regions: ["north_indian"], dietTypes: ["vegetarian"] })
  const allFoods = [roti, dal, ghee, lauki, carrot]

  const days: PlanViewDay[] = [
    makeDay(0, [
      { slot: "lunch", slotLabel: "Lunch", timeLabel: "13:30", calPercent: 50, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [itemFor(roti), itemFor(dal), { ...itemFor(ghee), exchangeType: "fat", servingRawG: 10 }] },
      { slot: "dinner", slotLabel: "Dinner", timeLabel: "20:00", calPercent: 50, totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }, items: [{ ...itemFor(ghee), exchangeType: "fat", servingRawG: 15 }] },
    ]),
  ]

  it("always includes the Table 4.1 provenance line", () => {
    const { guidelines } = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS, cereal: 1, pulse: 1, fat: 5 },
      roadmapOutput: makeRoadmapOutput(),
      allFoods,
    })
    expect(guidelines[0].text).toContain("Table 4.1")
  })

  it("surfaces a block-level GOAL_CATEGORY_CONFLICT flag with the specific check-in wording", () => {
    const { guidelines } = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS },
      roadmapOutput: makeRoadmapOutput({
        flags: [{ level: "block", code: "GOAL_CATEGORY_CONFLICT", message: "conflict" }],
      }),
      allFoods,
    })
    const flagBullet = guidelines.find((g) => g.lead === "Review the roadmap classification before starting.")
    expect(flagBullet?.text).toContain("Confirm the intended goal with the dietitian")
  })

  it("does not surface warn-level flags as guideline bullets", () => {
    const { guidelines } = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS },
      roadmapOutput: makeRoadmapOutput({ flags: [{ level: "warn", code: "fat-floor", message: "internal footnote" }] }),
      allFoods,
    })
    expect(guidelines.some((g) => g.text.includes("internal footnote"))).toBe(false)
  })

  it("computes the cooking-oil line from the actual lunch/dinner fat grams", () => {
    const { guidelines } = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS },
      roadmapOutput: makeRoadmapOutput(),
      allFoods,
    })
    const oilBullet = guidelines.find((g) => g.lead === "Cooking oil is the one thing to measure.")
    expect(oilBullet?.text).toBe("10 g at lunch and 15 g at dinner, spooned into the pan, never poured. Tadka oil counts.")
  })

  it("includes the non-veg swap line for vegetarian but not for vegan/jain", () => {
    const veg = buildGuidelines({ plan: { region: "north_indian", dietType: "vegetarian" }, days, exchangeCounts: ZERO_COUNTS, roadmapOutput: makeRoadmapOutput(), allFoods })
    const vegan = buildGuidelines({ plan: { region: "north_indian", dietType: "vegan" }, days, exchangeCounts: ZERO_COUNTS, roadmapOutput: makeRoadmapOutput(), allFoods })
    expect(veg.guidelines.some((g) => g.text.startsWith("Non-vegetarian option"))).toBe(true)
    expect(vegan.guidelines.some((g) => g.text.startsWith("Non-vegetarian option"))).toBe(false)
  })

  it("builds the free-swap vegetable list from the full eligible universe, not just what's in the plan", () => {
    const { guidelines } = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: ZERO_COUNTS,
      roadmapOutput: makeRoadmapOutput(),
      allFoods,
    })
    const swapBullet = guidelines.find((g) => g.text.startsWith("Any vegetable"))
    expect(swapBullet?.text).toContain("lauki")
    expect(swapBullet?.text).toContain("carrot")
  })

  it("shows the sugar-avoidance line only when the plan carries zero sugar exchanges", () => {
    const withSugar = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS, sugar: 1 },
      roadmapOutput: makeRoadmapOutput(),
      allFoods,
    })
    const withoutSugar = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: { ...ZERO_COUNTS, sugar: 0 },
      roadmapOutput: makeRoadmapOutput(),
      allFoods,
    })
    expect(withSugar.foodsToAvoid.some((f) => f.startsWith("Sugar"))).toBe(false)
    expect(withoutSugar.foodsToAvoid.some((f) => f.startsWith("Sugar"))).toBe(true)
  })

  it("includes a protein-ramp preview only when the roadmap has ramp rows", () => {
    const noRamp = buildGuidelines({ plan: { region: "north_indian", dietType: "vegetarian" }, days, exchangeCounts: ZERO_COUNTS, roadmapOutput: makeRoadmapOutput(), allFoods })
    const withRamp = buildGuidelines({
      plan: { region: "north_indian", dietType: "vegetarian" },
      days,
      exchangeCounts: ZERO_COUNTS,
      roadmapOutput: makeRoadmapOutput({
        proteinRamp: [{ week: 1, beforeG: 73, gapG: 20, stepG: 10, stepFormula: "x", afterG: 83 }],
      }),
      allFoods,
    })
    expect(noRamp.guidelines.some((g) => g.text.startsWith("Protein rises"))).toBe(false)
    expect(withRamp.guidelines.find((g) => g.text.startsWith("Protein rises"))?.text).toContain("73 → 83")
  })
})
