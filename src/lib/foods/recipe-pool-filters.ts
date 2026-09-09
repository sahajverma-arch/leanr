/**
 * Eligibility filtering applied to the recipe pool BEFORE the model sees it.
 * One filter survives; a second (fat-share) was measured, found harmful, and
 * removed — see the note at the bottom of this file before adding it back.
 *
 * Deliberately applied at eligibility time (pure functions over the queried
 * rows) rather than as an `is_active` flag written at ingestion. Both are
 * code, so they take effect without a reseed and a later
 * `npm run seed:recipes` cannot silently undo them — the exact failure mode
 * CLAUDE.md records for the Milk/`milk_cow` mealSlots regression.
 *
 * Nothing here invents or edits a nutrition figure; each filter only decides
 * whether a row may be offered to the model at all.
 */

/** The macro fields these filters read — kept structural so both DB rows and test fixtures satisfy it. */
export interface PoolFilterRecipe {
  name: string
  category: string
  kcalPer100G: number
  fatPer100G: number
}

/**
 * Categories where a genuinely zero-calorie row is correct: plain water,
 * infusions and teas. Everything else claiming 0 kcal is bad data.
 */
const ZERO_KCAL_PLAUSIBLE_CATEGORIES = new Set(["Morning Water", "Bedtime Water", "Tea"])

/**
 * A row that claims to be food but declares no energy at all.
 *
 * Real examples found in the ingested CSV: "Any Veg" and "Any Veg (W/O Aloo,
 * Arbi, Paneer, Soy)" — placeholders rather than dishes, which were being
 * plated to a dietitian as "Any Veg (150 g)"; and "Watermelon", "Moong Dal
 * Idli", "Kandi Pachadi" at 0 kcal, which is simply wrong. The second group
 * is the more damaging: the balancer will happily assign 250 g of an idli
 * that contributes nothing, so the day's arithmetic stays "correct" while
 * the client is told to eat something the plan does not count.
 *
 * NOT a blanket "0 kcal is invalid" rule — Lukewarm Water, Apple Cider
 * Vinegar and the green teas are all legitimately 0 and stay eligible.
 */
export function isNutritionallyEmpty(recipe: PoolFilterRecipe): boolean {
  return recipe.kcalPer100G <= 0 && !ZERO_KCAL_PLAUSIBLE_CATEGORIES.has(recipe.category)
}

/**
 * THE FAT-SHARE FILTER WAS REMOVED. Recorded here so it is not reinvented.
 *
 * A filter dropping recipes whose fat share of calories exceeded the
 * client's own target share by some factor was added, then measured against
 * a real client (Aadi, TEST-004) on three live runs. It made convergence
 * monotonically worse and never better:
 *
 *   headroom 1.5x -> pool 281, weekly deviation 13.0%, REJECTED
 *   headroom 2.5x -> pool 363, weekly deviation  5.0%, REJECTED
 *   removed       -> pool 392, worst macro 4.4%,       ACCEPTED
 *
 * The premise was wrong. The pool does not skew fatty — its median fat share
 * is 23% against a 27% target, already under. Removing calorie-dense
 * recipes only made the fat target harder to reach, and fat then ran UNDER
 * on every day instead of over.
 *
 * The observation that motivated it was real: a rejected week ran fat over
 * on all 7 days with nearly every dish pinned at a serving bound, and the
 * balancer can only scale grams, never fix a dish set's ratio. But that is a
 * SELECTION problem — which dishes the model picks out of a balanced pool —
 * and it has to be fixed where it happens, in the prompt or in a check on
 * the chosen set. Narrowing the pool to compensate treats the symptom and
 * damages the thing that was working.
 */

/** The only pool filter: drop rows that claim to be food while declaring no energy. */
export function filterRecipePool<T extends PoolFilterRecipe>(recipes: T[]): T[] {
  return recipes.filter((r) => !isNutritionallyEmpty(r))
}
