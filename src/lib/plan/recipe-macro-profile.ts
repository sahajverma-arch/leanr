/**
 * "Show me the high-protein dishes" — filtering the swap/add picker by what a
 * dish is FOR, not just what it is called.
 *
 * WHY THIS IS COMPUTED AND NOT READ OFF A COLUMN. `recipes.macro_category`
 * looks like the obvious source and is not: 533 of 1222 rows are blank, and
 * the values that exist are dish types, not macro profiles — "Meal" (96),
 * "Dessert" (71), "Porridge" (51), "Sabzi" (48), "Chinese" (46), "Rice" (23).
 * There is no "High Protein" value anywhere in it. So these tags are derived
 * from each recipe's own verified per-100g macros, which every row has, and
 * therefore cannot disagree with the numbers shown beside the dish.
 *
 * WHY EACH TAG IS TWO GATES, NOT A PERCENTAGE. Share-of-calories alone is
 * actively wrong on this dataset, which was measured before these thresholds
 * were chosen rather than after. Ranked by protein share, the second-highest
 * row is "Fitelo Hibiscus Rose Tea" at 50% — on 0.2 g of protein per 100 g
 * and 2 kcal. Eight different herbal teas are "100% carbohydrate" on ~0.2 g
 * of carbs. A percentage of almost nothing is still almost nothing, so every
 * tag also requires a real absolute amount. Same class of problem as the
 * zero-kcal rows recipe-pool-filters.ts drops, arriving from a different
 * direction.
 *
 * These tags are DISPLAY AND FILTERING ONLY. Nothing here feeds the balancer,
 * the validator, or any target — a filter that changed what a plan adds up to
 * would be a very different thing from a filter that helps someone find a
 * dish.
 */

export type MacroProfileTag = "high_protein" | "high_carb"

/** Only the fields the tags read. Satisfied by a full recipe row and by a picker candidate alike. */
export interface MacroProfileInput {
  proteinPer100G: number
  carbsPer100G: number
  kcalPer100G: number
}

/**
 * Share thresholds, read off the real distribution across the 1212 rows that
 * declare energy rather than picked as round numbers:
 *
 *            p10    p25   median   p75    p90
 *   protein   6.6   10.0   14.3    19.6   26.0
 *   carbs    16.9   38.9   57.9    70.5   82.7
 *
 * Protein at 25% is roughly the top decile — genuinely "a protein dish" in a
 * catalogue this carb-forward, and it yields 101 rows. Carbs at 55% is just
 * under the median, which sounds lax until you remember that half of an
 * Indian recipe table IS the carbohydrate half; it yields 435.
 */
const HIGH_PROTEIN_KCAL_SHARE = 0.25
const HIGH_CARB_KCAL_SHARE = 0.55

/**
 * The absolute floors that keep the teas out. 5 g of protein per 100 g and
 * 15 g of carbohydrate per 100 g are both comfortably below any real dish of
 * that kind (Beetroot and Moong Dal Salad, the leanest row that still
 * qualifies as high-protein, carries 7.3 g) and comfortably above every
 * infusion in the table (the highest is 0.5 g).
 */
const HIGH_PROTEIN_MIN_G_PER_100G = 5
const HIGH_CARB_MIN_G_PER_100G = 15

export interface MacroProfileFilter {
  tag: MacroProfileTag
  /** Chip text. */
  label: string
  /** The rule in plain words, for the chip's tooltip — a dietitian should never have to guess what a filter did. */
  description: string
  matches: (recipe: MacroProfileInput) => boolean
}

/**
 * Add a filter by adding an entry. Deliberately just the two that were asked
 * for: a picker with eight chips is its own kind of unusable, and each one
 * needs its thresholds measured against the real distribution the way these
 * two were, not guessed.
 */
export const MACRO_PROFILE_FILTERS: readonly MacroProfileFilter[] = [
  {
    tag: "high_protein",
    label: "High protein",
    description: "At least 25% of calories from protein, and at least 5 g protein per 100 g.",
    matches: (r) =>
      r.kcalPer100G > 0 &&
      r.proteinPer100G >= HIGH_PROTEIN_MIN_G_PER_100G &&
      (r.proteinPer100G * 4) / r.kcalPer100G >= HIGH_PROTEIN_KCAL_SHARE,
  },
  {
    tag: "high_carb",
    label: "High carb",
    description: "At least 55% of calories from carbohydrate, and at least 15 g carbohydrate per 100 g.",
    matches: (r) =>
      r.kcalPer100G > 0 &&
      r.carbsPer100G >= HIGH_CARB_MIN_G_PER_100G &&
      (r.carbsPer100G * 4) / r.kcalPer100G >= HIGH_CARB_KCAL_SHARE,
  },
]

/** Every tag this recipe earns. A dish can hold more than one — 7 rows are both. */
export function macroProfileTags(recipe: MacroProfileInput): MacroProfileTag[] {
  return MACRO_PROFILE_FILTERS.filter((f) => f.matches(recipe)).map((f) => f.tag)
}

/**
 * Selecting two chips means "high protein OR high carb", not AND.
 *
 * A dietitian ticking both is widening the search — looking at either kind —
 * not asking for the 7 dishes that happen to be both. Intersecting would show
 * almost nothing and read as a broken filter.
 */
export function matchesAnyTag(tags: MacroProfileTag[], selected: MacroProfileTag[]): boolean {
  if (selected.length === 0) return true
  return selected.some((s) => tags.includes(s))
}
