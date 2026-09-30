/**
 * Keeps foods a client has said they must not, or will not, eat off their
 * plate — judged on the DISH'S OWN EVIDENCE, not only its allergen label.
 *
 * WHY THIS EXISTS. A vegetarian client wrote "Soya chunks" in q36 ("which
 * foods do you dislike, avoid or never want included?") and was served Soya
 * Matar Sabzi twice in one week, plus Tofu Bhurji and Tofu Do Pyaza
 * (2026-09-30). Two independent gaps:
 *   1. The recipe engine never read q36 at all.
 *   2. Even a declared soy ALLERGY could not have excluded those dishes: the
 *      CSV's Allergen column never tags soy or sesame (Soya Matar Sabzi's
 *      only tag is onion_garlic), so the recipe-side mapping was left empty.
 * The same shape as the fish-labelled-vegetarian bug (recipe-animal-content.ts),
 * fixed the same way: the dish's own name — and at ingestion, its ingredient
 * list — can supply the tag the source column forgot.
 *
 * Two kinds of avoidance, deliberately treated differently:
 *   - ALLERGEN TAGS (q27 "Allergy — never serve"): matched against the
 *     stored tags plus name evidence at runtime; ingestion also adds tags
 *     from ingredient text, so soy sauce hidden in a noodle dish is caught
 *     after a reseed.
 *   - AVOID TERMS (q36 dislikes, and a q27 "Other" allergy's free-text name):
 *     matched against the dish NAME only. A client who dislikes soya chunks
 *     does not need a splash of soy sauce taken out of a stir-fry, and an
 *     arbitrary free-text word scanned across ingredient lists would
 *     over-match badly ("oil", "salt").
 *
 * Every match is whole-word and case-insensitive. A false positive costs one
 * dish out of ~1000; a false negative puts the food back on the plate.
 *
 * Pure functions, zero I/O.
 */

// ---------------------------------------------------------------------------
// Allergen evidence the CSV's Allergen column does not carry
// ---------------------------------------------------------------------------

const SOY_WORDS = [
  "soy", "soya", "soyabeans?", "soybeans?", "soya beans?", "soy beans?", "nutri", "nutrela", "tofu", "edamame",
  "tempeh", "miso",
]
const SESAME_WORDS = ["sesame", "til", "gingelly", "tahini", "hummus"]

function wordPattern(words: readonly string[]): RegExp {
  return new RegExp(`\\b(${words.join("|")})\\b`, "i")
}

const ALLERGEN_EVIDENCE: { tag: string; re: RegExp }[] = [
  { tag: "soy", re: wordPattern(SOY_WORDS) },
  { tag: "sesame", re: wordPattern(SESAME_WORDS) },
]

/** Allergen tags a piece of free text (a dish name, or an ingredient list) is evidence for. */
export function allergenTagsFromText(text: string): string[] {
  return ALLERGEN_EVIDENCE.filter(({ re }) => re.test(text)).map(({ tag }) => tag)
}

/**
 * A recipe's stored allergen tags plus what its own name is evidence for.
 * The runtime has no ingredient text (see recipe-ingredient-text.ts), so
 * ingredient evidence is folded into the stored tags at ingestion instead.
 */
export function effectiveRecipeAllergenTags(recipe: { name: string; allergenTags: readonly string[] }): string[] {
  return [...new Set([...recipe.allergenTags, ...allergenTagsFromText(recipe.name)])]
}

// ---------------------------------------------------------------------------
// Free-text avoid terms
// ---------------------------------------------------------------------------

/**
 * A food a client can name in several ways, and the words a dish name uses
 * for it. `triggers` is matched against what the dietitian TYPED; `nameWords`
 * against the dish name. Only families where the synonyms are unambiguous
 * are listed — anything else falls through to a literal whole-word match of
 * the typed term, which is still correct, just narrower.
 *
 * Soy covers tofu: tofu is soya, and a client who does not want soya should
 * not be handed a tofu bhurji. The reverse is not true — "tofu" alone
 * excludes only tofu.
 */
