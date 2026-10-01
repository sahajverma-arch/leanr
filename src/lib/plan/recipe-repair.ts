/**
 * Deterministic macro repair — the stage between "the model named some
 * dishes" and "the day is judged against the client's target".
 *
 * WHY THIS EXISTS, measured rather than reasoned. Across all 12 real saved
 * recipe-engine plans (84 days), 63 of those days had at least one macro
 * target sitting OUTSIDE the range the chosen dish set can physically
 * reach — `recipe-balancer.ts` only scales grams inside each recipe's
 * authored [minGrams, maxGrams], so once the model has named the dishes the
 * deviation is already decided. Re-solving those same dish sets with a
 * provably-optimal minimax solver still left 36-47% worst-macro deviation
 * on the worst three plans: the gram optimizer was never the binding
 * constraint, dish SELECTION was. That is the gap this file closes.
 *
 * WHY NOT MORE SAMPLING. The error is bias, not variance: weekly-average
 * protein came back HIGH on 11 of those 12 plans (+4.7% to +132%). N
 * independent samples of one skewed distribution are N skewed samples, so
 * raising RECIPE_BEST_OF_N buys nothing here — it is the wrong lever, and an
 * expensive one.
 *
 * THE MOVE SET IS DELIBERATELY MINIMAL: replace one dish with another dish
 * from the SAME category bucket (a sabzi for a sabzi, a roti for a roti).
 * The plate keeps its shape, its dish count and its meal structure by
 * construction — only the dish's identity moves, and its grams are then
 * re-solved by the SAME balanceDayToTargets() every other path uses.
 * Allowing the repair to ADD or DROP dishes as well was implemented and
 * measured against the same 12 plans: no better, sometimes worse, and
 * slower. So it is not here.
 *
 * THE ONE RULE IS UNTOUCHED. No model is involved in a repair at any point.
 * Every candidate is a real row from the same eligible pool the model chose
 * from, every gram still comes out of the one balancer, and the acceptance
 * test is arithmetic on verified per-100g data.
 */

import { isAnimalProteinRecipe } from "@/lib/foods/recipe-animal-content"

import { recipeDayRuleViolation } from "./day-food-rules"
import { balanceDayToTargets } from "./recipe-balancer"
import { recipeCategoryBucket, type RecipeCategoryBucket } from "./recipe-category"
import { MAX_SABZI_PER_MEAL, STRUCTURED_MEAL_SLOTS } from "./recipe-meal-structure"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import type { DailyRecipeTarget, GroundedRecipeDay, GroundedRecipeItem, RecipeAchievedMacros, RecipeForPipeline } from "./recipe-types"
import { RECIPE_MACRO_TOLERANCE } from "./recipe-validate"
import { isEverydayStaple, repeatCapFor } from "./recipe-variety-tracker"

/**
 * The macros the repair steers on — the same four recipe-validate.ts gates
 * on, fiber deliberately excluded for the same soft-target reason. Repairing
 * toward a macro nothing rejects for would trade a gated miss for an
 * ungated one.
 */
const GATED_MACROS = ["kcal", "proteinG", "carbsG", "fatG"] as const
type GatedMacro = (typeof GATED_MACROS)[number]

type MacroTotals = Record<GatedMacro, number>

/**
 * Stop once a day is comfortably inside RECIPE_MACRO_TOLERANCE (0.08)
 * rather than grinding toward zero. Deliberately not equal to the tolerance:
 * a day parked exactly on the gate is one rounding step from failing it, and
 * every further swap spends another slice of the model's own composition for
 * a number nobody reads.
 */
export const REPAIR_TARGET_DEVIATION = 0.04

/**
 * At most this many swaps per day. A day converged in 2-5 swaps on every
 * real plan measured; the cap is what stops a pathological day (an
 * unreachable target — see the reachability note in CLAUDE.md) from
 * rewriting every dish the model chose in pursuit of a number it can never
 * hit.
 */
const MAX_SWAPS_PER_DAY = 6

/**
 * How many candidates get a full balance-and-validate per round. Candidates
 * are ranked first by a cheap exact one-dimensional estimate (see
 * bestAchievableWorst), so this is a budget on the expensive step, not a
 * blunt truncation of the search.
 */
const MAX_FULL_EVALUATIONS_PER_ROUND = 45

/** An improvement smaller than this (0.01 of a percentage point) is noise, not progress. */
const MIN_IMPROVEMENT = 1e-4

export interface RepairSwap {
  dayIndex: number
  slot: string
  from: string
  to: string
}

export interface RepairPool {
  byBucket: Map<RecipeCategoryBucket, RecipeForPipeline[]>
  /**
   * The client's OWN-cuisine dishes (e.g. every Gujarati recipe), bucketed
   * the same way. Empty for a "General" client, or a cuisine with no native
   * recipes — then the regional pass is a no-op.
   */
  regionalByBucket: Map<RecipeCategoryBucket, RecipeForPipeline[]>
  /**
   * The same pool keyed by varietyFamily() — what the variety pass swaps
   * within. Narrower than a bucket on purpose: "bread" holds roti AND
   * sandwiches, "dal_curry" holds rajma AND oats porridge, so a bucket-level
   * swap could turn a lunch roti into a sandwich.
   */
  byFamily: Map<string, RecipeForPipeline[]>
}

