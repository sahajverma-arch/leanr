import { describe, expect, it } from "vitest"

import { clientFoodRules, foodRuleViolation, recipeRuleViolation } from "./client-food-rules"
import {
  avoidsOnDate,
  dayFoodRulesFromAnswers,
  foodDayRuleViolation,
  recipeDayRuleViolation,
  restrictionsForWeek,
  type DayAvoid,
} from "./day-food-rules"
import { fixedMenuRecipeRefusal } from "./fixed-menu"
import { formatDayRestrictionsSection } from "./recipe-prompt"
import { balanceDayToTargets } from "./recipe-balancer"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { buildRepairPool, enforceDayRules, repairDay, repairWeek, REMOVED_FOR_DAY_RULE } from "./recipe-repair"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPipeline } from "./recipe-types"
import { makeRecipe } from "./test-fixtures"

const NON_VEG = ["non_vegetarian"]
const EGG = ["eggetarian", "non_vegetarian"]
const VEG = ["vegetarian", "eggetarian", "non_vegetarian"]

// Avik's real answers (2026-10-01): non-vegetarian, no non-veg or eggs on Monday.
const AVIK = {
  q33: "Non-vegetarian",
  q38: ["No non-vegetarian food on selected days"],
  q38a: ["Monday"],
  q38b: ["Non-vegetarian food", "Eggs"],
}

function pipeline(recipe: ReturnType<typeof makeRecipe>): RecipeForPipeline {
  const { rawCsvRow: _auditOnly, ...rest } = recipe
  return rest
}

const avoid = (...a: DayAvoid[]) => new Set<DayAvoid>(a)

describe("dayFoodRulesFromAnswers", () => {
  it("reads Avik's Monday rule", () => {
    const rules = dayFoodRulesFromAnswers(AVIK)
    expect([...rules.byWeekday.keys()]).toEqual([1])
    expect([...rules.byWeekday.get(1)!].sort()).toEqual(["egg", "non_veg"])
    expect(rules.incomplete).toBeNull()
  })

  it("treats the q38 option itself as forbidding non-veg, even if q38b only says Eggs", () => {
    const rules = dayFoodRulesFromAnswers({ ...AVIK, q38b: ["Eggs"] })
    expect([...rules.byWeekday.get(1)!].sort()).toEqual(["egg", "non_veg"])
  })

  it("ignores stale day answers the form hides when q38 is No restriction", () => {
    const rules = dayFoodRulesFromAnswers({ q38: ["No restriction"], q38a: ["Tuesday"], q38b: ["Eggs"] })
    expect(rules.byWeekday.size).toBe(0)
    expect(rules.incomplete).toBeNull()
  })

  it("has no rules when q38 is unanswered", () => {
    expect(dayFoodRulesFromAnswers({}).byWeekday.size).toBe(0)
  })

  it("applies No egg / No beef / No pork to every day", () => {
    const rules = dayFoodRulesFromAnswers({ q38: ["No egg", "No pork"] })
    expect(rules.byWeekday.size).toBe(7)
    expect([...rules.byWeekday.get(3)!].sort()).toEqual(["egg", "pork"])
  })

  it("refuses to guess when something is avoided but no days are ticked", () => {
    const rules = dayFoodRulesFromAnswers({ q38: ["No non-vegetarian food on selected days"], q38b: ["Non-vegetarian food"] })
    expect(rules.incomplete).toMatch(/no days are ticked/)
    expect(rules.byWeekday.size).toBe(0)
  })

  it("refuses when days are ticked with nothing avoided", () => {
    const rules = dayFoodRulesFromAnswers({ q38: ["Fasting practice"], q38a: ["Thursday"] })
    expect(rules.incomplete).toMatch(/not what is avoided/)
  })

  it("lists what code cannot check instead of dropping it", () => {
    const rules = dayFoodRulesFromAnswers({
      q38: ["Fasting practice", "Halal"],
      q38a: ["Thursday"],
      q38b: ["Specific grains (fasting)", "Onion & garlic"],
      q38c: "Navratri fasts",
    })
    expect(rules.incomplete).toBeNull()
    expect([...rules.byWeekday.get(4)!]).toEqual(["onion_garlic"])
    expect(rules.unchecked.join(" | ")).toContain("Specific grains (fasting)")
    expect(rules.unchecked.join(" | ")).toContain("Halal")
    expect(rules.unchecked.join(" | ")).toContain("Navratri fasts")
  })
})