const FOOD_FAMILIES: { triggers: RegExp; nameWords: string[]; exclusive?: boolean }[] = [
  // Soya CHUNKS (nutri/nutrela and the dishes made from them) are a different
  // food from tofu or edamame, and a real client's counsellor wrote exactly
  // that: "Soya chunks. Tofu and edamame is fine". In an Indian dish name a
  // bare "Soya" means chunks or granules unless it says bean, milk or sauce.
  // `exclusive` stops the broader soy family below from also applying.
  {
    triggers: wordPattern(["soya? chunks?", "soya? granules?", "soya? badi", "soya? keema", "nutri", "nutrela", "meal maker"]),
    nameWords: ["soya(?!\\s*(?:beans?|milk|sauce|dal))", "soy chunks?", "nutri", "nutrela", "meal maker"],
    exclusive: true,
  },
  { triggers: wordPattern(["soy", "soya", "soyabeans?", "soybeans?"]), nameWords: SOY_WORDS },
  { triggers: wordPattern(["tofu"]), nameWords: ["tofu"] },
  { triggers: wordPattern(["paneer", "cottage cheese"]), nameWords: ["paneer", "cottage cheese"] },
  { triggers: wordPattern(["mushrooms?", "khumb"]), nameWords: ["mushrooms?", "khumb"] },
  {
    triggers: wordPattern(["brinjal", "baingan", "baigan", "begun", "eggplant", "aubergine", "vangi", "ringan"]),
    nameWords: ["brinjal", "baingan", "baigan", "begun", "eggplant", "aubergine", "vangi", "ringan", "bharta"],
  },
  {
    triggers: wordPattern(["lauki", "bottle gourd", "doodhi", "dudhi", "ghiya", "ghia"]),
    nameWords: ["lauki", "bottle gourd", "doodhi", "dudhi", "ghiya", "ghia", "sorakaya"],
  },
  { triggers: wordPattern(["karela", "bitter gourd"]), nameWords: ["karela", "bitter gourd", "kakarakaya", "pavakkai"] },
  {
    triggers: wordPattern(["bhindi", "okra", "lady ?fingers?", "ladies ?fingers?"]),
    nameWords: ["bhindi", "okra", "lady ?fingers?", "ladies ?fingers?", "bhinda", "bendakaya"],
  },
  { triggers: wordPattern(["tinda", "round gourd"]), nameWords: ["tinda", "round gourd"] },
  { triggers: wordPattern(["arbi", "arvi", "colocasia", "taro"]), nameWords: ["arbi", "arvi", "colocasia", "taro"] },
  {
    triggers: wordPattern(["tori", "turai", "torai", "ridge gourd"]),
    nameWords: ["tori", "turai", "torai", "ridge gourd", "beerakaya", "turiya"],
  },
  { triggers: wordPattern(["cauliflower", "phool gobi", "gobhi"]), nameWords: ["cauliflower", "gobi", "gobhi"] },
  { triggers: wordPattern(["cabbage", "patta gobi", "band gobi", "bandh gobi"]), nameWords: ["cabbage", "patta gobi", "band gobi", "bandh gobi"] },
  { triggers: wordPattern(["palak", "spinach"]), nameWords: ["palak", "spinach"] },
  { triggers: wordPattern(["methi", "fenugreek"]), nameWords: ["methi", "fenugreek"] },
  { triggers: wordPattern(["pumpkin", "kaddu", "kaddoo"]), nameWords: ["pumpkin", "kaddu", "kaddoo"] },
  { triggers: wordPattern(["beetroot", "beet", "chukandar"]), nameWords: ["beetroot", "beet", "chukandar"] },
  { triggers: wordPattern(["radish", "mooli", "muli"]), nameWords: ["radish", "mooli", "muli"] },
  { triggers: wordPattern(["capsicum", "shimla mirch", "bell peppers?"]), nameWords: ["capsicum", "shimla mirch", "bell peppers?"] },
  { triggers: wordPattern(["rajma", "kidney beans?"]), nameWords: ["rajma", "kidney beans?"] },
  {
    triggers: wordPattern(["chickpeas?", "chole", "chhole", "kabuli chana", "white chana"]),
    nameWords: ["chickpeas?", "chole", "chhole", "kabuli chana", "white chana", "hummus"],
  },
  { triggers: wordPattern(["curd", "dahi", "yogh?urt"]), nameWords: ["curd", "dahi", "yogh?urt", "raita"] },
  { triggers: wordPattern(["eggs?", "anda", "omelett?e?s?"]), nameWords: ["eggs?", "anda", "omelett?e?s?", "akuri", "acuri"] },
  { triggers: wordPattern(["oats?"]), nameWords: ["oats?"] },
  { triggers: wordPattern(["dalia", "daliya", "broken wheat"]), nameWords: ["dalia", "daliya", "broken wheat"] },
]

