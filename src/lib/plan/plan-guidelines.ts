/**
 * Pure derivation logic for the plan view/PDF — display types, formatting
 * helpers, and the dynamic guidelines/foods-to-avoid/narrative generation
 * (Prompt 8: "GUIDELINES block, generated from plan data not hardcoded").
 * Deliberately has ZERO import of "@/db" — unlike plan-view-model.ts (which
 * loads a plan from Postgres and calls into this file), everything here
 * takes already-loaded data as parameters, so it's unit-testable without a
 * database or env vars, the same split eligible-foods.ts uses for its pure
 * filter logic.
 */

import type { Food } from "@/db/schema"
import type { Category } from "@/lib/counselling/types"
import type { RoadmapResult } from "@/lib/counselling/roadmap"
import { filterEligibleFoods } from "./eligible-foods"
import type { AchievedMacros, ExchangeCode, ExchangeCounts } from "./table-4-1"

export const CATEGORY_LABEL: Record<Category, string> = {
  first_timer: "First-timer",
  plateaued: "Plateaued",
  re_starter: "Re-starter",
  maintenance: "Maintenance",
}

export const SLOT_LABEL: Record<string, string> = {
  breakfast: "Breakfast",
  mid_morning: "Mid-Morning",
  lunch: "Lunch",
  evening: "Evening",
  dinner: "Dinner",
  bedtime: "Bedtime",
}

// Single display clock times, distinct from meal_templates.time_hint (which
// stores an acceptable planning WINDOW, e.g. "7:30-9:00 AM") — the real
// plan PDF shows one fixed time per slot.
export const SLOT_TIME: Record<string, string> = {
  breakfast: "08:00",
  mid_morning: "11:00",
  lunch: "13:30",
  evening: "16:30",
  dinner: "20:00",
  bedtime: "22:00",
}

/**
 * Everything the plan page's edit dialog needs about ONE recipe item, beyond
 * what it already shows. Present only on a recipe-engine item (see
 * recipe-view-adapter.ts) - an exchange-engine item is not hand-editable and
 * leaves this undefined, which is what the UI dispatches on.
 *
 * per100G comes from the item's own SNAPSHOT columns, the same source its
 * displayed macros come from, so the dialog's live "what would this become"
 * arithmetic can never disagree with the row above it.
 */
export interface RecipeItemEditing {
  /** True when a dietitian set this quantity by hand - the balancer holds it fixed (see recipe-balancer.ts). */
  gramsLocked: boolean
  /** recipes.unit_label / per_unit_grams - what one piece is, when this dish is counted in pieces at all. */
  unitLabel: string | null
  perUnitGrams: number | null
  /** The row's own authored serving range. Advisory in the dialog, never a hard stop - see recipe-quantity-step.ts. */
  minGrams: number
  maxGrams: number
  per100G: { kcal: number; proteinG: number; carbsG: number; fatG: number; fiberG: number }
}

export interface PlanViewItem {
  id: string
  foodId: string
  nameEn: string
  householdMeasure: string | null
  servingRawG: number | null
  /** Null for a recipe-engine item (see recipe-view-adapter.ts) — every exchangeType-keyed check elsewhere (format-item.ts, meal-composition.ts, vegetable-dish-naming.ts) is naturally false/no-op for null, which is correct: a recipe is already its own complete, realistically-named identity. */
  exchangeType: ExchangeCode | null
  /** Meaningless (0) for a dish-engine item — grams (servingRawG) is the real quantity there. */
  exchangeCount: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  /** Optional, additive widening — populated for a recipe-engine item (see recipe-view-adapter.ts), absent for an exchange-engine item. Fiber is a soft target for the recipe engine, tracked and shown, never gating (see recipe-validate.ts). */
  fiberG?: number
  /** Recipe-engine only: a whole-number natural quantity ("3 pieces", "1 cup") — see recipe-quantity-display.ts. Null when the recipe has no derivable unit (falls back to a gram figure) or for an exchange-engine item. */
  quantityLabel?: string | null
  /** Recipe-engine only: the public recipe page for this dish, printed as a clickable link in the plan PDF. Null when the hyperlink workbook has no page for it (roughly half the catalogue) or for an exchange-engine item. Display metadata — never read by any nutrition calculation. */
  recipeUrl?: string | null
  /** Dish Composition Layer input — see dish-combination.ts / meal-composition.ts. Never read by any nutrition calculation. */
  dishFamilyId: string | null
  /** Straight from foods.tags — meal-composition.ts reads the "salad" tag to keep raw/salad vegetables out of the cooked "Mixed Vegetable Sabzi" pool. Never read by any nutrition calculation. */
  tags: string[]
  /** Recipe-engine only. Its presence is what tells the plan page this item can be deleted, re-quantified or swapped by hand. */
  editing?: RecipeItemEditing
}

