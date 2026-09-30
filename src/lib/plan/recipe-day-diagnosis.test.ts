import { describe, expect, it } from "vitest"

import { blockingProblems, diagnoseDay } from "./recipe-day-diagnosis"
import type { ClientRecipeConstraints } from "./recipe-plausibility-validate"
import type { GroundedRecipeDay, RecipeSelectorInput } from "./recipe-types"
import type { Recipe } from "@/db/schema"

const TARGET = { kcal: 2000, proteinG: 85, carbsG: 262, fatG: 68, fiberG: 30 }

function recipe(partial: Partial<Recipe> & { name: string }): Recipe {
  return {
    name: partial.name,
    category: partial.category ?? "Roti",
    dietTypes: partial.dietTypes ?? ["vegetarian", "eggetarian", "non_vegetarian"],
    cuisine: partial.cuisine ?? "General",
    consistency: partial.consistency ?? "solid",
    mainOrMid: partial.mainOrMid ?? "main",
    allergenTags: partial.allergenTags ?? [],
    mustHaveCategories: partial.mustHaveCategories ?? [],
    mustHaveRecipeNames: partial.mustHaveRecipeNames ?? [],
    goodToHaveCategories: [],
    goodToHaveRecipeNames: [],
    carbsPer100G: partial.carbsPer100G ?? 40,
    proteinPer100G: partial.proteinPer100G ?? 8,
    fatPer100G: partial.fatPer100G ?? 2,
    fiberPer100G: partial.fiberPer100G ?? 3,
  } as unknown as Recipe
}

/** A day that is fully on-target and structurally sound, so each test can introduce exactly one defect. */
function healthyDay(overrides: Partial<GroundedRecipeDay> = {}): GroundedRecipeDay {
  return {
    dayIndex: 0,
    meals: [
      { slot: "breakfast", items: [{ recipe: recipe({ name: "Paratha", category: "Paratha" }), grams: 120 }] },
      {
        slot: "lunch",
        items: [
          { recipe: recipe({ name: "Roti", category: "Roti" }), grams: 100 },
          { recipe: recipe({ name: "Dal", category: "Dal" }), grams: 200 },
        ],
      },
      {
        slot: "dinner",
        items: [
          { recipe: recipe({ name: "Rice", category: "Rice" }), grams: 250 },
          { recipe: recipe({ name: "Curry", category: "Curry" }), grams: 200 },
        ],
      },
    ],
    totals: { ...TARGET },
    cappedRecipeNames: [],
    unknownRecipeNames: [],
    ...overrides,
  }
}

const INPUT = { dailyTarget: TARGET } as unknown as RecipeSelectorInput
const CONSTRAINTS: ClientRecipeConstraints = { dietType: "non_vegetarian", eligibleCuisines: ["General"], allergenTags: [] }

describe("blockingProblems — what actually rejects a plan", () => {
  it("passes a clean, on-target day", () => {
    expect(blockingProblems(healthyDay(), INPUT, CONSTRAINTS, new Set())).toEqual([])
  })

  it("REGRESSION: a serving-limit hit alone no longer blocks the write", () => {
    const day = healthyDay({ cappedRecipeNames: ["Roti", "Dal"] })
    expect(blockingProblems(day, INPUT, CONSTRAINTS, new Set())).toEqual([])
  })

  it("still blocks on a macro miss", () => {
    const day = healthyDay({ totals: { ...TARGET, proteinG: 40 } })
    expect(blockingProblems(day, INPUT, CONSTRAINTS, new Set()).join(" ")).toMatch(/protein/i)
  })

  it("still blocks on a plausibility problem", () => {
    const day = healthyDay()
    day.meals.push({ slot: "evening", items: [] })
    expect(blockingProblems(day, INPUT, CONSTRAINTS, new Set()).join(" ")).toMatch(/no resolved items/i)
  })

  it("still blocks on a variety violation", () => {
    const problems = blockingProblems(healthyDay(), INPUT, CONSTRAINTS, new Set(["Roti"]))
    expect(problems.join(" ")).toMatch(/variety limit/i)
  })

  it("still blocks on an unresolvable recipe name", () => {
    const day = healthyDay({ unknownRecipeNames: ["Nonexistent Dish"] })
    expect(blockingProblems(day, INPUT, CONSTRAINTS, new Set()).join(" ")).toMatch(/Could not identify/i)
  })
})

describe("diagnoseDay — what the model is told on a retry", () => {
  it("still reports the serving-limit hit, so a retried day is steered away from it", () => {
    const day = healthyDay({ cappedRecipeNames: ["Roti"] })
    expect(diagnoseDay(day, INPUT, CONSTRAINTS, new Set()).join(" ")).toMatch(/serving limit/i)
  })

  it("carries every blocking problem too — it is a superset, never a replacement", () => {
    const day = healthyDay({ totals: { ...TARGET, proteinG: 40 }, cappedRecipeNames: ["Roti"] })
    const blocking = blockingProblems(day, INPUT, CONSTRAINTS, new Set())
    const diagnosed = diagnoseDay(day, INPUT, CONSTRAINTS, new Set())
    for (const p of blocking) expect(diagnosed).toContain(p)
    expect(diagnosed.length).toBe(blocking.length + 1)
  })
})
