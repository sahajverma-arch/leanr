/**
 * Resolves the LLM's (or fallback's) raw recipe names into real `recipes`
 * rows — the model's own arithmetic is never trusted, and neither is its
 * spelling: every name is resolved through a tiered chain before anything
 * downstream (recipe-balancer.ts) computes a single gram.
 *
 *   exact -> alias -> parenthetical-stripped exact/alias -> base-name ->
 *   unique-prefix -> fuzzy (Levenshtein, 0.82 floor + a minimum margin over
 *   the runner-up) -> null
 *
 * The final `null` is the explicit seam for a deferred v2 embedding-search
 * tier (see CLAUDE.md "The recipe engine") — not implemented here. A null
 * resolution is dropped and warned by the caller, never silently
 * mis-counted (same UnknownFoodError-adjacent philosophy elsewhere in this
 * codebase, non-fatal to the whole generation).
 */



import type { GroundedRecipeDay, GroundedRecipeMeal, RecipeAchievedMacros, RecipeForPipeline as Recipe, RecipeSelection, SelectedRecipeMeal } from "./recipe-types"

export interface RecipeIndex {
  byExact: Map<string, Recipe>
  byAlias: Map<string, Recipe>
  byBase: Map<string, Recipe>
  all: Recipe[]
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

function stripParenthetical(name: string): string {
  return name
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

export function buildRecipeIndex(recipeRows: Recipe[], aliasRows: { recipeId: string; alias: string }[]): RecipeIndex {
  const byExact = new Map<string, Recipe>()
  const byBase = new Map<string, Recipe>()
  for (const r of recipeRows) {
    byExact.set(normalizeKey(r.name), r)
    const base = normalizeKey(stripParenthetical(r.name))
    if (!byBase.has(base)) byBase.set(base, r)
  }
  const byId = new Map(recipeRows.map((r) => [r.id, r]))
  const byAlias = new Map<string, Recipe>()
  for (const a of aliasRows) {
    const recipe = byId.get(a.recipeId)
    if (recipe) byAlias.set(normalizeKey(a.alias), recipe)
  }
  return { byExact, byAlias, byBase, all: recipeRows }
}

const FUZZY_SIMILARITY_FLOOR = 0.82
const FUZZY_MIN_MARGIN = 0.05

export function resolveRecipe(index: RecipeIndex, rawName: string): Recipe | null {
  const key = normalizeKey(rawName)
  if (index.byExact.has(key)) return index.byExact.get(key)!
  if (index.byAlias.has(key)) return index.byAlias.get(key)!

  const strippedKey = normalizeKey(stripParenthetical(rawName))
  if (strippedKey !== key) {
    if (index.byExact.has(strippedKey)) return index.byExact.get(strippedKey)!
    if (index.byAlias.has(strippedKey)) return index.byAlias.get(strippedKey)!
  }

  if (index.byBase.has(strippedKey)) return index.byBase.get(strippedKey)!

  const prefixMatches = index.all.filter((r) => {
    const rName = normalizeKey(r.name)
    return rName.startsWith(key) || key.startsWith(rName)
  })
  if (prefixMatches.length === 1) return prefixMatches[0]

  let best: { recipe: Recipe; score: number } | null = null
  let second = 0
  for (const r of index.all) {
    const score = similarity(key, normalizeKey(r.name))
    if (!best || score > best.score) {
      second = best?.score ?? 0
      best = { recipe: r, score }
    } else if (score > second) {
      second = score
    }
  }
  if (best && best.score >= FUZZY_SIMILARITY_FLOOR && best.score - second >= FUZZY_MIN_MARGIN) {
    return best.recipe
  }

  return null
}

export function computeMealsTotals(meals: GroundedRecipeMeal[]): RecipeAchievedMacros {
  let kcal = 0
  let proteinG = 0
  let carbsG = 0
  let fatG = 0
  let fiberG = 0
  for (const meal of meals) {
    for (const item of meal.items) {
      const factor = item.grams / 100
      kcal += item.recipe.kcalPer100G * factor
      proteinG += item.recipe.proteinPer100G * factor
      carbsG += item.recipe.carbsPer100G * factor
      fatG += item.recipe.fatPer100G * factor
      fiberG += item.recipe.fiberPer100G * factor
    }
  }
  return { kcal, proteinG, carbsG, fatG, fiberG }
}

function groundMeal(meal: SelectedRecipeMeal, index: RecipeIndex, unknownRecipeNames: string[]): GroundedRecipeMeal {
  const items = []
  for (const item of meal.items) {
    const recipe = resolveRecipe(index, item.name)
    if (!recipe) {
      unknownRecipeNames.push(item.name)
      continue
    }
    items.push({ recipe, grams: recipe.idealGrams })
  }
  return { slot: meal.slot, items }
}

export function groundSelection(selection: RecipeSelection, index: RecipeIndex): { days: GroundedRecipeDay[] } {
  const days: GroundedRecipeDay[] = selection.days.map((day) => {
    const unknownRecipeNames: string[] = []
    const meals = day.meals.map((meal) => groundMeal(meal, index, unknownRecipeNames))
    return {
      dayIndex: day.dayIndex,
      meals,
      totals: computeMealsTotals(meals),
      cappedRecipeNames: [],
      unknownRecipeNames,
    }
  })
  return { days }
}