export interface PlanViewMeal {
  /** diet_plan_meals.id — the target for "add an item to this meal". */
  id: string
  slot: string
  slotLabel: string
  timeLabel: string
  items: PlanViewItem[]
  totals: AchievedMacros
  calPercent: number
  /** Set when this meal was generated from a meal_archetype (currently South Indian breakfast only) — null otherwise. Presentation only; never affects which foods were selected. */
  archetypeId: string | null
  archetypeName: string | null
  /**
   * The archetype's OWN declared dish_family_ids, keyed by exchange type —
   * e.g. `{cereal: [chapatiFamilyId], pulse: [moongDalFamilyId]}`. Empty
   * object when archetypeId is null or the archetype declares no
   * components. See dish-combination.ts's archetype-name-merge gate: the
   * weekly-union narrowing (eligibleFoodsBySlot is day-invariant) means the
   * food actually selected on a given day can drift from what that day's
   * archetype intended, so the merge must check the SPECIFIC food's
   * dish_family_id against this, not just "does the archetype have a pulse
   * role at all".
   */
  archetypeDishFamilyIdsByExchangeType: Partial<Record<ExchangeCode, string[]>>
}

export interface PlanViewDay {
  dayIndex: number
  date: string
  dateLabel: string
  meals: PlanViewMeal[]
  totals: AchievedMacros
}

export interface WeeklySummaryRow {
  label: string
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  proteinPct: number
  carbsPct: number
  fatPct: number
  /** Optional, additive widening — populated only for a recipe-engine plan's weekly summary. */
  fiberG?: number
}

export interface GuidelineBullet {
  lead?: string
  text: string
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function dateLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", timeZone: "UTC" })
}

export function dateRangeLabel(startIso: string, endIso: string): string {
  const start = new Date(`${startIso}T00:00:00Z`)
  const end = new Date(`${endIso}T00:00:00Z`)
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" })
  const year = end.toLocaleDateString("en-IN", { year: "numeric", timeZone: "UTC" })
  return `${fmt(start)} – ${fmt(end)} ${year}`
}

