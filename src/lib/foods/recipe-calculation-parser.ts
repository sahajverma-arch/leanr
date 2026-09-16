/**
 * Parses the ingredient-level `Calculation` column out of
 * src/db/seed-data/recipe_ingredients.csv.
 *
 * That column is a machine-written audit trail left behind by whatever script
 * produced the source spreadsheet's nutrition. Every recipe spells out, per
 * ingredient, both the quantity-to-grams conversion and the macros those grams
 * contribute:
 *
 *   egg -> 2 x 50g = 100g | egg -> Carbs: 0.7, Protein: 12.6, Fat: 9.5, Fiber: 0, Energy: 138.7
 *   ghee -> 1'tsp = 5g    | ghee -> Carbs: 0, Protein: 0, Fat: 5, Fiber: 0, Energy: 45
 *   spinach leaf -> direct: 15g | spinach leaf -> Carbs: 0.54, ...
 *
 * So a unitary ingredient table already exists in this data - it is simply
 * trapped in a text field rather than being columns. Measured across all 1241
 * rows that carry it, it is also unusually clean: ZERO of 345 ingredients
 * disagree with themselves on kcal per 100 g, and ZERO of 348
 * (ingredient, unit) pairs disagree on grams. That is why this parser can
 * treat a later observation of an ingredient as confirmation rather than
 * conflict, and why nothing here has to guess.
 *
 * Three quantity shapes appear, and nothing else:
 *   "2 x 50g = 100g"  - a countable piece, 2 of them, 50 g each
 *   "1'tsp = 5g"      - a measured unit (tsp/tbsp/cup/ml)
 *   "direct: 15g"     - already grams, no conversion
 *
 * The source's OWN failures are also in the column as plain text
 * ("Ingredient not found in nutrition sheet:", "Unknown medium weight for:
 * cardamom", 'Invalid format: "NA"'). Those are reported as `problems`, never
 * silently skipped - a recipe that could not be fully costed must not look
 * identical to one that was.
 *
 * Pure functions, no I/O.
 */

/** The three quantity shapes the source uses. */
export type IngredientQuantityKind = "piece" | "measure" | "direct"

export interface ParsedIngredientLine {
  /** Lowercased ingredient name exactly as the source wrote it - the join key. */
  name: string
  kind: IngredientQuantityKind
  /** How many units. Null for "direct", which states grams outright. */
  count: number | null
  /** "piece" | "tsp" | "tbsp" | "cup" | "ml", or null for "direct". */
  unit: string | null
  /** Grams that ONE unit weighs. Null for "direct". */
  gramsPerUnit: number | null
  /** Total grams this ingredient contributes to the batch. */
  grams: number
  carbsG: number
  proteinG: number
  fatG: number
  fiberG: number
  kcal: number
}

export interface ParsedCalculation {
  ingredients: ParsedIngredientLine[]
  /** Fragments the source itself flagged, or that this parser could not read. */
  problems: string[]
}

const PIECE_RE = /^([\d.]+)\s*×\s*([\d.]+)\s*g\s*=\s*([\d.]+)\s*g$/
const MEASURE_RE = /^([\d.]+)'(\w+)\s*=\s*([\d.]+)\s*g$/
const DIRECT_RE = /^direct:\s*([\d.]+)\s*g$/
const MACRO_RE =
  /Carbs:\s*(-?[\d.]+),\s*Protein:\s*(-?[\d.]+),\s*Fat:\s*(-?[\d.]+),\s*Fiber:\s*(-?[\d.]+),\s*Energy:\s*(-?[\d.]+)/

/** A fragment with no "->" at all, or one the source wrote as its own error message. */
function isSourceError(fragment: string): boolean {
  return (
    /^Invalid format:/i.test(fragment) ||
    /^No input$/i.test(fragment) ||
    /^Unknown medium weight for:/i.test(fragment) ||
    /^Ingredient not found in nutrition sheet:/i.test(fragment)
  )
}

/**
 * Splits one recipe's `Calculation` cell into ingredient lines.
 *
 * Fragments are pipe-separated and arrive in pairs (quantity then macros) for
 * the same ingredient, so lines are accumulated into a map keyed by name and
 * emitted in first-seen order. An ingredient that never receives its macro
 * fragment is dropped from `ingredients` and reported in `problems` - a
 * half-parsed ingredient would silently understate the dish.
 */
