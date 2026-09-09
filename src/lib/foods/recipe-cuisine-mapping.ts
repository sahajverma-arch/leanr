/**
 * Normalizes the recipe CSV's real `Cuisine` column (15 distinct raw
 * values, profiled directly: General 762, North Indian 184, South Indian
 * 76, Maharashtrian 60, Bengali 52, Italian 23, Gujarati 17, Chinese 17,
 * Mediterranean 13, Mexican 7, Exotic 7, Gujrati [typo] 2, Parsi 2,
 * Japanese 1, Goan 1).
 *
 * Per the confirmed decision: every cuisine outside the 5 known Indian
 * regional ones — Italian, Chinese, Mediterranean, Mexican, Exotic, Parsi,
 * Japanese, Goan, and any other unrecognized raw string — is relabeled to
 * "General" AT INGESTION, permanently folding it into the always-eligible
 * pool. This is a deliberate, one-way data-loss transformation: a recipe's
 * original non-Indian cuisine tag is only recoverable from `raw_csv_row`
 * afterward, never from `recipes.cuisine` itself.
 *
 * Punjabi/Rajasthani/Hyderabadi were added later (Dietitian Knowledge RAG
 * layer, see CLAUDE.md) to mirror the exchange engine's 9-value REGIONS —
 * confirmed the raw CSV's real 15-value distribution above has ZERO rows
 * tagged Punjabi or Rajasthani, and its one Hyderabadi occurrence is inside
 * a dish NAME ("Hyderabadi Biryani"), not the Cuisine column. Widening
 * these three is therefore safe (eligibleCuisinesFor() always folds in
 * "General", so nothing can resolve to zero recipes) but does NOT unlock a
 * native recipe pool for them — they draw from the same General pool as
 * before. The knowledge layer's docs for these three regions are the only
 * region-specific signal in the whole recipe-engine pipeline for them.
 */

import type { REGIONS } from "./vocab"

export const RECIPE_CUISINES = [
  "General",
  "North Indian",
  "South Indian",
  "Maharashtrian",
  "Bengali",
  "Gujarati",
  "Punjabi",
  "Rajasthani",
  "Hyderabadi",
] as const
export type RecipeCuisine = (typeof RECIPE_CUISINES)[number]

const RAW_CUISINE_SYNONYMS: Record<string, RecipeCuisine> = { Gujrati: "Gujarati" }

const KNOWN_REGIONAL_CUISINES = new Set<RecipeCuisine>([
  "North Indian",
  "South Indian",
  "Maharashtrian",
  "Bengali",
  "Gujarati",
  "Punjabi",
  "Rajasthani",
  "Hyderabadi",
])

export function normalizeCuisine(raw: string): RecipeCuisine {
  const cleaned = (RAW_CUISINE_SYNONYMS[raw.trim()] ?? raw.trim()) as RecipeCuisine
  return KNOWN_REGIONAL_CUISINES.has(cleaned) ? cleaned : "General"
}

/**
 * Cuisines that should also draw on a broader PARENT regional cuisine, on
 * top of the universal "General" fallback every request already gets.
 *
 * Punjabi is the case this exists for. The source CSV has zero rows tagged
 * Punjabi (profiled directly — see the 15-value distribution above), so a
 * Punjabi request resolved to the General pool alone. That pool excludes
 * every dish that actually IS the Punjabi canon, because they carry the
 * North Indian tag instead: Rajma Curry, White Chana Curry, Kala Chana
 * Curry, Kadhi Without Pakoda, Dum Aloo. A real generated Punjabi week was
 * left with 3 Dal and 2 Curry recipes in total.
 *
 * A direct dietitian instruction resolved it: a Punjabi plan may draw on
 * North Indian as well. That is a culinary containment fact — Punjabi is a
 * North Indian regional cuisine — not an inference from thin data, which is
 * why it is encoded as a relationship here rather than by retagging recipe
 * rows (retagging would wrongly claim those dishes are *exclusively*
 * Punjabi, and would be undone by the next CSV re-ingestion).
 *
 * Rajasthani was added next, on the same reasoning and the same explicit
 * instruction: it too has zero native rows, it too is a North Indian
 * regional cuisine, and its own canon (kadhi, besan/gram-flour preparations,
 * missi and makki roti, kala chana) carries the North Indian tag here.
 *
 * Deliberately NOT applied to Hyderabadi — the third cuisine with no native
 * rows — because it is a Deccan cuisine, so a North Indian parent would be
 * plain wrong rather than merely broad. If it ever needs widening, South
 * Indian is the defensible parent, and that is a separate decision with its
 * own grounding.
 */
const PARENT_CUISINES: Partial<Record<RecipeCuisine, readonly RecipeCuisine[]>> = {
  Punjabi: ["North Indian"],
  Rajasthani: ["North Indian"],
}

/** The cuisines a plan for `requested` may draw recipes from — itself, any parent regional cuisine, and always "General". */
export function eligibleCuisinesFor(requested: RecipeCuisine): RecipeCuisine[] {
  return [...new Set([requested, ...(PARENT_CUISINES[requested] ?? []), "General" as RecipeCuisine])]
}

/**
 * Which existing meal_templates.region row supplies slot skeleton (slot
 * name/order/timeHint ONLY — never kcalShare/allowedExchangeTypes, which
 * stay exchange-engine-only) for a given recipe cuisine. Slot timing isn't
 * cuisine-dependent (breakfast is ~8am regardless of cuisine) — this reuses
 * existing seeded infrastructure for pure scheduling, not a macro decision.
 */
export const CUISINE_TO_TEMPLATE_REGION: Partial<Record<RecipeCuisine, (typeof REGIONS)[number]>> = {
  "North Indian": "north_indian",
  "South Indian": "south_indian",
  Maharashtrian: "maharashtrian",
  Bengali: "bengali",
  Gujarati: "gujarati",
  Punjabi: "punjabi",
  Rajasthani: "rajasthani",
  Hyderabadi: "hyderabadi",
}

export const DEFAULT_TEMPLATE_REGION: (typeof REGIONS)[number] = "north_indian"

export function templateRegionForCuisine(cuisine: RecipeCuisine): (typeof REGIONS)[number] {
  return CUISINE_TO_TEMPLATE_REGION[cuisine] ?? DEFAULT_TEMPLATE_REGION
}

/**
 * The inverse: the cuisine a `region` corresponds to.
 *
 * Needed because the UI only ever sends `region` (the exchange engine's
 * vocabulary), while the recipe engine speaks in cuisines. Any region with no
 * cuisine of its own falls back to `"General"`, which is always eligible —
 * the same graceful widening `eligibleCuisinesFor()` already performs, so a
 * region can never resolve to an empty recipe pool.
 */
export function cuisineForTemplateRegion(region: (typeof REGIONS)[number]): RecipeCuisine {
  for (const [cuisine, mapped] of Object.entries(CUISINE_TO_TEMPLATE_REGION) as [RecipeCuisine, (typeof REGIONS)[number]][]) {
    if (mapped === region) return cuisine
  }
  return "General"
}