describe("matching a rule to a real date", () => {
  const rules = dayFoodRulesFromAnswers(AVIK)

  it("matches the calendar weekday, not the day's position in the week", () => {
    // Avik's week starts on a Thursday: Monday is dayIndex 4, not 0.
    const week = restrictionsForWeek(rules, "2026-10-01")
    expect([...week.keys()]).toEqual([4])
    expect(week.get(4)!.weekday).toBe("Monday")
    expect(avoidsOnDate(rules, "2026-10-05").size).toBe(2)
    expect(avoidsOnDate(rules, "2026-10-06").size).toBe(0)
  })

  it("names the restricted day for the model", () => {
    const section = formatDayRestrictionsSection(restrictionsForWeek(rules, "2026-10-01"))
    expect(section).toContain("dayIndex 4 (Monday): no meat or fish, egg")
    expect(formatDayRestrictionsSection(new Map())).toBe("")
  })
})

describe("recipeDayRuleViolation", () => {
  const chicken = { name: "Chicken Kathi Roll", dietTypes: NON_VEG, allergenTags: [] }
  const prawns = { name: "Spicy Grilled Prawns Salad", dietTypes: NON_VEG, allergenTags: ["seafood"] }
  const eggRice = { name: "Egg Rice", dietTypes: EGG, allergenTags: ["egg"] }
  const dal = { name: "Arhar Dal", dietTypes: VEG, allergenTags: [] }

  it("blocks Avik's three Monday dishes and allows a dal", () => {
    const monday = avoid("non_veg", "egg")
    expect(recipeDayRuleViolation(chicken, monday, "Monday")).toMatch(/no non-veg on Monday/)
    expect(recipeDayRuleViolation(prawns, monday, "Monday")).toMatch(/non-veg/)
    expect(recipeDayRuleViolation(eggRice, monday, "Monday")).toMatch(/no egg on Monday/)
    expect(recipeDayRuleViolation(dal, monday, "Monday")).toBeNull()
  })

  it("keeps egg allowed when only non-veg is avoided", () => {
    expect(recipeDayRuleViolation(eggRice, avoid("non_veg"), "Tuesday")).toBeNull()
    expect(recipeDayRuleViolation(chicken, avoid("egg"), "Tuesday")).toBeNull()
  })

  it("catches a mislabelled fish dish by its own evidence", () => {
    const mislabelled = { name: "Goan Fish Curry", dietTypes: ["vegetarian", "vegan"], allergenTags: [] }
    expect(recipeDayRuleViolation(mislabelled, avoid("non_veg"), "Monday")).not.toBeNull()
  })

  it("treats All animal products as dairy too", () => {
    const paneer = { name: "Matar Paneer", dietTypes: VEG, allergenTags: ["lactose"] }
    const veganDal = { name: "Arhar Dal", dietTypes: [...VEG, "vegan"], allergenTags: [] }
    expect(recipeDayRuleViolation(paneer, avoid("all_animal"), "Monday")).toMatch(/animal products/)
    expect(recipeDayRuleViolation(veganDal, avoid("all_animal"), "Monday")).toBeNull()
  })

  it("checks onion and garlic by tag and by name", () => {
    expect(recipeDayRuleViolation({ name: "Aloo Sabzi", dietTypes: VEG, allergenTags: ["onion_garlic"] }, avoid("onion_garlic"), "Tuesday")).not.toBeNull()
    expect(recipeDayRuleViolation({ name: "Garlic Naan", dietTypes: VEG, allergenTags: [] }, avoid("onion_garlic"), "Tuesday")).not.toBeNull()
    expect(recipeDayRuleViolation({ name: "Lauki Sabzi", dietTypes: VEG, allergenTags: [] }, avoid("onion_garlic"), "Tuesday")).toBeNull()
  })

  it("does not read Eggless or Eggplant as egg", () => {
    expect(recipeDayRuleViolation({ name: "Eggless Cake", dietTypes: VEG, allergenTags: [] }, avoid("egg"), "Monday")).toBeNull()
    expect(recipeDayRuleViolation({ name: "Eggplant Bharta", dietTypes: VEG, allergenTags: [] }, avoid("egg"), "Monday")).toBeNull()
  })

  it("applies the same rule to exchange-engine foods", () => {
    expect(foodDayRuleViolation({ nameEn: "Chicken", dietTypes: NON_VEG, allergens: [] }, avoid("non_veg"), "Monday")).not.toBeNull()
    expect(foodDayRuleViolation({ nameEn: "Omelette", dietTypes: EGG, allergens: [] }, avoid("egg"), "Monday")).not.toBeNull()
    expect(foodDayRuleViolation({ nameEn: "Omelette", dietTypes: EGG, allergens: [] }, avoid("non_veg"), "Monday")).toBeNull()
    expect(foodDayRuleViolation({ nameEn: "Roti", dietTypes: VEG, allergens: [] }, avoid("non_veg", "egg"), "Monday")).toBeNull()
  })
})

