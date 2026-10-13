/**
 * Formats a recipe item's grams as a household portion measure.
 *
 * The vocabulary is a direct dietitian specification (the "Portion-size
 * reference"), previously implemented only in a hand-built presentation
 * page and never in the product itself — which is why generated PDFs
 * disagreed with it. Three tiers, in order:
 *
 *   1. A whole fruit that's genuinely eaten by the piece  -> "2 apples"
 *   2. A discrete countable item (dosa, idli, roti, cutlet) -> "3 pieces"
 *   3. Everything else (curry, dal, rice, chutney, salad)   -> container size
 *
 * Tier 3's scale, exactly as specified:
 *   spoonful <40g · small serving 40-100g · small bowl 100-200g ·
 *   bowl 200-300g · large bowl 300-450g · plate 450g+
 *
 * This REPLACES the earlier convention of echoing whatever unit noun the
 * source CSV happened to carry ("1 katori", "2 glasses", "2 rices"). That
 * was faithful to the ingested data but not to how a dietitian writes a
 * plan, and it produced real nonsense on some rows — "2 rices" for Kuttu
 * Kadhi With Samak Chawal, "6 pieces" for a 25 g-per-piece sushi.
 *
 * Grams are shown alongside the measure ("bowl, 205 g"), matching the
 * specification's own worked examples. This reverses an earlier
 * "grams are never shown alongside" choice, which was made back when the
 * label was always a self-anchoring count like "2 rotis"; a container word
 * on its own ("bowl") is not actionable without the gram figure behind it.
 */

export interface RecipeQuantityInput {
  name: string
  category: string
  unitLabel: string | null
  perUnitGrams: number | null
}

/**
 * The container-size scale, as specified. Ascending, first match wins;
 * the final bucket is open-ended so any gram figure lands somewhere.
 */
const CONTAINER_BUCKETS: { maxG: number; label: string }[] = [
  { maxG: 40, label: "spoonful" },
  { maxG: 100, label: "small serving" },
  { maxG: 200, label: "small bowl" },
  { maxG: 300, label: "bowl" },
  { maxG: 450, label: "large bowl" },
  { maxG: Infinity, label: "plate" },
]

/**
 * Fruits counted by the piece under their own name ("2 apples"), not by
 * container. Deliberately a short explicit list rather than something
 * inferred from the data, for two reasons found by profiling the real
 * ingested rows:
 *
 *  - Apple and Banana are both ingested as unitLabel "bowl" (150 g), so
 *    there is no per-row flag that already says "count this one by the
 *    piece" — the tier is a dietitian judgment about the food, not a
 *    property of the source data.
 *  - Generalising to every Fruit-category row is actively wrong: Grapes is
 *    ingested at 1 g per unit (-> "120 grapes"), and the mixed-fruit-bowl
 *    rows ("All-Season Mix Fruit Bowl") are bowls by definition.
 *
 * Green Apple is absent on purpose — it carries no per-unit weight at all
 * in this dataset, so it has no honest piece count and falls to tier 3.
 * Matched case-insensitively on the recipe's whole name.
 */
const WHOLE_FRUIT_BY_THE_PIECE = new Set(["apple", "banana"])

// Common Indian-recipe nouns whose plural isn't a plain "+s"/"+es" — kept
// small and only added to as real cases surface, not guessed exhaustively.
const IRREGULAR_PLURALS: Record<string, string> = {
  glass: "glasses",
  potato: "potatoes",
  tomato: "tomatoes",
  mango: "mangoes",
}

function pluralize(word: string, count: number): string {
  if (count === 1) return word
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word]
  if (word.endsWith("s")) return word
  if (/[xz]$/i.test(word) || /[cs]h$/i.test(word)) return `${word}es`
  return `${word}s`
}

// Chips, namkeen, roasted chana and nuts are eaten by the handful, never the
// spoon: a dietitian rejected "Banana Chips — spoonful, 40 g". Only the
// smallest bucket changes; chutneys, dips, spreads and seeds stay spoonfuls.
const HANDFUL_CATEGORIES = new Set(["snack", "nuts"])

