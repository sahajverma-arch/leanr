/**
 * The structural "what must a real lunch/dinner contain" rule — shared
 * between recipe-prompt.ts (so the LLM is told the rule up front, reducing
 * how often it needs correcting) and recipe-plausibility-validate.ts (so
 * the rule is actually enforced in code regardless of whether the model
 * followed it — see CLAUDE.md "THE ONE RULE THAT MATTERS"). Keeping both
 * in one place means the prompt text can never drift from what's checked.
 *
 * Deliberately narrower than recipe-selector-fallback.ts's own
 * SLOT_BUCKET_PLAN: that table drives the deterministic fallback's
 * selection (a "compose from these buckets, skip gracefully if a bucket's
 * pool is empty" list covering every slot), while this is a hard,
 * LLM-path reject-and-retry gate scoped to the two slots the real
 * complaint was about (lunch/dinner missing a staple+dal backbone) — a
 * looser table here would either duplicate the fallback's selection logic
 * for a different purpose or over-constrain breakfast/evening variety the
 * prompt already handles reasonably well via prose.
 */

import type { RecipeCategoryBucket } from "./recipe-category"

export const STRUCTURED_MEAL_SLOTS = new Set(["lunch", "dinner"])

export const STAPLE_BUCKETS = new Set<RecipeCategoryBucket>(["bread", "rice_pulao"])

// The "bread" bucket also holds wraps, rolls, sandwiches and chillas, so it
// can stand in for a roti at breakfast. At lunch and dinner it cannot: a
// dietitian rejected a plan whose lunches were a 10 g Colocasia Leaves Roll
// with dal and no roti or rice. The staple there is a roti, paratha, thepla,
// rice, pulao or biryani — nothing else.
const NOT_A_MEAL_STAPLE = /wrap|roll|sandwich|chila|chilla/i

/** A roti or a rice dish: what a lunch/dinner plate is built on. */
export function isMealStaple(category: string, bucket: RecipeCategoryBucket): boolean {
  return STAPLE_BUCKETS.has(bucket) && !NOT_A_MEAL_STAPLE.test(category)
}
export const DAL_BUCKET: RecipeCategoryBucket = "dal_curry"

// ONE dal OR ONE sabzi per lunch/dinner, not both (dietitian rule,
// 2026-10-12, replacing the earlier "one sabzi with one dal"). The meal is
// made up to its calories with the staple (roti and/or rice) and a salad or
// curd/raita, never with a second cooked curry. A paneer/tofu "High Protein
// Sabzi" is the sabzi. A self-contained khichdi is the staple+dal course
// itself and is not counted, so khichdi + kadhi stays a valid dinner.
// Enforced by recipe-repair.ts's enforceSingleCurry() and checked by
// recipe-plausibility-validate.ts.
export const MAX_CURRY_PER_MEAL = 1
export const CURRY_COURSE_BUCKETS = new Set<RecipeCategoryBucket>(["sabzi", "dal_curry"])
/** Salad and curd/raita share this bucket: the sides a lunch/dinner is filled out with. */
export const SIDE_BUCKET: RecipeCategoryBucket = "salad"

// A single dish already counted as a complete meal on its own (Biryani-as-
// heavy-meal, a Thali-style composite CSV row) satisfies the staple+dal
// requirement by itself — same "heavy_meal is a whole rich dish" reading
// recipe-plausibility-validate.ts's RICH_BUCKETS_NOT_STACKED already uses.
// NOT trusted blindly, though — see MIN_COMPOSITE_CARBS_PER_100G below.
export const COMPLETE_MEAL_BUCKETS = new Set<RecipeCategoryBucket>(["heavy_meal", "light_meal"])

// "Heavy Meal"/"Light Meal" turns out to be this dataset's catch-all for
// two genuinely different things: a real composite one-dish meal (Rajma
// Chawal, a risotto, Tingmo — rice/starch already cooked in) AND a plain
// grilled/roasted protein main with NO starch at all (Roasted Chicken,
// Grilled Chicken Breast, Air Fried Fish, Grilled Fish — all C0/100g; also
// true of vegetarian heavy_meal rows like Grilled Paneer C4, Tofu Tomato
// C5.5) that absolutely still needs a separate roti/rice, exactly like any
// other protein-only dish. Confirmed by profiling all 55 real "Heavy Meal"
// rows before coding this: composite dishes cluster at 8g+ carbs/100g
// (lowest: Tomato Risotto C8.1), protein-only mains cluster below (highest:
// Low Calorie Pav Bhaji C7.8 — itself correctly non-composite, a bhaji is
// eaten WITH pav). One acknowledged imperfection at the boundary: Kfc
// Popcorn Chicken (C9.1, a fried snack, not rice-inclusive) reads as
// composite under this threshold — a real but minor misclassification,
// not worth a special-cased exception for one recipe.
const MIN_COMPOSITE_CARBS_PER_100G = 8

