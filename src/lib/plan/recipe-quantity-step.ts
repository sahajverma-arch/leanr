/**
 * Stepping one plan item's quantity up or down, by hand, on the plan page.
 *
 * A dietitian does not think in grams for everything. "One more roti" is a
 * real instruction; "40 g more roti" is the same instruction translated into
 * a unit nobody cooks in. The recipe rows already carry what is needed to
 * honour the first phrasing: `unitLabel` + `perUnitGrams`, derived at
 * ingestion from the source CSV's own `Quantity per serving` and
 * `Wt. of Measured Amt.` columns (recipe-unit-label.ts). A real Jowar Roti
 * row is `piece` at 42 g; Wheat Bran Roti is `piece` at 60 g. So the step is
 * the recipe's own piece weight, not a constant 40 g guessed for all of them.
 *
 * Recipes with no countable unit (a curry, a dal, a shake) step in grams
 * instead. Every other ingested noun - "cup", "katori", "bowl", "glass", and
 * the long tail of stray words the source text left behind ("bhindi",
 * "chole", "'g") - is deliberately NOT treated as countable, exactly as
 * recipe-quantity-display.ts already decided for the same data: only "piece"
 * is reliably a discrete thing.
 *
 * Pure functions, no I/O. The grams this returns are written straight to the
 * item and LOCKED (see recipe-balancer.ts) - the dietitian's number is the
 * number, and the rest of the day is re-optimised around it.
 */

export interface SteppableItem {
  /** recipes.unitLabel - only "piece" is treated as countable. */
  unitLabel: string | null
  /** recipes.per_unit_grams - grams of ONE unitLabel. Null iff unitLabel is null. */
  perUnitGrams: number | null
  /** recipes.min_grams / max_grams - the row's own authored serving range. */
  minGrams: number
  maxGrams: number
}

/** Gram step for a recipe with no countable unit. Coarse on purpose: a dietitian nudges a curry by a spoon, not by a gram. */
export const GRAM_STEP = 25

/**
 * Hard ceiling on a hand-typed quantity, matching the 5-1000 g plausibility
 * envelope recipe-quantity-normalize.ts already applies at ingestion. The
 * authored `maxGrams` is deliberately NOT the ceiling: it is often only 2-3x
 * the ideal portion (real row: Jowar Roti, min 42 / max 126 - three rotis),
 * and a dietitian prescribing a fourth roti is making a clinical call, not a
 * mistake. Going past the authored range is allowed and flagged, never
 * blocked - see describeQuantity().
 */
export const MANUAL_GRAMS_CEILING_G = 1000
/** Floor, same envelope. Below this it is not a served portion. */
export const MANUAL_GRAMS_FLOOR_G = 5

/** True when this recipe is counted in whole pieces rather than grams. */
export function isCountable(item: SteppableItem): boolean {
  return item.unitLabel === "piece" && item.perUnitGrams !== null && item.perUnitGrams > 0
}

/** How many grams one press of +/- moves this item. */
export function stepGrams(item: SteppableItem): number {
  return isCountable(item) ? item.perUnitGrams! : GRAM_STEP
}

function clamp(grams: number): number {
  return Math.min(MANUAL_GRAMS_CEILING_G, Math.max(MANUAL_GRAMS_FLOOR_G, grams))
}

/**
 * The quantity one step up (+1) or down (-1) from `grams`.
 *
 * For a countable recipe the result is always a WHOLE number of pieces, even
 * when the current grams are not - generation optimises freely inside the
 * serving range and rounds to a 5 g grid, so a real plated item is routinely
 * 125 g of a 42 g roti (2.98 pieces). Stepping up from there gives 3 pieces,
 * not 3.98: the first press snaps to the grid, which is what "one more roti"
 * means when you are looking at "125 g" on the page.
 */
export function steppedGrams(item: SteppableItem, grams: number, direction: 1 | -1): number {
  if (isCountable(item)) {
    const per = item.perUnitGrams!
    const pieces = grams / per
    // Snap first, then step - but only when the snap actually moves in the
    // requested direction, otherwise the press would do nothing.
    const snapped = direction === 1 ? Math.ceil(pieces - 1e-9) : Math.floor(pieces + 1e-9)
    const next = snapped === pieces ? snapped + direction : snapped
    return clamp(Math.max(1, next) * per)
  }
  return clamp(Math.round((grams + direction * GRAM_STEP) / GRAM_STEP) * GRAM_STEP)
}

export interface QuantityDescription {
  /** What the dietitian is setting, in their own words: "3 pieces (126 g)" or "180 g". */
  label: string
  /** Whole pieces, when countable. Null otherwise. */
  pieces: number | null
  /** Set when this quantity sits outside the recipe's own authored serving range - allowed, but worth saying. */
  outsideRangeNote: string | null
}

export function describeQuantity(item: SteppableItem, grams: number): QuantityDescription {
  const rounded = Math.round(grams)
  let label = `${rounded} g`
  let pieces: number | null = null

  if (isCountable(item)) {
    const exact = grams / item.perUnitGrams!
    // Only call it a piece count when it genuinely is one. A 125 g leftover
    // from generation is not "3 pieces", and saying so would be a fabricated
    // number on a clinical document.
    if (Math.abs(exact - Math.round(exact)) < 0.02 && Math.round(exact) >= 1) {
      pieces = Math.round(exact)
      label = `${pieces} ${pieces === 1 ? "piece" : "pieces"} (${rounded} g)`
    }
  }

  let outsideRangeNote: string | null = null
  if (rounded > item.maxGrams) {
    outsideRangeNote = `Above this recipe's usual serving range (up to ${Math.round(item.maxGrams)} g).`
  } else if (rounded < item.minGrams) {
    outsideRangeNote = `Below this recipe's usual serving range (from ${Math.round(item.minGrams)} g).`
  }

  return { label, pieces, outsideRangeNote }
}

export interface MacroImpact {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  fiberG: number
}

/** Per-100g figures times grams. The one arithmetic the edit UI does, kept here so the dialog and the server agree on it. */
export function macrosAtGrams(per100G: MacroImpact, grams: number): MacroImpact {
  const f = grams / 100
  return {
    kcal: per100G.kcal * f,
    proteinG: per100G.proteinG * f,
    carbsG: per100G.carbsG * f,
    fatG: per100G.fatG * f,
    fiberG: per100G.fiberG * f,
  }
}

/**
 * What changing this item does to the day, before it is saved.
 *
 * Deliberately the item's OWN delta, not a prediction of the day's final
 * totals: every edit re-balances the whole day, so the other items will move
 * too and any "the day will be X kcal" figure shown here would be a guess.
 * The honest thing to show is the direct impact, which is exactly what was
 * asked for - how much protein/carbs/fat this change adds or removes.
 */
export function macroDelta(from: MacroImpact, to: MacroImpact): MacroImpact {
  return {
    kcal: to.kcal - from.kcal,
    proteinG: to.proteinG - from.proteinG,
    carbsG: to.carbsG - from.carbsG,
    fatG: to.fatG - from.fatG,
    fiberG: to.fiberG - from.fiberG,
  }
}