// Drinks are served in a glass or a cup, not a bowl: a dietitian rejected
// "Lemon Water (bowl, 250 g)". Matched on the Category column, not on
// Consistency, which marks Kokum Sherbet, Aam Panna and the slushes "solid".
// Soups, rasam, oats-in-milk and porridge are NOT here: those are eaten from
// a bowl. Shown in ml (the source weighs drinks in ml, 1 ml = 1 g).
const CUP_DRINK_CATEGORIES = new Set(["tea", "coffee"])
const GLASS_DRINK_CATEGORIES = new Set([
  "morning water",
  "bedtime water",
  "water beverage",
  "beverage",
  "juice",
  "lassi",
  "shake",
  "smoothie",
  "flavoured milk",
  "spiced milk",
])

/** "glass, 250 ml" / "cup, 150 ml" for a drink, or null when the dish is not one. */
function drinkLabel(grams: number, category: string): string | null {
  const c = category.trim().toLowerCase()
  const vessel = CUP_DRINK_CATEGORIES.has(c) ? "cup" : GLASS_DRINK_CATEGORIES.has(c) ? "glass" : null
  if (vessel === null) return null
  const ml = `${Math.round(grams)} ml`
  if (grams < 60) return `shot, ${ml}`
  if (grams <= 350) return `${vessel}, ${ml}`
  const count = Math.round(grams / 250)
  return `${count} ${vessel === "glass" ? "glasses" : "cups"}, ${ml}`
}

function containerLabel(grams: number, category: string): string {
  const label = CONTAINER_BUCKETS.find((b) => grams <= b.maxG)!.label
  return label === "spoonful" && HANDFUL_CATEGORIES.has(category.trim().toLowerCase()) ? "small handful" : label
}

function gramsLabel(grams: number): string {
  return `${Math.round(grams)} g`
}

/** Never rounds down to zero — a real plated item is always at least one of whatever it's counted in. */
function pieceCount(grams: number, perUnitGrams: number): number {
  return Math.max(1, Math.round(grams / perUnitGrams))
}

/**
 * Always returns a label: unlike the previous implementation there is no
 * null "caller falls back to grams" path, because the container scale
 * covers any gram figure on its own.
 */
export function formatRecipeQuantity(recipe: RecipeQuantityInput, grams: number): string {
  const drink = drinkLabel(grams, recipe.category)
  if (drink !== null) return drink

  const perUnit = recipe.perUnitGrams
  const hasPerUnit = perUnit !== null && perUnit > 0

  if (hasPerUnit) {
    // Tier 1 — a whole fruit, counted under its own name.
    if (WHOLE_FRUIT_BY_THE_PIECE.has(recipe.name.trim().toLowerCase())) {
      const count = pieceCount(grams, perUnit)
      return `${count} ${pluralize(recipe.name.trim().toLowerCase(), count)}, ${gramsLabel(grams)}`
    }

    // Tier 1b — a Fruit row the source ALREADY counts by the piece (Mango,
    // Peach). Same tier, but the per-piece weight is the ingested one
    // rather than a judgment call, so no explicit list is needed; only the
    // noun is improved ("1 mango" over a bare "1 piece").
    if (recipe.category.trim().toLowerCase() === "fruit" && recipe.unitLabel === "piece") {
      const count = pieceCount(grams, perUnit)
      return `${count} ${pluralize(recipe.name.trim().toLowerCase(), count)}, ${gramsLabel(grams)}`
    }

    // Tier 2 — a discrete countable item. Only "piece" qualifies: every
    // other ingested noun ("cup", "katori", "glass", "bowl", "rice") is a
    // vessel or a stray word from the source text, and the specification
    // routes all of those through the container scale instead.
    if (recipe.unitLabel === "piece") {
      const count = pieceCount(grams, perUnit)
      return `${count} ${count === 1 ? "piece" : "pieces"}, ${gramsLabel(grams)}`
    }
  }

  // Tier 3 — container size.
  return `${containerLabel(grams, recipe.category)}, ${gramsLabel(grams)}`
}

/** The scale itself, for rendering the reference legend alongside a plan. */
export function portionSizeReferenceText(): string {
  return "Portion-size reference: spoonful <40 g (chips, nuts and dry snacks: small handful) · small serving 40-100 g · small bowl 100-200 g · bowl 200-300 g · large bowl 300-450 g · plate 450 g+. Drinks: glass (tea and coffee: cup), in ml."
}