/**
 * Which dishes can stand in for each other when a plate is changed purely
 * for variety: the same raw CSV Category and the same Main/Mid role, with
 * "Dal" and "Curry" treated as one family (Arhar Dal for Rajma Curry is
 * exactly the swap a dietitian would make). Real categories, checked against
 * the North Indian vegetarian pool: Roti 17, Rice 4, Dal 9, Curry 9,
 * Paratha 35, Chila 23, Sabzi 32, High Protein Sabzi 14, Chaat 24...
 */
export function varietyFamily(recipe: Pick<RecipeForPipeline, "category" | "mainOrMid">): string {
  const category = recipe.category.trim().toLowerCase()
  return `${category === "dal" ? "curry" : category}|${recipe.mainOrMid}`
}

/**
 * Buckets the eligible pool once per generation. Built from
 * RecipeSelectorInput.allRecipesById — the identical pool the model was
 * offered, so a repair can never introduce a dish the client was not
 * already eligible for (diet type, cuisine, season, allergens and the
 * zero-kcal filter are all applied upstream of it).
 *
 * Each bucket is sorted by id so the candidate order — and therefore the
 * repaired week — is deterministic for a fixed input.
 */
export function buildRepairPool(pool: Iterable<RecipeForPipeline>, clientCuisine?: string): RepairPool {
  const byBucket = new Map<RecipeCategoryBucket, RecipeForPipeline[]>()
  const byFamily = new Map<string, RecipeForPipeline[]>()
  const regionalByBucket = new Map<RecipeCategoryBucket, RecipeForPipeline[]>()
  const regional = clientCuisine && clientCuisine !== "General" ? clientCuisine : null
  for (const recipe of pool) {
    const bucket = recipeCategoryBucket(recipe.category, recipe.name)
    const existing = byBucket.get(bucket)
    if (existing) existing.push(recipe)
    else byBucket.set(bucket, [recipe])
    const family = varietyFamily(recipe)
    const familyList = byFamily.get(family)
    if (familyList) familyList.push(recipe)
    else byFamily.set(family, [recipe])
    if (regional && recipe.cuisine === regional) {
      const own = regionalByBucket.get(bucket)
      if (own) own.push(recipe)
      else regionalByBucket.set(bucket, [recipe])
    }
  }
  const byId = (a: RecipeForPipeline, b: RecipeForPipeline) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const recipes of byBucket.values()) recipes.sort(byId)
  for (const recipes of regionalByBucket.values()) recipes.sort(byId)
  for (const recipes of byFamily.values()) recipes.sort(byId)
  return { byBucket, regionalByBucket, byFamily }
}

/**
 * Whether a recipe may go onto this day under the client's weekday food rule
 * ("no non-veg or eggs on Monday"). Every swap pass filters its candidates
 * with this — NOT only through the plausibility-problem count, because a
 * swap that fixes one problem while breaking the weekday rule leaves that
 * count unchanged and would be accepted. Measured: a real Monday got
 * "Coriander Chutney -> Fish Tikka" exactly that way before this filter.
 */
function allowedOnDay(constraints: ClientRecipeConstraints, dayIndex: number): (recipe: RecipeForPipeline) => boolean {
  const restriction = constraints.dayRestrictions?.get(dayIndex)
  if (!restriction) return () => true
  return (recipe) => recipeDayRuleViolation(recipe, restriction.avoids, restriction.weekday) === null
}

function regionalRecipeIds(pool: RepairPool): Set<string> {
  return new Set([...pool.regionalByBucket.values()].flat().map((r) => r.id))
}

/** Worst single-macro deviation as a fraction, directly comparable to RECIPE_MACRO_TOLERANCE. */
export function worstRelativeDeviation(totals: RecipeAchievedMacros, target: DailyRecipeTarget): number {
  return Math.max(
    ...GATED_MACROS.map((key) => {
      if (target[key] === 0) return totals[key] === 0 ? 0 : 1
      return Math.abs(totals[key] - target[key]) / target[key]
    })
  )
}

function contributionOf(item: GroundedRecipeItem): MacroTotals {
  const factor = item.grams / 100
  return {
    kcal: item.recipe.kcalPer100G * factor,
    proteinG: item.recipe.proteinPer100G * factor,
    carbsG: item.recipe.carbsPer100G * factor,
    fatG: item.recipe.fatPer100G * factor,
  }
}

function perGram(recipe: RecipeForPipeline): MacroTotals {
  return {
    kcal: recipe.kcalPer100G / 100,
    proteinG: recipe.proteinPer100G / 100,
    carbsG: recipe.carbsPer100G / 100,
    fatG: recipe.fatPer100G / 100,
  }
}

/**
 * The cheap ranking signal: holding every OTHER dish at the grams the
 * balancer just gave it, what is the best worst-macro deviation this
 * candidate could reach at any legal serving of its own?
 *
 * That one-dimensional question has an exact answer over a handful of
 * candidate gram values — each range end, plus the grams that would land
 * each macro exactly on target — because worst-deviation is piecewise
 * linear in a single item's grams and its minimum therefore sits at one of
 * those breakpoints or a range end. It is a lower bound on what the full
 * re-balance will find (the other dishes also move), which is exactly what a
 * ranking heuristic should be: optimistic and cheap.
 */
