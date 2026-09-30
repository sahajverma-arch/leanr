/**
 * Normalizes the recipe CSV's free-text `Allergen` column (comma-separated,
 * 315 distinct raw combinations in the real file — a small number of
 * atomic concepts combined every which way, plus real casing/typo drift:
 * "CITRUS" vs "Citrus", "Onion/Garli" / "Onion/ garlic" vs "Onion/Garlic",
 * "Lactos" vs "Lactose", "cruciferous vegetable" vs "Cruciferous", and a
 * pervasive "Gluten, wheat"/"Gluten, Wheat" pairing that profiling
 * confirmed is the same concept duplicated, not two distinct tags — merged
 * into one "gluten" tag, per the confirmed decision to treat wheat/gluten
 * as a data-entry casing artifact, not two concepts). "Nut" and "Peanuts"
 * DO stay distinct (they co-occur as two separate tokens in the same cell
 * repeatedly, e.g. "Peanuts, Nut" — the source clearly treats them as
 * different allergens, matching dietplat's own ALLERGENS vocab already
 * having both `peanut` and `tree_nut`).
 *
 * Every atomic token below was read directly off the real distinct-value
 * profiling pass, not guessed.
 */

const RAW_TOKEN_SYNONYMS: Record<string, string> = {
  WHEAT: "GLUTEN",
  LACTOS: "LACTOSE",
  "ONION/GARLI": "ONION/GARLIC",
  "ONION/ GARLIC": "ONION/GARLIC",
  "CRUCIFEROUS VEGETABLE": "CRUCIFEROUS",
}

const KNOWN_ALLERGEN_TOKENS = new Set([
  "ONION/GARLIC",
  "LACTOSE",
  "CITRUS",
  "GLUTEN",
  "NUT",
  "PEANUTS",
  "APPLE/PEAR/MELON",
  "CRUCIFEROUS",
  "FISH",
  "SEAFOOD",
  "MUSHROOM",
  "BRINJAL",
  "SPICY FOOD",
  "YEAST",
  "COFFEE",
])

function normalizeToken(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase()
  if (!cleaned) return null
  return RAW_TOKEN_SYNONYMS[cleaned] ?? cleaned
}

function toTag(token: string): string {
  return token.toLowerCase().replace(/\//g, "_").replace(/ /g, "_")
}

export interface RecipeAllergenNormalization {
  tags: string[]
  unclassifiedTokens: string[]
}

export function normalizeRecipeAllergenTags(rawAllergen: string): RecipeAllergenNormalization {
  const tokens = rawAllergen
    .split(",")
    .map(normalizeToken)
    .filter((t): t is string => t !== null)
  const deduped = [...new Set(tokens)]

  const unclassifiedTokens = deduped.filter((t) => !KNOWN_ALLERGEN_TOKENS.has(t))
  const tags = deduped.filter((t) => KNOWN_ALLERGEN_TOKENS.has(t)).map(toTag)

  return { tags, unclassifiedTokens }
}

/**
 * Client-side q27 allergen labels (see client-profile-from-answers.ts) that
 * have a confident mapping onto this recipe engine's own tag vocabulary.
 * "Egg" maps to the "egg" tag, which the Allergen column never carries
 * itself — it's folded onto a recipe's allergen_tags at ingestion time from
 * classifyRecipeDietTypes()'s containsEgg flag instead (see
 * seed-recipes.ts), the actually-reliable signal for egg content. "Soy" and
 * "Sesame" have no row in this CSV's Allergen column at all, so their tags
 * come from the dish's own evidence instead — its name at runtime and its
 * ingredient list at ingestion (recipe-food-avoidance.ts). Until 2026-09-30
 * they were unmapped, and a declared soy allergy excluded nothing.
 */
export const CLIENT_ALLERGEN_LABEL_TO_RECIPE_TAGS: Record<string, string[]> = {
  Milk: ["lactose"],
  Curd: ["lactose"],
  Paneer: ["lactose"],
  Egg: ["egg"],
  Wheat: ["gluten"],
  Fish: ["fish", "seafood"],
  Shellfish: ["seafood"],
  Peanut: ["peanuts"],
  "Tree nuts": ["nut"],
  Onion: ["onion_garlic"],
  Garlic: ["onion_garlic"],
  Soy: ["soy"],
  Sesame: ["sesame"],
  "Spicy food": ["spicy_food"],
}
