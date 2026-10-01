/**
 * Weekday food rules from counselling q38/q38a/q38b: "no non-veg or eggs on
 * Monday", "no onion and garlic on Tuesday", and the whole-week q38 options
 * "No egg" / "No beef" / "No pork".
 *
 * WHY THIS EXISTS. The counselling form has asked these questions, and told
 * the counsellor "these day rules are enforced per weekday in the generated
 * plan", since the day questions were added — but nothing ever read the
 * answers. A non-vegetarian client marked "no non-veg or eggs on Monday" got
 * Chicken Kathi Roll, Prawns Salad and Egg Rice on Monday in three drafts in
 * a row (2026-10-01). A day rule is now a hard rule exactly like an allergy:
 * filtered in generation, re-checked on every edit, and blocking approval.
 *
 * A day is matched by its real calendar date (UTC weekday of the stored ISO
 * date), never by its position in the week: a plan's week can start on any
 * weekday, so "day 1" is not Monday.
 *
 * Pure functions, zero I/O.
 */

import type { Answers } from "@/lib/counselling/questions"
import { detectRecipeAnimalContent, isRecipeAllowedForDiet } from "@/lib/foods/recipe-animal-content"

/** What a rule forbids. `non_veg` is meat and fish; egg is its own option in q38b. */
export type DayAvoid = "non_veg" | "egg" | "onion_garlic" | "all_animal" | "beef" | "pork"

/** Weekday names indexed by Date.getUTCDay() (0 = Sunday). */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const

export interface DayFoodRules {
  /** UTC weekday (0 = Sunday) -> everything forbidden that day. Weekdays with no rule are absent. */
  byWeekday: Map<number, Set<DayAvoid>>
  /**
   * Answers code cannot check (a fasting grain rule, "Other", Halal...).
   * Shown to the dietitian as a warning on the plan, never silently dropped.
   */
  unchecked: string[]
  /**
   * The answers name a weekday rule but not enough to enforce it (what is
   * avoided with no days ticked, or days with nothing avoided). Generation
   * refuses rather than guessing which days were meant.
   */
  incomplete: string | null
}

export const NO_DAY_RULES: DayFoodRules = { byWeekday: new Map(), unchecked: [], incomplete: null }

const NO_DAY_RULE_OPTIONS = ["No restriction", "Prefer not to answer"]

// q38b option -> what it forbids. Options absent here cannot be checked by code.
const Q38B_AVOIDS: Record<string, DayAvoid> = {
  "Non-vegetarian food": "non_veg",
  Eggs: "egg",
  "Onion & garlic": "onion_garlic",
  "All animal products": "all_animal",
}

// q38 options that are rules for EVERY day, not only the ticked ones.
const Q38_WHOLE_WEEK_AVOIDS: Record<string, DayAvoid> = {
  "No egg": "egg",
  "No beef": "beef",
  "No pork": "pork",
}

// q38 options a dish's name and tags cannot prove either way.
const Q38_UNCHECKABLE = ["Halal", "Kosher", "Fasting practice", "Separate cooking not allowed", "Other"]

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function addAvoid(byWeekday: Map<number, Set<DayAvoid>>, weekday: number, avoid: DayAvoid) {
  const set = byWeekday.get(weekday)
  if (set) set.add(avoid)
  else byWeekday.set(weekday, new Set([avoid]))
}

