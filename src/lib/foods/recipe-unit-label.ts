/**
 * Derives a natural serving unit (e.g. "roti", "cup", "katori") and its
 * gram weight from the same two columns recipe-quantity-normalize.ts
 * already reads (`Quantity per serving`, `Wt.of Measured Amt.`), plus
 * `Is Measured In?` as a fallback noun source. Real-data profiling before
 * writing this: the leading number always pairs with a trailing
 * adjective-then-noun phrase ("1 medium bowl", "1 small shot glass", "3
 * baby potato") — the noun that actually names the unit is the LAST word,
 * not the first, which a naive first-word split gets wrong.
 *
 * Deliberately conservative: recipes measured in "Grams" (real weight-based
 * portions like grilled chicken) get no natural unit at all — grams is
 * already the honest, correct display for those. Ingestion reports the
 * exact fallback count so the gap is visible, never silent.
 */

import type { RawRecipeRow } from "./recipe-csv-parser"

export interface RecipeUnit {
  /** e.g. "roti", "cup", "katori", "piece" — never pluralized here, that's a display-time concern. */
  unitLabel: string
  /** Grams (or ml, treated as grams) that ONE of unitLabel corresponds to. */
  perUnitGrams: number
}

function extractLeadingCount(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : null
}

function lastWord(text: string): string | null {
  const words = text
    .replace(/\([^)]*\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.length > 0 ? words[words.length - 1].toLowerCase() : null
}

/**
 * `PIECE_MEASURED_IN` values mean the source counted discrete items, not a
 * volume/vessel — these get displayed generically as "piece(s)" rather than
 * whatever specific noun ("roti", "laddu", "dosa") the free-text carried,
 * per the confirmed display convention (see recipe-quantity-display.ts).
 * Everything else ("Cup", "Katori", "Glass", "Bowl", "Tbsp", ...) keeps its
 * own specific noun.
 */
function isDiscretePieceUnit(measuredInRaw: string): boolean {
  return measuredInRaw.trim().toLowerCase() === "numbers"
}

export function deriveRecipeUnit(row: RawRecipeRow): RecipeUnit | null {
  const measuredIn = row.isMeasuredInRaw.trim()
  if (measuredIn.toLowerCase() === "grams") return null

  const qty = row.quantityPerServingRaw.trim()
  if (!qty || qty === "-") return null

  const wt = row.wtOfMeasuredAmtRaw.trim()
  const wtMatch = wt.match(/^(\d+(?:\.\d+)?)/)
  const wtValue = wtMatch ? parseFloat(wtMatch[1]) : null
  if (wtValue === null || wtValue <= 0) return null

  const pieces = isDiscretePieceUnit(measuredIn)
  // A piece-counted row needs no noun (it is shown as "pieces" anyway), and
  // a serving text that is only the noun ("roti") means one. Singhare Ki
  // Roti ("roti", 85 g), Mooli Paratha and Sattu Chilla ("1") had no piece
  // weight at all before this, so a plan could not say how many to make.
  const count = extractLeadingCount(qty) ?? (pieces ? 1 : null)
  if (count === null || count <= 0) return null

  const remainderAfterCount = qty.replace(/^\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*/, "")
  const remainderNoun = lastWord(remainderAfterCount)

  const noun = remainderNoun ?? (measuredIn && !pieces ? lastWord(measuredIn) : null)
  if (!noun && !pieces) return null

  const perUnitGrams = wtValue / count
  if (!Number.isFinite(perUnitGrams) || perUnitGrams <= 0) return null

  return { unitLabel: pieces ? "piece" : (noun as string), perUnitGrams }
}