describe("client-food-rules with a date", () => {
  const rules = clientFoodRules(AVIK, "non_vegetarian")
  const chicken = { name: "Green Chilli Chicken", dietTypes: NON_VEG, allergenTags: [] }

  it("blocks chicken on Monday only", () => {
    expect(recipeRuleViolation(chicken, rules, "2026-10-05")).toMatch(/Monday/)
    expect(recipeRuleViolation(chicken, rules, "2026-10-06")).toBeNull()
    expect(foodRuleViolation({ nameEn: "Chicken", dietTypes: NON_VEG, allergens: [] }, rules, "2026-10-05")).toMatch(/Monday/)
  })

  it("does not check weekday rules when no date is given", () => {
    expect(recipeRuleViolation(chicken, rules)).toBeNull()
  })
})

describe("fixed menu", () => {
  it("refuses a dish that breaks any weekday's rule, since the menu repeats every day", () => {
    const client = { dietType: "non_vegetarian", allergenTags: [], avoidTerms: [], dayRules: dayFoodRulesFromAnswers(AVIK) }
    const chicken = { name: "Kadai Chicken", dietTypes: NON_VEG, allergenTags: [], isActive: true, kcalPer100G: 150 }
    const dal = { name: "Arhar Dal", dietTypes: VEG, allergenTags: [], isActive: true, kcalPer100G: 120 }
    expect(fixedMenuRecipeRefusal(chicken, client)).toMatch(/Monday/)
    expect(fixedMenuRecipeRefusal(dal, client)).toBeNull()
  })
})

