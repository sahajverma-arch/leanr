/**
 * The single answer to "may this client be given this dish?" for anything
 * that checks an EXISTING plan or an edit to one: the plan page's red
 * banner, approval, the edit pickers and their server-side write gate, and
 * the final check before a generated week is saved.
 *
 * Three hard rules, all read LIVE from the counselling answers:
 *   - diet type, by the dish's own evidence (recipe-animal-content.ts), for
 *     BOTH the diet type stored on the plan and the client's current answer.
 *     A plan generated as non-vegetarian for a client later corrected to
 *     vegetarian must not keep accepting chicken just because of its label.
 *   - declared allergies ("Allergy — never serve"), by stored tag or name
 *     evidence (recipe-food-avoidance.ts),
 *   - dislikes (q36) and an "Other" allergy's name, matched on the dish name.
 *   - weekday rules (q38/q38a/q38b: "no non-veg or eggs on Monday"), checked
 *     only when the caller passes the day's date (day-food-rules.ts).
 *
 * Pure functions, zero I/O.
 */

import type { Answers } from "@/lib/counselling/questions"
import { isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"
import { compileAvoidTerms, recipeAvoidanceConflict, type CompiledAvoidTerm } from "@/lib/foods/recipe-food-avoidance"

import {
  clientAllergensFromAnswers,
  clientRecipeAllergenTagsFromAnswers,
  clientRecipeAvoidTermsFromAnswers,
  dietTypeFromAnswers,
} from "./client-profile-from-answers"
import { dayFoodRulesFromAnswers, foodDayRuleViolationOnDate, recipeDayRuleViolationOnDate, type DayFoodRules } from "./day-food-rules"

export interface ClientFoodRules {
  /** Every diet type the dish must satisfy — the plan's own, plus the live answer when it differs. */
  dietTypes: string[]
  /** Recipe-engine allergen vocabulary (recipe-allergen-normalize.ts). */
  recipeAllergenTags: string[]
  /** Exchange-engine allergen vocabulary (foods.allergens). */
  foodAllergens: string[]
  avoidTerms: CompiledAvoidTerm[]
  /** Weekday rules, by calendar weekday. */
  dayRules: DayFoodRules
}

export function clientFoodRules(answers: Answers, planDietType: string | null): ClientFoodRules {
  const dietTypes = new Set<string>()
  if (planDietType) dietTypes.add(planDietType)
  try {
    dietTypes.add(dietTypeFromAnswers(answers))
  } catch {
    // No usable q33 answer: the plan's own diet type is all there is to go on.
  }
  return {
    dietTypes: [...dietTypes],
    recipeAllergenTags: clientRecipeAllergenTagsFromAnswers(answers),
    foodAllergens: clientAllergensFromAnswers(answers),
    avoidTerms: compileAvoidTerms(clientRecipeAvoidTermsFromAnswers(answers)),
    dayRules: dayFoodRulesFromAnswers(answers),
  }
}

/**
 * Why this recipe must not be on this client's plan, or null if it may.
 * Pass `isoDate` (the plan day's date) whenever the dish sits on, or is
 * going onto, a specific day — without it the weekday rules are not checked.
 */
export function recipeRuleViolation(
  recipe: { name: string; dietTypes: readonly string[]; allergenTags: readonly string[] },
  rules: ClientFoodRules,
  isoDate?: string
): string | null {
  const wrongDiet = rules.dietTypes.find((d) => !isRecipeAllowedForDiet(recipe, d))
  if (wrongDiet) return `not suitable for a ${wrongDiet.replace("_", "-")} client`
  const conflict = recipeAvoidanceConflict(recipe, rules.recipeAllergenTags, rules.avoidTerms)
  if (conflict) return conflict
  return isoDate ? recipeDayRuleViolationOnDate(recipe, rules.dayRules, isoDate) : null
}

/** The same rules for an exchange-engine food row. */
export function foodRuleViolation(
  food: { nameEn: string; dietTypes: readonly string[]; allergens: readonly string[] },
  rules: ClientFoodRules,
  isoDate?: string
): string | null {
  const wrongDiet = rules.dietTypes.find((d) => !food.dietTypes.includes(d))
  if (wrongDiet) return `not suitable for a ${wrongDiet.replace("_", "-")} client`
  const allergen = food.allergens.find((a) => rules.foodAllergens.includes(a))
  if (allergen) return `contains ${allergen}, a declared allergen`
  const avoided = rules.avoidTerms.find(({ re }) => re.test(food.nameEn))
  if (avoided) return `matches "${avoided.term}", which this client avoids`
  return isoDate ? foodDayRuleViolationOnDate(food, rules.dayRules, isoDate) : null
}