function bestAchievableWorst(othersTotals: MacroTotals, candidate: RecipeForPipeline, target: DailyRecipeTarget): number {
  const rate = perGram(candidate)
  const options = new Set<number>([candidate.minGrams, candidate.maxGrams, candidate.idealGrams])
  for (const key of GATED_MACROS) {
    if (rate[key] > 1e-9) {
      const exact = (target[key] - othersTotals[key]) / rate[key]
      options.add(Math.min(Math.max(exact, candidate.minGrams), candidate.maxGrams))
    }
  }
  let best = Number.POSITIVE_INFINITY
  for (const grams of options) {
    let worst = 0
    for (const key of GATED_MACROS) {
      const achieved = othersTotals[key] + rate[key] * grams
      const deviation = target[key] === 0 ? (achieved === 0 ? 0 : 1) : Math.abs(achieved - target[key]) / target[key]
      if (deviation > worst) worst = deviation
    }
    if (worst < best) best = worst
  }
  return best
}

function replaceItem(day: GroundedRecipeDay, mealIndex: number, itemIndex: number, recipe: RecipeForPipeline): GroundedRecipeDay {
  return {
    ...day,
    meals: day.meals.map((meal, mi) =>
      mi === mealIndex
        ? { ...meal, items: meal.items.map((item, ii) => (ii === itemIndex ? { recipe, grams: recipe.idealGrams } : item)) }
        : meal
    ),
  }
}

/**
 * Repair one day, given how many times each recipe is already used across
 * the whole week.
 *
 * `weeklyCounts` is MUTATED as swaps are accepted, so a later day's repair
 * sees what an earlier day's repair already spent. That is the point: the
 * variety cap is a week-level fact, and a per-day repair blind to it would
 * happily plate the same rescue dish seven times.
 *
 * A day carrying a hand-locked quantity is returned untouched. Repair only
 * ever runs during generation, which never sets that flag, so this is a
 * guard against a future caller rather than a live case — but a repair that
 * silently re-plans a day around a dietitian's pinned dish would be the
 * worst possible surprise.
 */
export function repairDay(
  day: GroundedRecipeDay,
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints,
  weeklyCounts: Map<string, number>
): { day: GroundedRecipeDay; swaps: RepairSwap[] } {
  // Weekday food rules first, and not macro-gated: a hard rule like an
  // allergy. Every later swap below checks it again through
  // describePlausibilityProblems(), so none can put the dish back.
  const ruled = enforceDayRules(day, target, pool, constraints, weeklyCounts)
  const swaps: RepairSwap[] = [...ruled.swaps]
  if (ruled.day.meals.some((meal) => meal.items.some((item) => item.gramsLocked))) return { day: ruled.day, swaps }

  let current = ruled.day
  let currentScore = worstRelativeDeviation(current.totals, target)
  const regionalIds = regionalRecipeIds(pool)
  const allowedToday = allowedOnDay(constraints, day.dayIndex)

  for (let round = 0; round < MAX_SWAPS_PER_DAY; round++) {
    if (currentScore <= REPAIR_TARGET_DEVIATION) break

    // The model's own day may already carry plausibility problems —
    // best-of-N gates on the weekly average, not on plausibility, so saved
    // weeks routinely do. Requiring a candidate to be problem-FREE would
    // therefore reject every candidate on exactly the days most in need of
    // repair, and the stage would silently no-op. The rule is "no worse
    // than what the model produced", which is the honest one.
    const baselineProblems = describePlausibilityProblems(current, constraints).length

    const dayTotals: MacroTotals = {
      kcal: current.totals.kcal,
      proteinG: current.totals.proteinG,
      carbsG: current.totals.carbsG,
      fatG: current.totals.fatG,
    }

    interface Candidate {
      mealIndex: number
      itemIndex: number
      recipe: RecipeForPipeline
      estimate: number
    }
    const candidates: Candidate[] = []

    current.meals.forEach((meal, mealIndex) => {
      const namesInMeal = new Set(meal.items.map((item) => item.recipe.name))
      meal.items.forEach((item, itemIndex) => {
        const bucket = recipeCategoryBucket(item.recipe.category, item.recipe.name)
        // A dish from the client's own cuisine may only be replaced by
        // another from that cuisine. Measured on a real Gujarati week: the
        // model chose Methi Thepla, Lauki Dhokla, Khakhra and khichdi, and
        // this repair — chasing protein alone — swapped them for Oats
        // Chilla, Paneer Puff and Chia Porridge, leaving a day with no
        // Gujarati dish at all. Macros are still repaired freely through
        // every other dish on the day.
        const alternatives = regionalIds.has(item.recipe.id) ? pool.regionalByBucket.get(bucket) : pool.byBucket.get(bucket)
        if (!alternatives) return

        const own = contributionOf(item)
        const othersTotals: MacroTotals = {
          kcal: dayTotals.kcal - own.kcal,
          proteinG: dayTotals.proteinG - own.proteinG,
          carbsG: dayTotals.carbsG - own.carbsG,
          fatG: dayTotals.fatG - own.fatG,
        }

        for (const recipe of alternatives) {
          if (recipe.id === item.recipe.id) continue
          if (!allowedToday(recipe)) continue
          // A duplicate recipe inside one meal is a plausibility problem in
          // its own right — keep it out of the picker rather than offering
          // it and then rejecting it downstream.
          if (namesInMeal.has(recipe.name)) continue
          // Never push a recipe past the week's repeat cap. Swapping one
          // OUT only ever lowers its count, so this one check is enough to
          // guarantee repair introduces no new variety violation — while
          // leaving any the model already created alone rather than
          // refusing to repair the day at all.
          if ((weeklyCounts.get(recipe.name) ?? 0) >= repeatCapFor(recipe)) continue
          candidates.push({ mealIndex, itemIndex, recipe, estimate: bestAchievableWorst(othersTotals, recipe, target) })
        }
      })
    })

    candidates.sort((a, b) => a.estimate - b.estimate || (a.recipe.id < b.recipe.id ? -1 : 1))

    let best: { day: GroundedRecipeDay; score: number; swap: RepairSwap } | null = null
    for (const candidate of candidates.slice(0, MAX_FULL_EVALUATIONS_PER_ROUND)) {
      // No point evaluating a candidate whose own optimistic bound cannot
      // beat what we already have.
      if (candidate.estimate >= currentScore - MIN_IMPROVEMENT) continue

      const rebalanced = balanceDayToTargets(
        replaceItem(current, candidate.mealIndex, candidate.itemIndex, candidate.recipe),
        target
      )
      if (describePlausibilityProblems(rebalanced, constraints).length > baselineProblems) continue

      const score = worstRelativeDeviation(rebalanced.totals, target)
      if (score >= currentScore - MIN_IMPROVEMENT) continue
      if (best === null || score < best.score) {
        best = {
          day: rebalanced,
          score,
          swap: {
            dayIndex: current.dayIndex,
            slot: current.meals[candidate.mealIndex].slot,
            from: current.meals[candidate.mealIndex].items[candidate.itemIndex].recipe.name,
            to: candidate.recipe.name,
          },
        }
      }
    }

    if (best === null) break

    weeklyCounts.set(best.swap.from, Math.max(0, (weeklyCounts.get(best.swap.from) ?? 1) - 1))
    weeklyCounts.set(best.swap.to, (weeklyCounts.get(best.swap.to) ?? 0) + 1)
    swaps.push(best.swap)
    current = best.day
    currentScore = best.score
  }

  const regional = ensureRegionalDish(current, target, pool, constraints, weeklyCounts)
  return { day: regional.day, swaps: [...swaps, ...regional.swaps] }
}

