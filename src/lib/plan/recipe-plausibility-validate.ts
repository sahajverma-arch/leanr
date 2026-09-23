/**
 * A day can be perfectly on-macro (recipe-validate.ts) and still be a
 * nonsensical plate — this is a genuinely separate check, deliberately not
 * folded into the same function, so the day-retry diagnosis can tell the
 * model exactly which kind of problem it needs to fix.
 */

import { isAnimalProteinRecipe, isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"
import { recipeCategoryBucket, type RecipeCategoryBucket } from "./recipe-category"
import { DAL_BUCKET, isSelfContainedMeal, LIQUID_MAIN_BUCKETS, MEAT_CONFLICTING_BUCKETS, STAPLE_BUCKETS, STRUCTURED_MEAL_SLOTS } from "./recipe-meal-structure"
import { isMustHaveSatisfied } from "./recipe-pairing"
import type { GroundedRecipeDay } from "./recipe-types"

export interface ClientRecipeConstraints {
  dietType: string
  eligibleCuisines: string[]
  allergenTags: string[]
}

// A meal may never stack more than one of these together — the same
// "implausible plate" shape the deleted dish engine's evening-snack-
// stacking fix addressed (a fried snack + a dessert + a creamy drink all in
// one slot, each individually a legitimate pick).
const RICH_BUCKETS_NOT_STACKED = new Set(["heavy_meal", "dessert"])

// The exact category-name markers a staple's own must-have list uses to
// mean "needs a protein/curry accompaniment" (Sabzi/High Protein Sabzi/Dal/
// Curry) — a real animal-protein dish elsewhere in the meal already fills
// that role, so this specific unmet requirement is waived when one is
// present (see the hasRealAnimalProtein check below). Any OTHER unmet
// requirement (e.g. a Raita still genuinely needing Pulao/Khichdi/Biryani)
// is never waived just because the meal happens to also have meat in it.
const MEAT_SATISFIES_MARKERS = new Set(["sabzi", "high protein sabzi", "dal", "curry"])

// mid_morning/evening/bedtime are snack/beverage-only occasions by this
// codebase's own established convention (the exchange engine's own
// meal_templates restrict these slots to fruit/fat/cereal — never a full
// MAIN dish) — a real live-generation run confirmed this fires on nearly
// every real day otherwise (mid_morning legitimately has only chai/fruit,
// never a MAIN item), so requiring one here was a bug, not a real
// plausibility problem.
const NO_MAIN_REQUIRED_SLOTS = new Set(["mid_morning", "evening", "bedtime"])

export function describePlausibilityProblems(day: GroundedRecipeDay, constraints: ClientRecipeConstraints): string[] {
  const problems: string[] = []

  for (const meal of day.meals) {
    if (meal.items.length === 0) {
      problems.push(`${meal.slot} has no resolved items`)
      continue
    }

    const namesSeen = new Set<string>()
    let richCount = 0
    let hasMain = false
    let hasSolidMain = false
    let hasSelfContainedDish = false
    let hasRealAnimalProtein = false
    let hasConflictingVegSideDish = false
    const liquidMainItemNames: string[] = []
    const itemBuckets: RecipeCategoryBucket[] = []

    for (const item of meal.items) {
      if (namesSeen.has(item.recipe.name)) {
        problems.push(`${meal.slot} has a duplicate recipe: ${item.recipe.name}`)
      }
      namesSeen.add(item.recipe.name)

      const bucket = recipeCategoryBucket(item.recipe.category, item.recipe.name)
      itemBuckets.push(bucket)
      if (isSelfContainedMeal(item.recipe.category, bucket, item.recipe.carbsPer100G)) hasSelfContainedDish = true
      // A real egg/meat/fish dish (not eligible for plain vegetarian) is
      // its own protein course, substituting for dal the same way
      // CLAUDE.md documents for the exchange engine (MEAT_CONFLICTING_TYPES
      // — "a non-veg dish is conventionally its own protein-and-side
      // course, not an addition to a dal-and-sabzi one"). The deterministic
      // fallback (recipe-selector-fallback.ts) already excludes dal_curry
      // from a non-veg meal for exactly this reason; this check was missing
      // that same exemption, so it silently disagreed with the fallback's
      // own convention until a live non-vegetarian generation surfaced it.
      const isAnimalProtein = isAnimalProteinRecipe(item.recipe)
      if (isAnimalProtein) hasRealAnimalProtein = true
      // A dish's own bucket can land on dal_curry via the curry-name
      // reclassification (e.g. "Chicken Curry" itself) — that's the meat
      // dish's own preparation style, not a separate side, so it must never
      // count as "conflicting" with itself. Only a genuinely distinct,
      // non-animal-protein sabzi/dal item is the real conflict below.
      else if (MEAT_CONFLICTING_BUCKETS.has(bucket)) hasConflictingVegSideDish = true

      if (item.recipe.mainOrMid === "main") {
        hasMain = true
        // A liquid dish (soup/tea/shake) can't be the ONLY main-tagged item
        // anchoring a meal — but a real liquid dal served alongside a solid
        // staple (rice, roti) is completely normal, e.g. "Rice + Lentil
        // Soup + Cauliflower Curry", confirmed on a real live-generation
        // run where Lentil Soup (genuinely consistency=liquid) was wrongly
        // rejected despite Rice already anchoring the meal — so this only
        // fires when every main-tagged item in the meal is liquid, not the
        // moment any one of them is. The authored Consistency column is
        // authoritative when present; the Category bucket is only a
        // FALLBACK for the ~11% of recipes with no Consistency value, never
        // allowed to override an explicit "solid" — recipeCategoryBucket()'s
        // "beverage" bucket substring-matches "cereal" (for things like corn
        // flakes) and was catching genuinely solid Category="Cereal" dishes
        // (Oats Toast, Tomato Basil Bruschetta) as false positives before
        // that guard, also confirmed on a real live-generation run. Skipped
        // for snack-only occasions, where a chai-as-main is the normal,
        // expected thing (same slots as NO_MAIN_REQUIRED_SLOTS).
        const isLiquid = item.recipe.consistency === "liquid" || (item.recipe.consistency === null && LIQUID_MAIN_BUCKETS.has(bucket))
        if (isLiquid) liquidMainItemNames.push(item.recipe.name)
        else hasSolidMain = true
      }
      if (RICH_BUCKETS_NOT_STACKED.has(bucket)) richCount++

      // Defense-in-depth: the prompt pool was already pre-filtered by these
      // constraints, but a fuzzy-tier resolution could in principle land on
      // an ineligible recipe — this is the last checkpoint before pricing.
      if (!isRecipeAllowedForDiet(item.recipe, constraints.dietType)) {
        problems.push(`${meal.slot}'s "${item.recipe.name}" is not eligible for diet type "${constraints.dietType}"`)
      }
      if (!constraints.eligibleCuisines.includes(item.recipe.cuisine)) {
        problems.push(`${meal.slot}'s "${item.recipe.name}" is not eligible for the requested cuisine`)
      }
      const forbiddenAllergen = item.recipe.allergenTags.find((t) => constraints.allergenTags.includes(t))
      if (forbiddenAllergen) {
        problems.push(`${meal.slot}'s "${item.recipe.name}" contains a declared allergen: ${forbiddenAllergen}`)
      }
    }

    if (!hasMain && !NO_MAIN_REQUIRED_SLOTS.has(meal.slot)) problems.push(`${meal.slot} has no MAIN item (all accompaniments)`)
    if (richCount > 1) problems.push(`${meal.slot} stacks ${richCount} rich (heavy meal/dessert) dishes together`)
    if (liquidMainItemNames.length > 0 && !hasSolidMain && !NO_MAIN_REQUIRED_SLOTS.has(meal.slot)) {
      problems.push(`${meal.slot}'s main dish(es) (${liquidMainItemNames.join(", ")}) are liquid (soup/tea/beverage) and cannot anchor a full meal — pick a solid dish as the main instead`)
    }

    // A real lunch/dinner needs a staple + a dal/curry, not just any two
    // plausible-looking picks — this is what stops "Tomato Soup" or
    // "Herbal Belly Tea" from ever being the whole of a main meal. A
    // self-contained dish (Biryani-as-heavy-meal, a Thali-style row,
    // Khichdi, Kadhi-with-rice) satisfies this on its own, since it's
    // already a complete meal by construction.
    if (STRUCTURED_MEAL_SLOTS.has(meal.slot)) {
      if (!hasSelfContainedDish) {
        if (!itemBuckets.some((b) => STAPLE_BUCKETS.has(b))) {
          problems.push(`${meal.slot} is missing a staple dish (Roti/Paratha/Bread or Rice/Pulao/Biryani) — a real ${meal.slot} needs one`)
        }
        if (!itemBuckets.includes(DAL_BUCKET) && !hasRealAnimalProtein) {
          problems.push(`${meal.slot} is missing a Dal/Curry dish — a real ${meal.slot} needs one`)
        }
      } else if (itemBuckets.some((b) => STAPLE_BUCKETS.has(b))) {
        // The opposite mistake — a REDUNDANT staple bolted onto a dish
        // that's already the staple+dal course. Direct dietitian
        // correction on a hand-built plan: "no one eats ajwain paratha
        // with khichdi and tofu chilla" / "no one eats paneer paratha
        // with this kuttu kadhi" — real thalis don't double up on the
        // carb-and-dal course, they add a side (sabzi/salad/raita), not
        // another roti or rice.
        problems.push(`${meal.slot} pairs an already-complete dish with a separate staple (roti/rice) — real ${meal.slot}s don't serve these together; add a side instead, not another staple`)
      }

      // Meat/fish/egg is its own protein-and-side course — never paired
      // with a SEPARATE cooked Sabzi or Dal/Curry dish in the same meal (a
      // direct dietitian correction: "we cant give chicken like things meat
      // with any sabzi and dal ... give a salad instead, or optimize the
      // quantity"). Salad bucket is untouched — a salad alongside meat is
      // completely normal. hasConflictingVegSideDish only counts a
      // genuinely distinct, non-animal-protein item — a real curry-style
      // chicken dish (e.g. "Chicken Curry", itself bucketed dal_curry via
      // the curry-name reclassification) never conflicts with itself.
      if (hasRealAnimalProtein && hasConflictingVegSideDish) {
        problems.push(
          `${meal.slot} pairs a real non-veg/egg dish with a Sabzi/Dal — a non-veg meal is its own protein-and-side course, not an addition to a cooked vegetable curry or dal; use a Salad instead, or just size up the protein/staple portions`
        )
      }
    }

    // Dietitian-authored "must have" pairing (recipes.mustHaveCategories/
    // mustHaveRecipeNames — see recipe-pairing.ts) — a real hard requirement
    // from the source data (e.g. Dahi Tadka MUST have a Pulao/Khichdi/
    // Biryani alongside it), not a fabricated rule. Only recipes that
    // declare one are affected; most items are untouched. "Good to have" is
    // never enforced — it's prompt guidance only (see recipe-prompt.ts).
    for (let i = 0; i < meal.items.length; i++) {
      const item = meal.items[i]
      if (item.recipe.mustHaveCategories.length === 0 && item.recipe.mustHaveRecipeNames.length === 0) continue
      const siblingCategories = meal.items.filter((_, j) => j !== i).map((s) => s.recipe.category)
      const siblingNames = meal.items.filter((_, j) => j !== i).map((s) => s.recipe.name)
      if (!isMustHaveSatisfied(item.recipe, siblingCategories, siblingNames)) {
        // A real animal-protein dish already fills the "needs a Sabzi/Dal/
        // Curry accompaniment" role a staple's own must-have list wants —
        // and the check above now ACTIVELY EXCLUDES a real sabzi/dal from a
        // meat meal anyway, so without this exemption that requirement
        // could never be satisfiable in a non-veg meal at all.
        const onlyWantsProteinCourse =
          item.recipe.mustHaveRecipeNames.length === 0 &&
          item.recipe.mustHaveCategories.length > 0 &&
          item.recipe.mustHaveCategories.every((c) => MEAT_SATISFIES_MARKERS.has(c.toLowerCase()))
        if (hasRealAnimalProtein && onlyWantsProteinCourse) continue
        const needs = [...item.recipe.mustHaveCategories, ...item.recipe.mustHaveRecipeNames].join(" / ")
        problems.push(`${meal.slot}'s "${item.recipe.name}" needs one of [${needs}] alongside it, but none is present`)
      }
    }
  }

  return problems
}