export function parseCalculation(raw: string): ParsedCalculation {
  const problems: string[] = []
  const byName = new Map<string, Partial<ParsedIngredientLine> & { name: string }>()
  const order: string[] = []

  for (const fragment of (raw ?? "").split("|")) {
    const trimmed = fragment.trim()
    if (!trimmed) continue

    if (isSourceError(trimmed)) {
      problems.push(trimmed)
      continue
    }

    const arrow = trimmed.indexOf("→")
    if (arrow === -1) {
      problems.push(`unreadable fragment: ${trimmed}`)
      continue
    }

    const name = trimmed.slice(0, arrow).trim().toLowerCase()
    const rhs = trimmed.slice(arrow + 1).trim()
    if (!name) {
      problems.push(`fragment with no ingredient name: ${trimmed}`)
      continue
    }

    if (!byName.has(name)) {
      byName.set(name, { name })
      order.push(name)
    }
    const entry = byName.get(name)!

    const macro = MACRO_RE.exec(rhs)
    if (macro) {
      entry.carbsG = Number(macro[1])
      entry.proteinG = Number(macro[2])
      entry.fatG = Number(macro[3])
      entry.fiberG = Number(macro[4])
      entry.kcal = Number(macro[5])
      continue
    }

    const piece = PIECE_RE.exec(rhs)
    if (piece) {
      entry.kind = "piece"
      entry.count = Number(piece[1])
      entry.unit = "piece"
      entry.gramsPerUnit = Number(piece[2])
      entry.grams = Number(piece[3])
      continue
    }

    const measure = MEASURE_RE.exec(rhs)
    if (measure) {
      const count = Number(measure[1])
      const grams = Number(measure[3])
      entry.kind = "measure"
      entry.count = count
      entry.unit = measure[2].toLowerCase()
      entry.gramsPerUnit = count === 0 ? null : grams / count
      entry.grams = grams
      continue
    }

    const direct = DIRECT_RE.exec(rhs)
    if (direct) {
      entry.kind = "direct"
      entry.count = null
      entry.unit = null
      entry.gramsPerUnit = null
      entry.grams = Number(direct[1])
      continue
    }

    problems.push(`unreadable quantity for ${name}: ${rhs}`)
  }

  const ingredients: ParsedIngredientLine[] = []
  for (const name of order) {
    const e = byName.get(name)!
    const complete =
      e.kind !== undefined &&
      e.grams !== undefined &&
      e.carbsG !== undefined &&
      e.proteinG !== undefined &&
      e.fatG !== undefined &&
      e.fiberG !== undefined &&
      e.kcal !== undefined
    if (!complete) {
      problems.push(`incomplete ingredient (missing quantity or macros): ${name}`)
      continue
    }
    ingredients.push(e as ParsedIngredientLine)
  }

  return { ingredients, problems }
}

/**
 * Per-100g nutrition implied by one parsed line.
 *
 * The source states each ingredient's CONTRIBUTION at its own gram weight, so
 * the reusable per-100g figure is recovered by dividing. Lines under 10 g are
 * refused: the source rounds macros to 2 dp, so dividing a 5 g contribution up
 * to 100 g multiplies that rounding by 20 and manufactures precision the data
 * never had. A 10 g floor keeps the derived figure within the source's own
 * stated precision, and every ingredient in this dataset appears somewhere at
 * 10 g or more.
 */
export const MIN_GRAMS_FOR_PER_100G = 10

export interface IngredientPer100G {
  carbsG: number
  proteinG: number
  fatG: number
  fiberG: number
  kcal: number
}

export function per100GFrom(line: ParsedIngredientLine): IngredientPer100G | null {
  if (line.grams < MIN_GRAMS_FOR_PER_100G) return null
  const scale = 100 / line.grams
  return {
    carbsG: line.carbsG * scale,
    proteinG: line.proteinG * scale,
    fatG: line.fatG * scale,
    fiberG: line.fiberG * scale,
    kcal: line.kcal * scale,
  }
}
