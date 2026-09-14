/**
 * Normalizes the recipe CSV's real `Season` column — exactly 3 distinct
 * values, profiled directly: Winter 660, All Season 452, Summer 112. No
 * monsoon signal exists in this data at all.
 *
 * That last fact used to be recorded here as "an accepted narrowing": a
 * monsoon week simply drew from the All Season rows. Measured against a real
 * plan it is not acceptable at all. `season.ts` calls July-October monsoon —
 * four months of the year — and since no recipe can ever carry that tag, the
 * filter collapses to "all_year only" and silently hides everything else. On
 * a real North Indian non-vegetarian plan (week of 2026-09-09) that is 599 of
 * 1015 eligible dishes gone, 410 left in the swap picker instead of 1007.
 * Found because a dietitian could not find Acuri Eggs or Acv Chicken Sandwich
 * — both perfectly eligible, both tagged Winter.
 *
 * So the rule is now: a season the DATA CANNOT EXPRESS does not narrow
 * anything. See seasonNarrowsRecipePool() below. This is the same "degrade to
 * the unfiltered pool rather than return nothing" pattern used throughout the
 * exchange engine's own eligibility layers, and it is honest in the way the
 * old behaviour was not — claiming a Winter dish is wrong for a monsoon week
 * is a real claim, and this dataset never made it.
 */

import type { Season } from "./vocab"

const SEASON_MAP: Record<string, Season> = {
  Winter: "winter",
  Summer: "summer",
  "All Season": "all_year",
}

export function normalizeRecipeSeason(raw: string): { season: Season; unrecognized: boolean } {
  const mapped = SEASON_MAP[raw.trim()]
  return mapped ? { season: mapped, unrecognized: false } : { season: "all_year", unrecognized: true }
}

/**
 * The seasons this dataset can actually make a claim about — derived from
 * SEASON_MAP itself, not restated, so that a future CSV gaining a "Monsoon"
 * column value starts narrowing monsoon weeks with no other change here.
 * "all_year" is excluded: it is the wildcard, never a narrowing season.
 */
const NARROWING_SEASONS: ReadonlySet<Season> = new Set(
  Object.values(SEASON_MAP).filter((s) => s !== "all_year")
)

/** False when the derived season has no representation in the recipe data at all (today: monsoon). */
export function seasonNarrowsRecipePool(derivedSeason: Season): boolean {
  return NARROWING_SEASONS.has(derivedSeason)
}

/**
 * The one season-eligibility rule, shared by generation, swaps, adds and the
 * dev tools. It was previously the bare expression
 * `r.season === "all_year" || r.season === season`, copied at five call
 * sites — which is how four of the year's twelve months came to hide most of
 * the catalogue without anything reporting it.
 */
export function recipeSeasonMatches(recipeSeason: string, derivedSeason: Season): boolean {
  if (recipeSeason === "all_year") return true
  if (!seasonNarrowsRecipePool(derivedSeason)) return true
  return recipeSeason === derivedSeason
}
