/**
 * Derives realistic min/max/ideal gram serving limits from the recipe CSV's
 * own authored serving data — unit-agnostic by construction, never parses
 * WHAT a unit ("Cup", "tikki", "gm") means, only the numeric ratio between
 * `Wt. of Measured Amt.` (grams — profiled directly: always present, 0
 * blanks across 1224 real rows, always a clean "NNNgm"/"NNNml" pattern) and
 * `Quantity per serving`'s own leading number (messier free text — 8 blank
 * rows, occasional ranges like "2-3 egg whites", one literal "-"
 * placeholder — profiled directly before writing this).
 *
 *   perUnitGrams = Wt.of Measured Amt. (grams) / Quantity per serving (number)
 *   minGrams = Min Quantity * perUnitGrams
 *   maxGrams = MAXIMUM QUANTITY * perUnitGrams
 *   idealGrams = Wt.of Measured Amt. itself — the recipe's own authored
 *     typical portion, used as the balancer's starting point (x0).
 *
 * Anything that fails to parse or lands outside a plausibility envelope
 * drops to a category-default fallback table, recorded via
 * serving_limits_source so a dietitian can audit which recipes are running
 * on a guessed portion — never silent.
 */

import { recipeCategoryBucket, type RecipeCategoryBucket } from "@/lib/plan/recipe-category"

import type { RawRecipeRow } from "./recipe-csv-parser"

export interface ServingLimits {
  minGrams: number
  maxGrams: number
  idealGrams: number
  source: "computed" | "fallback_category_default"
  flags: string[]
}

const PLAUSIBLE_GRAMS_RANGE = { min: 5, max: 1000 }

const CATEGORY_DEFAULT_LIMITS: Record<RecipeCategoryBucket, { min: number; max: number; ideal: number }> = {
  heavy_meal: { min: 250, max: 450, ideal: 350 },
  light_meal: { min: 150, max: 300, ideal: 220 },
  sabzi: { min: 100, max: 250, ideal: 150 },
  dal_curry: { min: 150, max: 250, ideal: 200 },
  rice_pulao: { min: 100, max: 300, ideal: 200 },
  bread: { min: 30, max: 150, ideal: 60 },
  snack: { min: 30, max: 150, ideal: 80 },
  dessert: { min: 20, max: 100, ideal: 50 },
  salad: { min: 80, max: 200, ideal: 120 },
  soup: { min: 150, max: 300, ideal: 200 },
  beverage: { min: 100, max: 300, ideal: 200 },
  fruit: { min: 80, max: 200, ideal: 120 },
  other: { min: 50, max: 200, ideal: 100 },
}

function fallback(category: string, name: string, flags: string[]): ServingLimits {
  const bucket = recipeCategoryBucket(category, name)
  const d = CATEGORY_DEFAULT_LIMITS[bucket]
  return { minGrams: d.min, maxGrams: d.max, idealGrams: d.ideal, source: "fallback_category_default", flags }
}

/**
 * Leading number, optionally a range (midpoint) — "2" -> 2, "1 Cup" -> 1,
 * "2-3 egg whites" -> 2.5, "-" / "" -> null. With `fractions`, also
 * "3/4 cup" -> 0.75 and "1 1/2 cup" -> 1.5; without, a fraction reads as its
 * numerator ("3/4" -> 3), the original behaviour.
 *
 * Fractions are read properly only where the serving text and the measuring
 * unit name the same vessel (see computeServingLimits). Applied to count and
 * spoon rows they turned "1/2 fruit" into a 500-1000 g mango and "1/4 cup
 * almond" into 300-600 g of almonds — those rows' serving text and Min/Max
 * are in different units, so no parse of the fraction makes them agree.
 */
export function extractLeadingNumber(raw: string, { fractions = false }: { fractions?: boolean } = {}): { value: number | null; wasRange: boolean } {
  const trimmed = raw.trim()
  if (!fractions) return extractLeadingWholeNumber(trimmed)
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/)
  if (mixed && Number(mixed[3]) > 0) return { value: Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]), wasRange: false }
  const fraction = trimmed.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  if (fraction && Number(fraction[2]) > 0) return { value: Number(fraction[1]) / Number(fraction[2]), wasRange: false }
  return extractLeadingWholeNumber(trimmed)
}

function extractLeadingWholeNumber(trimmed: string): { value: number | null; wasRange: boolean } {
  const rangeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/)
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1])
    const hi = parseFloat(rangeMatch[2])
    return { value: (lo + hi) / 2, wasRange: true }
  }
  const single = trimmed.match(/^(\d+(?:\.\d+)?)/)
  if (single) return { value: parseFloat(single[1]), wasRange: false }
  return { value: null, wasRange: false }
}

/** Same shape as extractLeadingNumber but strips a trailing gm/g/ml unit — "200ml" -> 200, "52 gm" -> 52, "150-200gm" -> 175 (midpoint). */
function extractGrams(raw: string): { value: number | null; wasRange: boolean } {
  const trimmed = raw.trim()
  const rangeMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:gm|g|ml)?/i)
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1])
    const hi = parseFloat(rangeMatch[2])
    return { value: (lo + hi) / 2, wasRange: true }
  }
  const single = trimmed.match(/^(\d+(?:\.\d+)?)\s*(?:gm|g|ml)?/i)
  if (single) return { value: parseFloat(single[1]), wasRange: false }
  return { value: null, wasRange: false }
}