/**
 * Every day should carry at least this many dishes from the client's own
 * cuisine. One, not more: the dataset's regional recipes are mostly
 * breakfast/evening dishes (every Gujarati recipe is a thepla or farsan),
 * so a higher floor would force the same handful onto the plate every day.
 */
export const MIN_REGIONAL_DISHES_PER_DAY = 1

/**
 * A regional swap may move a day's worst macro up to here, but never make a
 * day that is already worse than this any worse. Below RECIPE_MACRO_TOLERANCE
 * on purpose: a client's cuisine is worth a little macro slack, not a day
 * parked on the edge of the gate.
 */
export const REGIONAL_DEVIATION_CEILING = RECIPE_MACRO_TOLERANCE * 0.75

/**
 * WHY THIS EXISTS. A Gujarati client (Dhruti, 2026-09-23) got a week of Tofu
 * Chilli, Guacamole and Shirataki rice with 3 Gujarati dishes out of 72 — the
 * model is shown ~1000 dishes, 19 of them Gujarati, and nothing held it to
 * the cuisine. The prompt now asks for a regional dish every day; this
 * guarantees it in code, because a prompt rule alone is not a guarantee.
 *
 * Same move set and safety rules as the macro repair above — swap one dish
 * for an own-cuisine dish of the SAME category bucket (a chilla for a
 * thepla, a chaat for a dhokla), re-balance, never add a plausibility
 * problem, never breach the weekly repeat cap — plus a macro rule: the swap
 * must leave the day's worst macro within REGIONAL_DEVIATION_CEILING, or no
 * worse than it already was. So a day only goes without a regional dish
 * when no swap can keep it on target.
 */