// Answers that mean "nothing to avoid", and filler words that are not a food.
const NON_ANSWERS = new Set(["none", "nothing", "no", "na", "n/a", "nil", "nope", "not applicable", "no dislikes", "nothing specific"])
const FILLER = /\b(i|no|dont|don't|do not|does not|doesn't|not|like|likes|dislike|dislikes|hate|hates|avoid|avoids|never|want|eat|eats|much|very|any|all|kind of|type of|food|foods|items?|dishes|dish|stuff)\b/gi

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// A sentence that GRANTS something is not a dislike: "Tofu and edamame is
// fine" must never exclude tofu. The whole sentence is dropped.
const PERMISSION = /\b(is|are)\s+(fine|ok|okay|allowed)\b|\b(can|may)\s+(have|eat)\b|\bno\s+problem\b|\bis\s+not\s+a\s+problem\b/i

/**
 * Splits raw free-text answers into individual food terms. "Soya chunks and
 * paneer / lauki" is three terms. Split into sentences first, so a sentence
 * that permits a food ("Tofu and edamame is fine") can be dropped whole.
 */
export function splitAvoidTerms(raw: readonly string[]): string[] {
  return raw
    .flatMap((r) => r.split(/[.;\n]/))
    .filter((sentence) => !PERMISSION.test(sentence))
    .flatMap((r) => r.split(/[,/&]|\band\b|\bor\b/i))
    .map((s) => s.replace(/\(.*?\)/g, " ").replace(FILLER, " ").replace(/[^\p{L}\p{N}' -]/gu, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 3 && !NON_ANSWERS.has(s.toLowerCase()))
}

export interface CompiledAvoidTerm {
  /** What the dietitian typed, for the message shown when a dish is refused. */
  term: string
  re: RegExp
}

// Words that describe a FORM of a food rather than a different dish, so
// "soya chunks" or "lauki ki sabzi" still means the whole food. Anything else
// left over ("bhurji" in "paneer bhurji") names one specific dish.
const FORM_WORDS = /\b(chunks?|granules?|nuggets?|badi|bari|sabzi|sabji|subzi|subji|bhaji|curry|ki|ka|ke|wali|wala|raw|boiled|cooked|in any form)\b/gi

/**
 * Compile once per request, not once per recipe: a pool is ~1000 rows.
 *
 * A term that names a FOOD ("soya", "soya chunks", "lauki ki sabzi") takes
 * that food's whole family of names. A term that names one DISH ("paneer
 * bhurji") matches that dish only — a client who dislikes paneer bhurji has
 * not said anything about paneer curry, and for a vegetarian, dropping every
 * paneer dish would cost real protein. (A real client's "paneer bhurji" was
 * over-matched this way before 2026-09-30.) Anything else matches itself,
 * whole-word, singular or plural.
 */
export function compileAvoidTerms(raw: readonly string[]): CompiledAvoidTerm[] {
  return splitAvoidTerms(raw).map((term) => {
    const words = new Set<string>()
    for (const family of FOOD_FAMILIES) {
      if (!family.triggers.test(term)) continue
      const remainder = term
        .replace(new RegExp(family.triggers.source, "gi"), " ")
        .replace(FORM_WORDS, " ")
        .trim()
      if (remainder !== "") continue
      family.nameWords.forEach((w) => words.add(w))
      if (family.exclusive) break
    }
    if (words.size === 0) {
      // Both singular guesses for a plural: "porridges" -> "porridge", and
      // "tomatoes" -> "tomato". A double s ("grass") is not a plural.
      const lower = term.toLowerCase()
      const stems = /[^s]s$/.test(lower) ? [lower.slice(0, -1), ...(lower.endsWith("es") ? [lower.slice(0, -2)] : [])] : [lower]
      for (const stem of stems) words.add(`${escapeRegExp(stem).replace(/ /g, "\\s+")}(?:e?s)?`)
    }
    return { term, re: wordPattern([...words]) }
  })
}

/**
 * Why this recipe must not go to this client, or null if it may. The ONE
 * check every recipe-engine path uses — generation pool, plausibility
 * re-check, swap/add picker and its server-side write gate — so they cannot
 * disagree about what is offerable.
 */
export function recipeAvoidanceConflict(
  recipe: { name: string; allergenTags: readonly string[] },
  clientAllergenTags: readonly string[],
  avoidTerms: readonly CompiledAvoidTerm[]
): string | null {
  if (clientAllergenTags.length > 0) {
    const allergen = effectiveRecipeAllergenTags(recipe).find((t) => clientAllergenTags.includes(t))
    if (allergen) return `contains ${allergen}, a declared allergen`
  }
  const avoided = avoidTerms.find(({ re }) => re.test(recipe.name))
  if (avoided) return `matches "${avoided.term}", which this client avoids`
  return null
}