const VESSELS = ["katori", "cup", "glass", "bowl", "plate"] as const

/** Which serving vessel a unit text names ("Medium Bowl" -> bowl), or null for counts, grams, spoons and anything else. */
function vesselOf(text: string): (typeof VESSELS)[number] | null {
  const t = text.toLowerCase()
  return VESSELS.find((v) => new RegExp(`\\b${v}s?\\b`).test(t)) ?? null
}

export function computeServingLimits(row: RawRecipeRow): ServingLimits {
  const flags: string[] = []

  const minRaw = row.minQuantityRaw
  const maxRaw = row.maximumQuantityRaw

  // Known stray case (e.g. "Bel Fruit": min="100" max="150gm") — if either
  // Min/Max Quantity cell itself carries a unit suffix, that's a strong
  // signal THIS row's Min/Max are already gram-denominated, not multiplier
  // counts. Handle as a special case, flagged for manual review.
  if (/[a-z]/i.test(minRaw) || /[a-z]/i.test(maxRaw)) {
    const min = extractGrams(minRaw).value
    const max = extractGrams(maxRaw).value
    flags.push(`Min/Max Quantity had a unit suffix ("${minRaw}"/"${maxRaw}") — treated as already-grams, review manually`)
    if (min != null && max != null) {
      const [lo, hi] = min <= max ? [min, max] : [max, min]
      return { minGrams: Math.round(lo), maxGrams: Math.round(hi), idealGrams: Math.round((lo + hi) / 2), source: "computed", flags }
    }
    return fallback(row.category, row.name, flags)
  }

  const minQty = Number(minRaw)
  const maxQty = Number(maxRaw)
  const qtyPerServing = extractLeadingNumber(row.quantityPerServingRaw)
  const wtOfMeasuredAmt = extractGrams(row.wtOfMeasuredAmtRaw)

  if (qtyPerServing.wasRange) flags.push(`Quantity per serving "${row.quantityPerServingRaw}" was a range — used midpoint`)
  if (wtOfMeasuredAmt.wasRange) flags.push(`Wt.of Measured Amt. "${row.wtOfMeasuredAmtRaw}" was a range — used midpoint`)

  if (
    !Number.isFinite(minQty) ||
    !Number.isFinite(maxQty) ||
    qtyPerServing.value == null ||
    qtyPerServing.value <= 0 ||
    wtOfMeasuredAmt.value == null
  ) {
    flags.push("Could not extract a usable Quantity-per-serving / Wt.of-Measured-Amt number")
    return fallback(row.category, row.name, flags)
  }

  // Min/Max Quantity count the `Is Measured In` unit ("1-1.5 Katori"), while
  // the serving text often names a different one ("3/4 cup"). Dividing a
  // katori count by a cup count mixes units. When the measuring unit is a
  // vessel the serving text does not name, one vessel is the authored serving.
  // When both name the same vessel, a fraction is a real fraction of it.
  const vessel = vesselOf(row.isMeasuredInRaw)
  const servingNamesVessel = vessel !== null && vesselOf(row.quantityPerServingRaw) === vessel
  const servingCount = servingNamesVessel ? (extractLeadingNumber(row.quantityPerServingRaw, { fractions: true }).value ?? qtyPerServing.value) : qtyPerServing.value
  const perUnitGrams = vessel !== null && !servingNamesVessel ? wtOfMeasuredAmt.value : wtOfMeasuredAmt.value / servingCount
  if (vessel !== null && !servingNamesVessel && qtyPerServing.value !== 1) {
    flags.push(`Serving "${row.quantityPerServingRaw}" is not in the measuring unit "${row.isMeasuredInRaw}" — one ${vessel} taken as the authored serving`)
  }
  let minGrams = minQty * perUnitGrams
  let maxGrams = maxQty * perUnitGrams
  if (minGrams > maxGrams) [minGrams, maxGrams] = [maxGrams, minGrams]

  // The balancer starts every dish at idealGrams and clamps it into
  // [min, max]; a starting point outside its own range is a contradiction.
  const idealGrams = Math.round(Math.min(Math.max(wtOfMeasuredAmt.value, minGrams), maxGrams))

  if (!Number.isFinite(minGrams) || !Number.isFinite(maxGrams) || minGrams < PLAUSIBLE_GRAMS_RANGE.min || maxGrams > PLAUSIBLE_GRAMS_RANGE.max) {
    flags.push(`Computed range ${minGrams.toFixed(0)}-${maxGrams.toFixed(0)}g fell outside the plausibility envelope`)
    return fallback(row.category, row.name, flags)
  }

  return { minGrams: Math.round(minGrams), maxGrams: Math.round(maxGrams), idealGrams, source: "computed", flags }
}