function ensureRegionalDish(
  day: GroundedRecipeDay,
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints,
  weeklyCounts: Map<string, number>
): { day: GroundedRecipeDay; swaps: RepairSwap[] } {
  const swaps: RepairSwap[] = []
  if (pool.regionalByBucket.size === 0) return { day, swaps }
  if (day.meals.some((meal) => meal.items.some((item) => item.gramsLocked))) return { day, swaps }

  const regionalIds = regionalRecipeIds(pool)
  const allowedToday = allowedOnDay(constraints, day.dayIndex)
  const regionalCount = (d: GroundedRecipeDay) =>
    d.meals.reduce((n, meal) => n + meal.items.filter((item) => regionalIds.has(item.recipe.id)).length, 0)

  let current = day
  while (regionalCount(current) < MIN_REGIONAL_DISHES_PER_DAY) {
    const allowed = Math.max(worstRelativeDeviation(current.totals, target), REGIONAL_DEVIATION_CEILING)
    const baselineProblems = describePlausibilityProblems(current, constraints).length
    const dayTotals: MacroTotals = {
      kcal: current.totals.kcal,
      proteinG: current.totals.proteinG,
      carbsG: current.totals.carbsG,
      fatG: current.totals.fatG,
    }

    const candidates: { mealIndex: number; itemIndex: number; recipe: RecipeForPipeline; estimate: number }[] = []
    current.meals.forEach((meal, mealIndex) => {
      const namesInMeal = new Set(meal.items.map((item) => item.recipe.name))
      meal.items.forEach((item, itemIndex) => {
        const alternatives = pool.regionalByBucket.get(recipeCategoryBucket(item.recipe.category, item.recipe.name))
        if (!alternatives) return
        const own = contributionOf(item)
        const othersTotals: MacroTotals = {
          kcal: dayTotals.kcal - own.kcal,
          proteinG: dayTotals.proteinG - own.proteinG,
          carbsG: dayTotals.carbsG - own.carbsG,
          fatG: dayTotals.fatG - own.fatG,
        }
        for (const recipe of alternatives) {
          if (namesInMeal.has(recipe.name) || !allowedToday(recipe)) continue
          if ((weeklyCounts.get(recipe.name) ?? 0) >= repeatCapFor(recipe)) continue
          candidates.push({ mealIndex, itemIndex, recipe, estimate: bestAchievableWorst(othersTotals, recipe, target) })
        }
      })
    })
    // Least-used first among equals, so the week spreads across the region's
    // dishes instead of leaning on one.
    candidates.sort(
      (a, b) =>
        a.estimate - b.estimate ||
        (weeklyCounts.get(a.recipe.name) ?? 0) - (weeklyCounts.get(b.recipe.name) ?? 0) ||
        (a.recipe.id < b.recipe.id ? -1 : 1)
    )

    let best: { day: GroundedRecipeDay; score: number; swap: RepairSwap } | null = null
    for (const candidate of candidates.slice(0, MAX_FULL_EVALUATIONS_PER_ROUND)) {
      if (candidate.estimate > allowed) continue
      const rebalanced = balanceDayToTargets(replaceItem(current, candidate.mealIndex, candidate.itemIndex, candidate.recipe), target)
      if (describePlausibilityProblems(rebalanced, constraints).length > baselineProblems) continue
      const score = worstRelativeDeviation(rebalanced.totals, target)
      if (score > allowed) continue
      if (best === null || score < best.score) {
        best = {
          day: rebalanced,
          score,
          swap: {
            dayIndex: current.dayIndex,
            slot: current.meals[candidate.mealIndex].slot,
            from: current.meals[candidate.mealIndex].items[candidate.itemIndex].recipe.name,
            to: candidate.recipe.name,
          },
        }
      }
    }
    if (best === null) break

    weeklyCounts.set(best.swap.from, Math.max(0, (weeklyCounts.get(best.swap.from) ?? 1) - 1))
    weeklyCounts.set(best.swap.to, (weeklyCounts.get(best.swap.to) ?? 0) + 1)
    swaps.push(best.swap)
    current = best.day
  }

  return { day: current, swaps }
}

/**
 * One sabzi per lunch/dinner, never two (dietitian rule: "one sabzi, one
 * dal"). Measured on the saved plans: 7 of 420 lunches/dinners carried two,
 * nearly always a paneer/tofu "High Protein Sabzi" beside a plain one, each
 * then squeezed to a small portion to fit the day.
 *
 * For each extra sabzi, whichever of two moves leaves the day's worst macro
 * lowest after re-balancing: if the meal has no dal/curry yet, turn the sabzi
 * INTO a dal/curry (the meal needs one anyway); otherwise drop it. The other
 * dishes, rice and roti included, are re-balanced and absorb its calories.
 * Mandatory, not macro-gated: plate shape is not traded for a macro point,
 * and the macro repair that follows brings the day back on target.
 */
export function enforceSingleSabzi(
  day: GroundedRecipeDay,
  target: DailyRecipeTarget,
  pool: RepairPool,
  weeklyCounts: Map<string, number>
): { day: GroundedRecipeDay; swaps: RepairSwap[] } {
  const swaps: RepairSwap[] = []
  if (day.meals.some((meal) => meal.items.some((item) => item.gramsLocked))) return { day, swaps }
  const dalOptions = (pool.byBucket.get("dal_curry") ?? []).filter(isPlainDalOrCurry)

  let current = day
  for (let mealIndex = 0; mealIndex < current.meals.length; mealIndex++) {
    while (STRUCTURED_MEAL_SLOTS.has(current.meals[mealIndex].slot) && sabziIndexes(current.meals[mealIndex]).length > MAX_SABZI_PER_MEAL) {
      const meal = current.meals[mealIndex]
      const hasDal = meal.items.some((item) => recipeCategoryBucket(item.recipe.category, item.recipe.name) === "dal_curry")
      const namesInMeal = new Set(meal.items.map((item) => item.recipe.name))
      const options: { next: GroundedRecipeDay; swap: RepairSwap }[] = []
      for (const itemIndex of sabziIndexes(meal)) {
        const from = meal.items[itemIndex].recipe.name
        if (!hasDal) {
          for (const recipe of dalOptions) {
            if (namesInMeal.has(recipe.name) || (weeklyCounts.get(recipe.name) ?? 0) >= repeatCapFor(recipe)) continue
            options.push({ next: replaceItem(current, mealIndex, itemIndex, recipe), swap: { dayIndex: current.dayIndex, slot: meal.slot, from, to: recipe.name } })
          }
        }
        options.push({ next: removeItem(current, mealIndex, itemIndex), swap: { dayIndex: current.dayIndex, slot: meal.slot, from, to: REMOVED_EXTRA_SABZI } })
      }

      let best: { day: GroundedRecipeDay; score: number; swap: RepairSwap } | null = null
      for (const option of options) {
        const rebalanced = balanceDayToTargets(option.next, target)
        const score = worstRelativeDeviation(rebalanced.totals, target)
        if (best === null || score < best.score) best = { day: rebalanced, score, swap: option.swap }
      }
      if (best === null) break

      weeklyCounts.set(best.swap.from, Math.max(0, (weeklyCounts.get(best.swap.from) ?? 1) - 1))
      if (best.swap.to !== REMOVED_EXTRA_SABZI) weeklyCounts.set(best.swap.to, (weeklyCounts.get(best.swap.to) ?? 0) + 1)
      swaps.push(best.swap)
      current = best.day
    }
  }
  return { day: current, swaps }
}