// Khichdi and "Kadhi + Samak Chawal"-style dishes are ALSO already-complete
// staple+dal meals in one preparation — the Category text itself says so
// (rice/grain and lentil/curry cooked together) — but they land in the
// dal_curry bucket, not heavy_meal/light_meal, so COMPLETE_MEAL_BUCKETS
// alone doesn't catch them. Caught on a direct dietitian correction on a
// hand-built plan: "no one eats ajwain paratha with khichdi and tofu
// chilla" / "no one eats paneer paratha with this kuttu kadhi" — the
// structural check was letting (and a hand-picker was making) the same
// mistake it exists to prevent, just from the opposite direction: not a
// MISSING staple, but a REDUNDANT one bolted onto a dish that already IS
// the staple+dal course. No carb gate needed here — a food literally
// Category="Khichdi" is reliably rice+lentil by name, unlike the coarse
// "Heavy Meal" catch-all above.
const SELF_SUFFICIENT_DAL_CATEGORY_MARKERS = ["khichdi", "khichuri", "curry + rice", "curry+rice"]

/** True for a dish that's already a complete staple+dal/curry meal in one preparation — either a genuinely composite Heavy Meal/Light Meal (gated on real carb content, not the label alone) or Category text (Khichdi, "Curry + Rice"). */
export function isSelfContainedMeal(category: string, bucket: RecipeCategoryBucket, carbsPer100G: number): boolean {
  if (COMPLETE_MEAL_BUCKETS.has(bucket)) return carbsPer100G >= MIN_COMPOSITE_CARBS_PER_100G
  // Only a real khichdi stays in dal_curry (recipeCategoryBucket() moves a
  // porridge or a sabzi filed under "Khichdi" out of it), and it must carry
  // real grain: Bajre Ki Khichdi is the lightest real one at 11.6 g carbs.
  if (bucket !== "dal_curry" || carbsPer100G < MIN_COMPOSITE_CARBS_PER_100G) return false
  const c = category.toLowerCase()
  return SELF_SUFFICIENT_DAL_CATEGORY_MARKERS.some((marker) => c.includes(marker))
}

// A meal's MAIN item resolving to one of these (or Consistency=liquid,
// checked separately) cannot anchor a full meal on its own.
export const LIQUID_MAIN_BUCKETS = new Set<RecipeCategoryBucket>(["soup", "beverage"])

// A meal already anchored by a real egg/meat/fish dish shouldn't ALSO carry
// a cooked sabzi or dal_curry — the same "meat is its own protein-and-side
// course" convention CLAUDE.md documents for the exchange engine's own
// MEAT_CONFLICTING_TYPES (pulse/vegetable_a/vegetable_b excluded from a
// meat-bearing slot there). Direct dietitian correction on a hand-built
// plan: "we cant give chicken like things meat with any sabzi and dal ...
// we can give any salad or optimize the quantity." Salad bucket is
// deliberately NOT in this set — a salad alongside meat is completely
// normal; only a cooked sabzi/dal/curry course is the real conflict.
export const MEAT_CONFLICTING_BUCKETS = new Set<RecipeCategoryBucket>(["sabzi", "dal_curry"])

/** A dal, a curry or a sabzi that is the meal's one cooked course — not a self-contained khichdi. */
export function isCurryCourse(category: string, bucket: RecipeCategoryBucket, carbsPer100G: number): boolean {
  return CURRY_COURSE_BUCKETS.has(bucket) && !isSelfContainedMeal(category, bucket, carbsPer100G)
}

const STAPLE_LABEL = "a staple: Roti/Paratha/Thepla and/or Rice/Pulao (a wrap, roll, sandwich or chilla is NOT a staple here)"
const CURRY_LABEL = "exactly ONE Dal/Curry OR ONE Sabzi (never both)"

/** Rendered into the recipe-engine prompt (see recipe-prompt.ts) so the model sees the rule before it's ever checked against it. */
export function formatSlotStructureRules(slotNames: string[]): string {
  const applicable = slotNames.filter((s) => STRUCTURED_MEAL_SLOTS.has(s))
  if (applicable.length === 0) return ""
  const lines = applicable.map(
    (s) =>
      `- ${s} must include ${STAPLE_LABEL} AND ${CURRY_LABEL}. Then add a Salad and/or Curd/Raita alongside to fill the meal out; roti and rice may both be served. Never add a second dal, curry or sabzi to make the meal bigger: the staple, salad and curd make up the calories. A single composite dish that already has real carbs built in (Biryani, a Thali-style Rajma Chawal, a real Khichdi — not a porridge) counts as the staple and dal on its own; never add a SEPARATE roti/rice beside one of these (a kadhi or sabzi beside a khichdi is fine). A plain grilled/roasted protein dish (Roasted Chicken, Grilled Fish) has NO carbs and still needs a staple. A real egg/chicken/fish dish is the meal's protein course by itself: pair it with a staple and a salad/curd, NEVER with a cooked Sabzi or Dal/Curry. Never anchor ${s} on soup, tea, dessert, or a liquid dish alone.`
  )
  return `\nMeal structure requirements (checked automatically — a day missing these gets sent back for a redo):\n${lines.join("\n")}\n`
}