export function dayFoodRulesFromAnswers(answers: Answers): DayFoodRules {
  const q38 = stringList(answers.q38)
  const byWeekday = new Map<number, Set<DayAvoid>>()
  const unchecked: string[] = []
  let incomplete: string | null = null

  for (const option of q38) {
    const avoid = Q38_WHOLE_WEEK_AVOIDS[option]
    if (avoid) for (let w = 0; w < 7; w++) addAvoid(byWeekday, w, avoid)
    if (Q38_UNCHECKABLE.includes(option)) unchecked.push(`"${option}" (cultural or religious practice)`)
  }

  // Same gate as the form's own showIf for q38a/b/c: with q38 at "No
  // restriction" the day questions are hidden, so anything left in them is a
  // stale answer the counsellor can no longer see, not a rule.
  const hasDayRules = q38.some((v) => !NO_DAY_RULE_OPTIONS.includes(v))
  if (hasDayRules) {
    const weekdays = stringList(answers.q38a)
      .map((name) => WEEKDAY_NAMES.indexOf(name as (typeof WEEKDAY_NAMES)[number]))
      .filter((w) => w >= 0)
    const q38b = stringList(answers.q38b)
    const avoids = new Set<DayAvoid>()
    for (const option of q38b) {
      const avoid = Q38B_AVOIDS[option]
      if (avoid) avoids.add(avoid)
    }
    // The q38 option itself says what is avoided, even if q38b was not ticked to match.
    if (q38.includes("No non-vegetarian food on selected days")) avoids.add("non_veg")

    const dayNames = weekdays.map((w) => WEEKDAY_NAMES[w]).join(", ")
    for (const option of q38b) {
      if (!Q38B_AVOIDS[option]) unchecked.push(`"${option}"${dayNames ? ` on ${dayNames}` : ""}`)
    }
    const details = typeof answers.q38c === "string" ? answers.q38c.trim() : ""
    if (details) unchecked.push(`day-rule details: "${details}"`)

    if (avoids.size > 0 && weekdays.length === 0) {
      incomplete = `The counselling form says this client avoids ${describeAvoids(avoids)} on certain days, but no days are ticked ("On which days do these rules apply?"). Tick the days on the counselling form, then generate again.`
    } else if (weekdays.length > 0 && q38b.length === 0 && !q38.includes("No non-vegetarian food on selected days")) {
      incomplete = `The counselling form ticks ${dayNames} for a day rule but not what is avoided on those days ("What is avoided on those days?"). Fill it in on the counselling form, then generate again.`
    }
    for (const w of weekdays) for (const avoid of avoids) addAvoid(byWeekday, w, avoid)
  }

  return { byWeekday, unchecked, incomplete }
}

/** UTC weekday of an ISO date (YYYY-MM-DD). */
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay()
}

/** Everything forbidden on this date, or an empty set. */
export function avoidsOnDate(rules: DayFoodRules, isoDate: string): ReadonlySet<DayAvoid> {
  return rules.byWeekday.get(weekdayOf(isoDate)) ?? new Set()
}

export interface DayRestriction {
  weekday: string
  avoids: ReadonlySet<DayAvoid>
}

/**
 * Each restricted day of one plan week, keyed by dayIndex (0-6) — the shape
 * the generator works in. `weekStartIso` is the date of dayIndex 0.
 */
export function restrictionsForWeek(rules: DayFoodRules, weekStartIso: string): Map<number, DayRestriction> {
  const out = new Map<number, DayRestriction>()
  const start = weekdayOf(weekStartIso)
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const weekday = (start + dayIndex) % 7
    const avoids = rules.byWeekday.get(weekday)
    if (avoids && avoids.size > 0) out.set(dayIndex, { weekday: WEEKDAY_NAMES[weekday], avoids })
  }
  return out
}

const AVOID_LABELS: Record<DayAvoid, string> = {
  non_veg: "meat or fish",
  egg: "egg",
  onion_garlic: "onion or garlic",
  all_animal: "any animal product (no meat, fish, egg or dairy)",
  beef: "beef",
  pork: "pork",
}

/** "meat or fish, egg" — for the prompt and for messages. */
export function describeAvoids(avoids: ReadonlySet<DayAvoid>): string {
  return [...avoids].map((a) => AVOID_LABELS[a]).join(", ")
}

const ONION_GARLIC_RE = /\b(onions?|garlic|pyaz|pyaaz|pyaj|lahsun|lehsun|lasun|lasan)\b/i
const BEEF_RE = /\b(beef|veal|gelatine?)\b/i
const PORK_RE = /\b(pork|bacon|ham|prosciutto|pepperoni|lard|gelatine?)\b/i