describe("generation repair", () => {
  const target: DailyRecipeTarget = { kcal: 600, proteinG: 35, carbsG: 60, fatG: 20, fiberG: 8 }
  const chickenCurry = pipeline(makeRecipe({ name: "Kadai Chicken", category: "Curry", dietTypes: NON_VEG, proteinPer100G: 18, carbsPer100G: 4, fatPer100G: 8 }))
  const eggCurry = pipeline(makeRecipe({ name: "Egg Curry", category: "Curry", dietTypes: EGG, allergenTags: ["egg"], proteinPer100G: 12, carbsPer100G: 4, fatPer100G: 9 }))
  const rajma = pipeline(makeRecipe({ name: "Rajma Curry", category: "Curry", dietTypes: VEG, proteinPer100G: 9, carbsPer100G: 15, fatPer100G: 3 }))
  const roti = pipeline(makeRecipe({ name: "Roti", category: "Roti", dietTypes: VEG, proteinPer100G: 9, carbsPer100G: 45, fatPer100G: 3 }))
  const pool = buildRepairPool([chickenCurry, eggCurry, rajma, roti])

  const monday = restrictionsForWeek(dayFoodRulesFromAnswers(AVIK), "2026-10-01")
  const constraints: ClientRecipeConstraints = { dietType: "non_vegetarian", eligibleCuisines: ["General"], allergenTags: [], dayRestrictions: monday }

  function day(dayIndex: number, items: RecipeForPipeline[]): GroundedRecipeDay {
    return balanceDayToTargets(
      {
        dayIndex,
        meals: [{ slot: "dinner", items: items.map((recipe) => ({ recipe, grams: recipe.idealGrams })) }],
        totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
        cappedRecipeNames: [],
        unknownRecipeNames: [],
      },
      target
    )
  }

  it("flags a Monday chicken dish as a plausibility problem, and not on other days", () => {
    expect(describePlausibilityProblems(day(4, [chickenCurry, roti]), constraints).join(" ")).toMatch(/no non-veg on Monday/)
    expect(describePlausibilityProblems(day(3, [chickenCurry, roti]), constraints).join(" ")).not.toMatch(/Monday/)
  })

  it("swaps Monday's chicken for a vegetarian dish of the same kind, never for egg", () => {
    const result = enforceDayRules(day(4, [chickenCurry, roti]), target, pool, constraints, new Map())
    expect(result.swaps).toEqual([{ dayIndex: 4, slot: "dinner", from: "Kadai Chicken", to: "Rajma Curry" }])
    expect(result.day.meals[0].items.map((i) => i.recipe.name)).toEqual(["Rajma Curry", "Roti"])
  })

  it("leaves non-Monday days alone", () => {
    const sunday = day(3, [chickenCurry, roti])
    expect(enforceDayRules(sunday, target, pool, constraints, new Map()).swaps).toEqual([])
  })

  it("removes the dish when nothing allowed can replace it", () => {
    const onlyMeat = buildRepairPool([chickenCurry, eggCurry, roti])
    const result = enforceDayRules(day(4, [chickenCurry, roti]), target, onlyMeat, constraints, new Map())
    expect(result.swaps[0].to).toBe(REMOVED_FOR_DAY_RULE)
    expect(result.day.meals[0].items.map((i) => i.recipe.name)).toEqual(["Roti"])
  })

  it("leaves a whole repaired week with no animal food on Monday", () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map((i) => day(i, [chickenCurry, eggCurry, roti]))
    const repaired = repairWeek(week, target, pool, constraints)
    const mondayNames = repaired.days[4].meals.flatMap((m) => m.items.map((i) => i.recipe.name))
    expect(mondayNames).not.toContain("Kadai Chicken")
    expect(mondayNames).not.toContain("Egg Curry")
    for (const d of repaired.days) {
      expect(describePlausibilityProblems(d, constraints).filter((p) => p.includes("Monday"))).toEqual([])
    }
  })

  it("never trades another problem for a weekday-rule break (the real Fish Tikka swap)", () => {
    // Replayed on a real plan: the macro repair swapped Coriander Chutney —
    // itself a problem, since it needs an idli/dosa beside it — for Fish
    // Tikka on Monday. One problem out, one in: the count stayed level, so
    // a count-only check accepted it.
    const chutney = pipeline(makeRecipe({ name: "Coriander Chutney", category: "Snack", dietTypes: VEG, mustHaveCategories: ["Idli"], proteinPer100G: 2, carbsPer100G: 10, fatPer100G: 5 }))
    const fishTikka = pipeline(makeRecipe({ name: "Fish Tikka", category: "Snack", dietTypes: NON_VEG, allergenTags: ["fish"], proteinPer100G: 22, carbsPer100G: 3, fatPer100G: 4 }))
    const snackPool = buildRepairPool([chutney, fishTikka])
    const proteinHungry: DailyRecipeTarget = { kcal: 250, proteinG: 30, carbsG: 10, fatG: 8, fiberG: 2 }
    const monday = balanceDayToTargets(
      {
        dayIndex: 4,
        meals: [{ slot: "evening", items: [{ recipe: chutney, grams: chutney.idealGrams }] }],
        totals: { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 },
        cappedRecipeNames: [],
        unknownRecipeNames: [],
      },
      proteinHungry
    )
    const result = repairDay(monday, proteinHungry, snackPool, constraints, new Map())
    expect(result.day.meals[0].items.map((i) => i.recipe.name)).not.toContain("Fish Tikka")

    // The same swap IS made on a day without the rule, so the test is real.
    const tuesday = repairDay({ ...monday, dayIndex: 5 }, proteinHungry, snackPool, constraints, new Map())
    expect(tuesday.day.meals[0].items.map((i) => i.recipe.name)).toContain("Fish Tikka")
  })
})
