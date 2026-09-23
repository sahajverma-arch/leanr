/**
 * What a recipe's OWN evidence says about its animal content, and which diet
 * types that evidence therefore rules out — independently of the source
 * CSV's `Diet Pref` column.
 *
 * WHY THIS EXISTS. `Diet Pref` is hand-typed and was measurably wrong: 18
 * real fish/prawn/mutton dishes (Goan Fish Curry, Fish Tikka, Lau Chingri,
 * Mutton Kosha, ...) were labelled "VEGETARIAN" and several of those "VEGAN"
 * too, while the SAME row's Allergen column said "Fish, Seafood". Every
 * eligibility check trusted `recipes.diet_types` alone, so a vegetarian
 * client (Dhruti, 2026-09-23) was served fish on 6 of 7 days. Serving meat
 * or fish to a vegetarian is the worst error this product can make, so the
 * label is no longer trusted on its own: any independent signal of animal
 * content wins over it.
 *
 * Three independent signals, any ONE of which is enough:
 *   1. the recipe's allergen tags (fish / seafood / egg),
 *   2. its name (whole-word matches — "Veggies" is not egg, "Eggplant" is
 *      not egg, "Eggless" is not egg),
 *   3. its ingredient text, where the caller has it (ingestion and audit
 *      only — the runtime pipeline does not carry it).
 *
 * Deliberately one-directional: evidence can only REMOVE a diet type from a
 * recipe, never add one. A false positive costs one dish from a pool of
 * ~1000; a false negative puts meat on a vegetarian's plate.
 *
 * Pure functions, zero I/O.
 */

export interface AnimalContent {
  meat: boolean
  fish: boolean
  egg: boolean
  /** Human-readable evidence, e.g. `name: "fish"`, `allergen: seafood`. */
  reasons: string[]
}

// Whole-word, case-insensitive. Plurals are spelled out rather than
// guessed with a trailing `s?` on words where that would over-match.
const MEAT_WORDS = [
  "chicken", "mutton", "lamb", "goat", "pork", "beef", "bacon", "ham", "sausages?", "salami", "pepperoni",
  "turkey", "murgh", "murg", "gosht", "kheema", "liver", "kaleji", "nihari", "haleem", "tangdi", "gelatin",
  "gelatine",
]
// These name a dish that is meat by default, but has common vegetarian
// versions that always say so ("Nutri Keema", "Soya Keema", "Veg Seekh").
const QUALIFIED_MEAT_WORDS = ["keema", "seekh", "shami"]
// "Egg Keema" is minced egg, not meat — still egg, which the egg rule catches.
const VEG_QUALIFIERS = /\b(egg|eggs|anda|nutri|soya|soy|veg|veggie|vegetable|paneer|mushroom|tofu|rajma|chana|dal|lentil|jackfruit|kathal)\b/i

const FISH_WORDS = [
  "fish", "fishes", "macher", "machher", "maach", "mach", "ilish", "hilsa", "rui", "rohu", "katla", "pomfret",
  "surmai", "bangda", "mackerel", "salmon", "tuna", "sardines?", "anchovy", "anchovies", "basa", "tilapia", "cod",
  "bhetki", "bhekti", "mahi[- ]mahi", "prawns?", "shrimps?", "chingri", "jhinga", "kolambi", "crabs?", "lobsters?",
  "squid", "calamari", "oysters?", "mussels?", "clams?", "seafood", "meen", "chepala", "bombil",
]

const EGG_WORDS = ["eggs?", "egg whites?", "egg yolks?", "omelette", "omelettes", "omelet", "anda", "akuri", "acuri", "frittata", "shakshuka"]
// Phrases that mention egg while meaning its absence.
const EGG_NEGATIONS = /\b(eggless|egg[- ]free|without eggs?|no eggs?|egg replacer|egg substitute)\b/gi

function wordPattern(words: string[]): RegExp {
  return new RegExp(`\\b(${words.join("|")})\\b`, "i")
}