interface DishEvidence {
  name: string
  meatOrFish: boolean
  egg: boolean
  /** True when the dish is confirmed free of every animal product. */
  vegan: boolean
  onionGarlic: boolean
}

function violationFor(dish: DishEvidence, avoids: ReadonlySet<DayAvoid>, weekday: string): string | null {
  if (avoids.has("all_animal") && !dish.vegan) return `contains animal products, and this client has none on ${weekday}`
  if (avoids.has("non_veg") && dish.meatOrFish) return `non-veg, and this client has no non-veg on ${weekday}`
  if (avoids.has("egg") && dish.egg) return `contains egg, and this client has no egg on ${weekday}`
  if (avoids.has("onion_garlic") && dish.onionGarlic) return `contains onion or garlic, and this client has none on ${weekday}`
  if (avoids.has("beef") && BEEF_RE.test(dish.name)) return "contains beef, which this client does not eat"
  if (avoids.has("pork") && PORK_RE.test(dish.name)) return "contains pork, which this client does not eat"
  return null
}

/** Why this recipe must not be served on a day with these rules, or null. */
export function recipeDayRuleViolation(
  recipe: { name: string; dietTypes: readonly string[]; allergenTags: readonly string[] },
  avoids: ReadonlySet<DayAvoid>,
  weekday: string
): string | null {
  if (avoids.size === 0) return null
  const animal = detectRecipeAnimalContent(recipe)
  return violationFor(
    {
      name: recipe.name,
      // By the dish's own evidence as well as its label: the CSV labelled
      // real fish dishes vegetarian (see recipe-animal-content.ts).
      meatOrFish: animal.meat || animal.fish || !isRecipeAllowedForDiet(recipe, "eggetarian"),
      egg: animal.egg || (!animal.meat && !animal.fish && !isRecipeAllowedForDiet(recipe, "vegetarian")),
      vegan: isRecipeAllowedForDiet(recipe, "vegan"),
      onionGarlic: recipe.allergenTags.includes("onion_garlic") || ONION_GARLIC_RE.test(recipe.name),
    },
    avoids,
    weekday
  )
}

/** The same rule for an exchange-engine food row. */
export function foodDayRuleViolation(
  food: { nameEn: string; dietTypes: readonly string[]; allergens: readonly string[] },
  avoids: ReadonlySet<DayAvoid>,
  weekday: string
): string | null {
  if (avoids.size === 0) return null
  const animal = detectRecipeAnimalContent({ name: food.nameEn, allergenTags: food.allergens })
  const vegetarian = food.dietTypes.includes("vegetarian")
  const eggetarian = food.dietTypes.includes("eggetarian")
  return violationFor(
    {
      name: food.nameEn,
      meatOrFish: animal.meat || animal.fish || (!vegetarian && !eggetarian),
      egg: animal.egg || (!vegetarian && eggetarian),
      vegan: food.dietTypes.includes("vegan") && !animal.meat && !animal.fish && !animal.egg,
      onionGarlic: ONION_GARLIC_RE.test(food.nameEn),
    },
    avoids,
    weekday
  )
}

/** Recipe check by calendar date — what the plan page, edits and approval use. */
export function recipeDayRuleViolationOnDate(
  recipe: { name: string; dietTypes: readonly string[]; allergenTags: readonly string[] },
  rules: DayFoodRules,
  isoDate: string
): string | null {
  return recipeDayRuleViolation(recipe, avoidsOnDate(rules, isoDate), WEEKDAY_NAMES[weekdayOf(isoDate)])
}

export function foodDayRuleViolationOnDate(
  food: { nameEn: string; dietTypes: readonly string[]; allergens: readonly string[] },
  rules: DayFoodRules,
  isoDate: string
): string | null {
  return foodDayRuleViolation(food, avoidsOnDate(rules, isoDate), WEEKDAY_NAMES[weekdayOf(isoDate)])
}