/** RepairSwap.to for a dish taken off a restricted day because nothing allowed could replace it. */
export const REMOVED_FOR_DAY_RULE = "(removed: weekday food rule)"

/**
 * Takes every dish that breaks this day's weekday rule ("no non-veg or eggs
 * on Monday" — day-food-rules.ts) off the plate.
 *
 * WHY HERE. The pool the model chooses from is one pool for the whole week,
 * so a non-vegetarian client's Monday is offered chicken like every other
 * day. The prompt names the restricted days, but a prompt rule is not a
 * guarantee; this is. It runs inside repairDay(), which both generation
 * paths (best-of-N and the per-day retry) go through.
 *
 * Each offending dish is replaced by an allowed dish of the same
 * varietyFamily() if one exists (an egg breakfast for a veg breakfast of the
 * same kind), else of the same category bucket, choosing the fewest
 * plausibility problems and then the best macro fit after re-balancing.
 * If nothing allowed exists, the dish is removed and the day re-balanced.
 * Mandatory: unlike a variety swap, it is never refused for costing macros.
 */
export function enforceDayRules(
  day: GroundedRecipeDay,
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints,
  weeklyCounts: Map<string, number>
): { day: GroundedRecipeDay; swaps: RepairSwap[] } {
  const swaps: RepairSwap[] = []
  const restriction = constraints.dayRestrictions?.get(day.dayIndex)
  if (!restriction) return { day, swaps }
  const allowedToday = allowedOnDay(constraints, day.dayIndex)

  let current = day
  // Each pass removes one offending dish, so this ends; the bound is a guard.
  for (let pass = 0; pass < 50; pass++) {
    let at: { mealIndex: number; itemIndex: number } | null = null
    for (let mealIndex = 0; mealIndex < current.meals.length && !at; mealIndex++) {
      const itemIndex = current.meals[mealIndex].items.findIndex((item) => !allowedToday(item.recipe))
      if (itemIndex >= 0) at = { mealIndex, itemIndex }
    }
    if (!at) break

    const meal = current.meals[at.mealIndex]
    const item = meal.items[at.itemIndex]
    const namesInMeal = new Set(meal.items.map((i) => i.recipe.name))
    const own = contributionOf(item)
    const othersTotals: MacroTotals = {
      kcal: current.totals.kcal - own.kcal,
      proteinG: current.totals.proteinG - own.proteinG,
      carbsG: current.totals.carbsG - own.carbsG,
      fatG: current.totals.fatG - own.fatG,
    }

    const seen = new Set<string>()
    const candidates: { recipe: RecipeForPipeline; sameFamily: boolean; estimate: number }[] = []
    const sources: [RecipeForPipeline[], boolean][] = [
      [pool.byFamily.get(varietyFamily(item.recipe)) ?? [], true],
      [pool.byBucket.get(recipeCategoryBucket(item.recipe.category, item.recipe.name)) ?? [], false],
    ]
    for (const [list, sameFamily] of sources) {
      for (const recipe of list) {
        if (seen.has(recipe.id)) continue
        seen.add(recipe.id)
        if (!allowedToday(recipe) || namesInMeal.has(recipe.name)) continue
        if ((weeklyCounts.get(recipe.name) ?? 0) >= repeatCapFor(recipe)) continue
        candidates.push({ recipe, sameFamily, estimate: bestAchievableWorst(othersTotals, recipe, target) })
      }
    }
    candidates.sort((a, b) => Number(b.sameFamily) - Number(a.sameFamily) || a.estimate - b.estimate || (a.recipe.id < b.recipe.id ? -1 : 1))

    let best: { day: GroundedRecipeDay; problems: number; sameFamily: boolean; score: number; to: string } | null = null
    for (const candidate of candidates.slice(0, MAX_FULL_EVALUATIONS_PER_ROUND)) {
      const rebalanced = balanceDayToTargets(replaceItem(current, at.mealIndex, at.itemIndex, candidate.recipe), target)
      const problems = describePlausibilityProblems(rebalanced, constraints).length
      const score = worstRelativeDeviation(rebalanced.totals, target)
      const better =
        best === null ||
        problems < best.problems ||
        (problems === best.problems && candidate.sameFamily && !best.sameFamily) ||
        (problems === best.problems && candidate.sameFamily === best.sameFamily && score < best.score)
      if (better) best = { day: rebalanced, problems, sameFamily: candidate.sameFamily, score, to: candidate.recipe.name }
    }
    if (best === null) {
      best = {
        day: balanceDayToTargets(removeItem(current, at.mealIndex, at.itemIndex), target),
        problems: 0,
        sameFamily: false,
        score: 0,
        to: REMOVED_FOR_DAY_RULE,
      }
    }

    weeklyCounts.set(item.recipe.name, Math.max(0, (weeklyCounts.get(item.recipe.name) ?? 1) - 1))
    if (best.to !== REMOVED_FOR_DAY_RULE) weeklyCounts.set(best.to, (weeklyCounts.get(best.to) ?? 0) + 1)
    swaps.push({ dayIndex: current.dayIndex, slot: meal.slot, from: item.recipe.name, to: best.to })
    current = best.day
  }
  return { day: current, swaps }
}