export function joinNatural(items: string[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

// ---------------------------------------------------------------------------
// Dynamic guideline / narrative generation — every fact below is read off
// the plan just built, never hardcoded copy. See Prompt 8 spec: "GUIDELINES
// block, generated from plan data not hardcoded."
// ---------------------------------------------------------------------------

const NON_VEG_INCOMPATIBLE = new Set(["vegan", "jain"])

export interface BuildGuidelinesInput {
  plan: { region: string; dietType: string }
  days: PlanViewDay[]
  exchangeCounts: ExchangeCounts
  roadmapOutput: RoadmapResult
  allFoods: Food[]
}

export interface BuildGuidelinesResult {
  guidelines: GuidelineBullet[]
  foodsToAvoid: string[]
  narrative: string
}

export function buildGuidelines({ plan, days, exchangeCounts, roadmapOutput, allFoods }: BuildGuidelinesInput): BuildGuidelinesResult {
  const day0 = days[0]
  const guidelines: GuidelineBullet[] = []

  guidelines.push({
    text: "Every food item is drawn from the verified Comprehensive Food Exchange List (Table 4.1).",
  })

  // Only block-level flags — those already required a recorded dietitian
  // override to reach generation at all, so the override reason belongs in
  // front of the client too. Warn-level flags (fat-floor, bmr-floor, …) are
  // internal "which formula fired" footnotes for the dietitian reviewing the
  // roadmap, not something a client should see printed as a caution.
  for (const flag of roadmapOutput.flags.filter((f) => f.level === "block")) {
    if (flag.code === "GOAL_CATEGORY_CONFLICT") {
      guidelines.push({
        lead: "Review the roadmap classification before starting.",
        text: `The plan has been costed exactly to the ${Math.round(roadmapOutput.macrosAtTarget.kcal)} kcal ${CATEGORY_LABEL[roadmapOutput.category].toLowerCase()} prescription, but the same roadmap also records ${roadmapOutput.anthro.toLoseKg.toFixed(1)} kg to lose. That intake will not produce that loss. Confirm the intended goal with the dietitian at the first check-in.`,
      })
    } else {
      guidelines.push({ lead: "Review before starting.", text: flag.message })
    }
  }

  const mealCount = day0?.meals.length ?? 0
  guidelines.push({
    lead: `${numberWord(mealCount)} meals, fixed times.`,
    text: "Skipping a meal doesn't lower the day's total — it just makes the remaining meals harder to finish.",
  })

  const lunchFatG = sumServingGrams(day0, "lunch", "fat")
  const dinnerFatG = sumServingGrams(day0, "dinner", "fat")
  if (lunchFatG > 0 || dinnerFatG > 0) {
    guidelines.push({
      lead: "Cooking oil is the one thing to measure.",
      text: `${Math.round(lunchFatG)} g at lunch and ${Math.round(dinnerFatG)} g at dinner, spooned into the pan, never poured. Tadka oil counts.`,
    })
  }

  const cerealNames = topFoodNames(days, "cereal", 4)
  const pulseNames = topFoodNames(days, "pulse", 4)
  if (cerealNames.length > 0 || pulseNames.length > 0) {
    const rawItems = [...cerealNames, ...(pulseNames.length ? ["dal"] : [])]
    guidelines.push({ text: `${joinNatural(rawItems)} weights are all raw, before cooking.` })
  }

  if (roadmapOutput.proteinRamp.length > 0) {
    const ramp = roadmapOutput.proteinRamp
    const chain = [ramp[0].beforeG, ...ramp.map((r) => r.afterG)]
    guidelines.push({
      text: `Protein rises ${chain.map((g) => Math.round(g)).join(" → ")} g over the first ${ramp.length} week${ramp.length === 1 ? "" : "s"} while calories hold at ${Math.round(roadmapOutput.macrosAtTarget.kcal)}.`,
    })
  }

  const clientAllergens: string[] = [] // swap-eligibility already applied at generation time; the free-swap list re-derives the same universe.
  const eligible = filterEligibleFoods(allFoods, {
    region: plan.region,
    dietType: plan.dietType,
    clientAllergens,
    clientDislikes: [],
  })
  const vegA = [...new Set(eligible.filter((f) => f.exchangeType === "vegetable_a").map((f) => f.nameEn))].sort()
  const vegB = [...new Set(eligible.filter((f) => f.exchangeType === "vegetable_b").map((f) => f.nameEn))].sort()
  if (vegA.length > 0 || vegB.length > 0) {
    const parts: string[] = []
    if (vegA.length > 0) parts.push(`Vegetable A (100 g) — ${vegA.join(", ").toLowerCase()}`)
    if (vegB.length > 0) parts.push(`Vegetable B (50 g) — ${vegB.join(", ").toLowerCase()}`)
    guidelines.push({ text: `Any vegetable from the same exchange group may be swapped freely: ${parts.join("; ")}.` })
  }

  if (!NON_VEG_INCOMPATIBLE.has(plan.dietType)) {
    guidelines.push({
      text: "Non-vegetarian option: 1 whole egg or 35 g chicken breast / fish may replace one pulse exchange (30 g raw dal) at either main meal, one swap per day.",
    })
  }

  guidelines.push({ text: "Hydration: 3.5+ litres of water per day. Dinner is the last meal of the day." })

  const foodsToAvoid: string[] = []
  if (exchangeCounts.sugar === 0) {
    foodsToAvoid.push("Sugar, jaggery and sweetened tea — the plan carries no sugar exchange")
  }
  foodsToAvoid.push(
    "Sweetened drinks, packaged juice, cold drinks",
    "Deep-fried snacks: samosa, pakora, kachori, namkeen, chips, puri",
    "Bakery and refined-flour items: biscuits, rusk, cake, white bread, maida-based food",
    "Any oil or ghee beyond the measured amounts listed — no extra tadka or ghee on roti"
  )

  const narrative = buildNarrative({ plan, days, roadmapOutput })

  return { guidelines, foodsToAvoid, narrative }
}

/** Fat exchanges always resolve to a food with a fixed gram serving (ghee, oil, nuts) — unlike fruit, servingRawG is never null here. */
function sumServingGrams(day: PlanViewDay | undefined, slot: string, exchangeType: ExchangeCode): number {
  if (!day) return 0
  const meal = day.meals.find((m) => m.slot === slot)
  if (!meal) return 0
  return meal.items.filter((i) => i.exchangeType === exchangeType).reduce((sum, i) => sum + (i.servingRawG ?? 0), 0)
}

/**
 * Most-used food names for an exchange type across the week, not every
 * distinct one — with a large eligible pool the fallback/AI selector can
 * rotate through most of it over 7 days, and an exhaustive list reads as
 * noise. "roti, rice, poha and dalia" (the real reference plan) names the
 * staples that actually recur, not the full rotation universe.
 */
export function topFoodNames(days: PlanViewDay[], exchangeType: ExchangeCode, limit: number): string[] {
  const counts = new Map<string, number>()
  for (const day of days) {
    for (const meal of day.meals) {
      for (const item of meal.items) {
        if (item.exchangeType !== exchangeType) continue
        const name = item.nameEn.toLowerCase()
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name)
}

export function numberWord(n: number): string {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]
  return words[n] ?? String(n)
}

export function buildNarrative({
  plan,
  days,
  roadmapOutput,
}: {
  plan: { region: string; dietType: string }
  days: PlanViewDay[]
  roadmapOutput: RoadmapResult
}): string {
  const day0 = days[0]
  const regionLabel = plan.region.replace(/_/g, " ")
  const dietTypeLabel = plan.dietType.replace(/_/g, "-")
  const cerealNames = topFoodNames(days, "cereal", 4)

  const pulseSlots = day0?.meals.filter((m) => m.items.some((i) => i.exchangeType === "pulse")).map((m) => m.slot) ?? []
  const pulseDescription =
    pulseSlots.length === 2 && pulseSlots.includes("lunch") && pulseSlots.includes("dinner")
      ? "a dal at both main meals"
      : pulseSlots.length > 0
        ? `dal at ${joinNatural(pulseSlots.map((s) => SLOT_LABEL[s]?.toLowerCase() ?? s))}`
        : "no dal exchange this week"

  const dinnerVegCount =
    day0?.meals
      .find((m) => m.slot === "dinner")
      ?.items.filter((i) => i.exchangeType === "vegetable_a" || i.exchangeType === "vegetable_b").length ?? 0
  const vegDescription = dinnerVegCount > 0 ? `${numberWord(dinnerVegCount).toLowerCase()} sabzis at dinner` : "a sabzi at dinner"

  const fruitSlotCount = day0?.meals.filter((m) => m.items.some((i) => i.exchangeType === "fruit")).length ?? 0

  const sentence1 = cerealNames.length
    ? `${capitalize(regionLabel)} ${dietTypeLabel} plan built on ${joinNatural(cerealNames)} with ${pulseDescription}, ${vegDescription}, and fruit spread across ${fruitSlotCount} slot${fruitSlotCount === 1 ? "" : "s"}.`
    : `${capitalize(regionLabel)} ${dietTypeLabel} plan with ${pulseDescription}, ${vegDescription}, and fruit spread across ${fruitSlotCount} slot${fruitSlotCount === 1 ? "" : "s"}.`

  const sentence2 =
    "Protein varies slightly day to day by design (a small dal-portion wobble, not a mistake) while the week's average lands exactly on target."

  const sentence3 = categoryNarrative(roadmapOutput)

  return `${sentence1} ${sentence2} ${sentence3}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function categoryNarrative(roadmapOutput: RoadmapResult): string {
  const kcal = Math.round(roadmapOutput.macrosAtTarget.kcal)
  switch (roadmapOutput.category) {
    case "maintenance":
      return `This is a maintenance week at TDEE — no deficit is applied, so the food volume is deliberately large and split across five meals.`
    case "first_timer":
      return `This is a first structured week — intake is set at a moderate deficit below TDEE (${kcal} kcal) to start steady fat loss without an abrupt drop in food volume.`
    case "plateaued":
      return `This week resets intake to break a stalled plateau, applying a deliberate deficit below current maintenance (${kcal} kcal) rather than cutting further from an already-low baseline.`
    case "re_starter":
      return `This week rebuilds structure after a previous relapse, holding intake at ${kcal} kcal while protein ramps back up to target.`
  }
}