const MEAT_RE = wordPattern(MEAT_WORDS)
// Dairy from a goat is vegetarian; "goat" alone is meat.
const MEAT_NEGATIONS = /\bgoat(?:'s)? (cheese|milk|curd|yogurt|yoghurt)\b/gi
const QUALIFIED_MEAT_RE = wordPattern(QUALIFIED_MEAT_WORDS)
const FISH_RE = wordPattern(FISH_WORDS)
const EGG_RE = wordPattern(EGG_WORDS)

/** Scans one piece of free text (a name, or an ingredient list) for animal content. */
function scanText(text: string, source: "name" | "ingredients", into: AnimalContent): void {
  const meat = MEAT_RE.exec(text.replace(MEAT_NEGATIONS, " "))
  if (meat) {
    into.meat = true
    into.reasons.push(`${source}: "${meat[0]}"`)
  }
  const qualified = QUALIFIED_MEAT_RE.exec(text)
  // A veg qualifier only clears the qualified words, and only in a NAME —
  // an ingredient list naming both "soya" and "keema" could be either.
  if (qualified && !(source === "name" && VEG_QUALIFIERS.test(text))) {
    into.meat = true
    into.reasons.push(`${source}: "${qualified[0]}"`)
  }
  const fish = FISH_RE.exec(text)
  if (fish) {
    into.fish = true
    into.reasons.push(`${source}: "${fish[0]}"`)
  }
  const egg = EGG_RE.exec(text.replace(EGG_NEGATIONS, " "))
  if (egg) {
    into.egg = true
    into.reasons.push(`${source}: "${egg[0]}"`)
  }
}

export function detectRecipeAnimalContent(recipe: {
  name: string
  allergenTags: readonly string[]
  /** Free-text ingredient list, when the caller has one (ingestion/audit). */
  ingredientsText?: string | null
}): AnimalContent {
  const content: AnimalContent = { meat: false, fish: false, egg: false, reasons: [] }
  for (const tag of recipe.allergenTags) {
    if (tag === "fish" || tag === "seafood") {
      content.fish = true
      content.reasons.push(`allergen: ${tag}`)
    }
    if (tag === "egg") {
      content.egg = true
      content.reasons.push(`allergen: ${tag}`)
    }
  }
  scanText(recipe.name, "name", content)
  if (recipe.ingredientsText) scanText(recipe.ingredientsText, "ingredients", content)
  return content
}

/**
 * The diet types a recipe's own evidence still permits, as a subset of what
 * it was labelled with — never a superset.
 *
 * - meat or fish -> non_vegetarian only
 * - egg          -> eggetarian and non_vegetarian only
 * - lactose tag  -> not vegan (dairy)
 * - onion/garlic tag -> not jain
 *
 * The last two are the same class of error (a label the row's own allergen
 * column contradicts) and are corrected by the same rule.
 */
export function evidenceSafeDietTypes(
  labelled: readonly string[],
  recipe: { name: string; allergenTags: readonly string[]; ingredientsText?: string | null }
): string[] {
  const content = detectRecipeAnimalContent(recipe)
  let allowed: Set<string> | null = null
  if (content.meat || content.fish) allowed = new Set(["non_vegetarian"])
  else if (content.egg) allowed = new Set(["eggetarian", "non_vegetarian"])

  return labelled.filter((d) => {
    if (allowed && !allowed.has(d)) return false
    if (d === "vegan" && recipe.allergenTags.includes("lactose")) return false
    if (d === "jain" && recipe.allergenTags.includes("onion_garlic")) return false
    return true
  })
}

/**
 * THE eligibility test for "may this dish go to a client of this diet type".
 * Every recipe-engine path — the generation pool, the plausibility re-check,
 * the final write gate, the swap/add picker and its server-side re-check —
 * calls this rather than `recipe.dietTypes.includes(...)` directly, so the
 * stored label can never again be the only thing standing between a
 * vegetarian and a fish curry.
 */
export function isRecipeAllowedForDiet(
  recipe: { name: string; dietTypes: readonly string[]; allergenTags: readonly string[] },
  dietType: string
): boolean {
  return evidenceSafeDietTypes(recipe.dietTypes, recipe).includes(dietType)
}

/** True for a dish only a non-vegetarian (or, for egg, an eggetarian) may eat. */
export function isAnimalProteinRecipe(recipe: {
  name: string
  dietTypes: readonly string[]
  allergenTags: readonly string[]
}): boolean {
  return !isRecipeAllowedForDiet(recipe, "vegetarian")
}