/** RepairSwap.to for a sabzi taken off the plate rather than replaced. */
export const REMOVED_EXTRA_SABZI = "(removed: one sabzi per meal)"

function sabziIndexes(meal: GroundedRecipeDay["meals"][number]): number[] {
  return meal.items.flatMap((item, i) => (recipeCategoryBucket(item.recipe.category, item.recipe.name) === "sabzi" ? [i] : []))
}

/**
 * A dal or a vegetarian curry (Arhar Dal, Rajma Curry): not a porridge or a
 * khichdi, which share the dal_curry bucket, and not a meat curry, which may
 * not sit beside a sabzi at all.
 */
function isPlainDalOrCurry(recipe: RecipeForPipeline): boolean {
  if (isAnimalProteinRecipe(recipe)) return false
  const category = recipe.category.trim().toLowerCase()
  return category === "dal" || category === "curry" || (category.includes("sabzi") && /curry/i.test(recipe.name))
}

function removeItem(day: GroundedRecipeDay, mealIndex: number, itemIndex: number): GroundedRecipeDay {
  return {
    ...day,
    meals: day.meals.map((meal, mi) => (mi === mealIndex ? { ...meal, items: meal.items.filter((_, ii) => ii !== itemIndex) } : meal)),
  }
}

/** Every recipe name in the week, with how many days it appears on — the variety cap's own unit. */
function countWeeklyRecipeUse(days: GroundedRecipeDay[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) counts.set(item.recipe.name, (counts.get(item.recipe.name) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Repair a whole week, in day order, sharing one weekly recipe-use tally so
 * the days cannot collectively overspend a single rescue dish.
 */
export function repairWeek(
  days: GroundedRecipeDay[],
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints
): { days: GroundedRecipeDay[]; swaps: RepairSwap[] } {
  const weeklyCounts = countWeeklyRecipeUse(days)
  const swaps: RepairSwap[] = []
  const repaired = days.map((day) => {
    // Plate shape first, then macros: the macro repair below only swaps a
    // dish for one of the same bucket, so it keeps whatever sabzi count it
    // is handed.
    const single = enforceSingleSabzi(day, target, pool, weeklyCounts)
    swaps.push(...single.swaps)
    const result = repairDay(single.day, target, pool, constraints, weeklyCounts)
    swaps.push(...result.swaps)
    return result.day
  })
  const varied = enforceVariety(repaired, target, pool, constraints)
  // Last word to the weekday rule. Every pass above already filters its
  // candidates by it, so this is normally a no-op; it is here so a future
  // pass that forgets cannot put chicken back on a no-non-veg day.
  const finalSwaps: RepairSwap[] = []
  const finalCounts = countWeeklyRecipeUse(varied.days)
  const finalDays = varied.days.map((d) => {
    const ruled = enforceDayRules(d, target, pool, constraints, finalCounts)
    finalSwaps.push(...ruled.swaps)
    return ruled.day
  })
  return { days: finalDays, swaps: [...swaps, ...varied.swaps, ...finalSwaps] }
}

/**
 * A variety swap may move a day's worst macro up to here, or leave it no
 * worse than it already was — the same slack a regional dish gets, for the
 * same reason: a plate that does not repeat is worth a little macro room,
 * never a failed day.
 */
export const VARIETY_DEVIATION_CEILING = REGIONAL_DEVIATION_CEILING

/** Upper bound on variety swaps in one week — a guard, not a target; a real week needs a handful. */
const MAX_VARIETY_SWAPS_PER_WEEK = 30

interface Occurrence {
  dayPos: number
  mealIndex: number
  itemIndex: number
}

/**
 * The first item, in day/meal order, that breaks a variety rule: its weekly
 * count is over repeatCapFor(), or it is a dish (not a staple) already served
 * earlier today or yesterday. Always the LATER occurrence, so the first time
 * a dish appears is what stays.
 */
function nextVarietyOffence(days: GroundedRecipeDay[], skip: Set<string>): Occurrence | null {
  const counts = new Map<string, number>()
  let yesterday = new Set<string>()
  for (let dayPos = 0; dayPos < days.length; dayPos++) {
    const today = new Set<string>()
    const meals = days[dayPos].meals
    for (let mealIndex = 0; mealIndex < meals.length; mealIndex++) {
      const items = meals[mealIndex].items
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const recipe = items[itemIndex].recipe
        const count = (counts.get(recipe.id) ?? 0) + 1
        counts.set(recipe.id, count)
        const backToBack = !isEverydayStaple(recipe) && (today.has(recipe.id) || yesterday.has(recipe.id))
        today.add(recipe.id)
        if ((count > repeatCapFor(recipe) || backToBack) && !skip.has(`${dayPos}:${mealIndex}:${itemIndex}:${recipe.id}`)) {
          return { dayPos, mealIndex, itemIndex }
        }
      }
    }
    yesterday = today
  }
  return null
}

function recipeIdsOnDay(day: GroundedRecipeDay | undefined): Set<string> {
  return new Set(day ? day.meals.flatMap((meal) => meal.items.map((item) => item.recipe.id)) : [])
}

/**
 * WHY THIS EXISTS. Measured on 14 real North Indian plans (2026-09-29): the
 * prompt's "no recipe more than twice" rule was broken on every one of them
 * (Rajma Curry four times in a single week), and on the best-of-N path a
 * variety breach is only a warning, so nothing ever corrected it. A prompt
 * rule is not a guarantee; this is.
 *
 * Swaps an over-used or back-to-back dish for another from the same
 * varietyFamily() — a dal for a dal, a roti for a roti — never used yet this
 * week if possible, re-balances the day, and keeps the swap only if it adds
 * no plausibility problem and leaves the day within VARIETY_DEVIATION_CEILING
 * (or no worse than it was). A regional dish is only swapped for another
 * regional dish, so the regional pass's guarantee survives. When no swap
 * qualifies the repeat stays, and buildRecipeWarnings() reports it.
 */
export function enforceVariety(
  days: GroundedRecipeDay[],
  target: DailyRecipeTarget,
  pool: RepairPool,
  constraints: ClientRecipeConstraints
): { days: GroundedRecipeDay[]; swaps: RepairSwap[] } {
  const swaps: RepairSwap[] = []
  const current = [...days]
  const skip = new Set<string>()
  const regionalIds = regionalRecipeIds(pool)
  const weeklyCounts = countWeeklyRecipeUse(current)

  for (let round = 0; round < MAX_VARIETY_SWAPS_PER_WEEK; round++) {
    const offence = nextVarietyOffence(current, skip)
    if (offence === null) break
    const day = current[offence.dayPos]
    const item = day.meals[offence.mealIndex].items[offence.itemIndex]
    const offenceKey = `${offence.dayPos}:${offence.mealIndex}:${offence.itemIndex}:${item.recipe.id}`

    if (day.meals.some((meal) => meal.items.some((i) => i.gramsLocked))) {
      skip.add(offenceKey)
      continue
    }

    const worstNow = worstRelativeDeviation(day.totals, target)
    const allowed = Math.max(worstNow, VARIETY_DEVIATION_CEILING)
    const baselineProblems = describePlausibilityProblems(day, constraints).length
    const nearby = new Set([
      ...recipeIdsOnDay(current[offence.dayPos - 1]),
      ...recipeIdsOnDay(day),
      ...recipeIdsOnDay(current[offence.dayPos + 1]),
    ])
    const namesInMeal = new Set(day.meals[offence.mealIndex].items.map((i) => i.recipe.name))
    const own = contributionOf(item)
    const othersTotals: MacroTotals = {
      kcal: day.totals.kcal - own.kcal,
      proteinG: day.totals.proteinG - own.proteinG,
      carbsG: day.totals.carbsG - own.carbsG,
      fatG: day.totals.fatG - own.fatG,
    }

    const mustStayRegional = regionalIds.has(item.recipe.id)
    const allowedToday = allowedOnDay(constraints, day.dayIndex)
    const candidates = (pool.byFamily.get(varietyFamily(item.recipe)) ?? [])
      .filter((recipe) => {
        if (recipe.id === item.recipe.id || namesInMeal.has(recipe.name)) return false
        if (!allowedToday(recipe)) return false
        if (mustStayRegional && !regionalIds.has(recipe.id)) return false
        if ((weeklyCounts.get(recipe.name) ?? 0) >= repeatCapFor(recipe)) return false
        if (!isEverydayStaple(recipe) && nearby.has(recipe.id)) return false
        return true
      })
      .map((recipe) => ({ recipe, used: weeklyCounts.get(recipe.name) ?? 0, estimate: bestAchievableWorst(othersTotals, recipe, target) }))
      .filter((c) => c.estimate <= allowed)
      // Not yet used this week first — the point is a new dish, not a
      // different repeat — then whichever fits the day's macros best.
      .sort((a, b) => a.used - b.used || a.estimate - b.estimate || (a.recipe.id < b.recipe.id ? -1 : 1))

    let best: { day: GroundedRecipeDay; score: number; used: number; recipe: RecipeForPipeline } | null = null
    for (const candidate of candidates.slice(0, MAX_FULL_EVALUATIONS_PER_ROUND)) {
      if (best !== null && candidate.used > best.used) break
      const rebalanced = balanceDayToTargets(replaceItem(day, offence.mealIndex, offence.itemIndex, candidate.recipe), target)
      if (describePlausibilityProblems(rebalanced, constraints).length > baselineProblems) continue
      const score = worstRelativeDeviation(rebalanced.totals, target)
      if (score > allowed) continue
      if (best === null || score < best.score) best = { day: rebalanced, score, used: candidate.used, recipe: candidate.recipe }
    }

    if (best === null) {
      skip.add(offenceKey)
      continue
    }
    weeklyCounts.set(item.recipe.name, Math.max(0, (weeklyCounts.get(item.recipe.name) ?? 1) - 1))
    weeklyCounts.set(best.recipe.name, (weeklyCounts.get(best.recipe.name) ?? 0) + 1)
    swaps.push({ dayIndex: day.dayIndex, slot: day.meals[offence.mealIndex].slot, from: item.recipe.name, to: best.recipe.name })
    current[offence.dayPos] = best.day
  }

  return { days: current, swaps }
}
