import { getTableColumns } from "drizzle-orm"

import { recipes } from "@/db/schema"
import type { Recipe } from "@/db/schema"
import type { RecipeCuisine } from "@/lib/foods/recipe-cuisine-mapping"

import type { RetrievedDietPlanExample } from "./diet-plan-example-retrieval"
import type { DietType } from "./exchange-solver"
import type { RetrievedKnowledgeChunk } from "./knowledge-retrieval"
import type { AchievedMacros } from "./table-4-1"

/** AchievedMacros widened with fiber — a soft target, tracked and logged, never a hard reject-gate (see recipe-validate.ts). */
export interface RecipeAchievedMacros extends AchievedMacros {
  fiberG: number
}

export interface DailyRecipeTarget {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  fiberG: number
}

export interface MealSlotInfo {
  slot: string
  slotOrder: number
  timeHint: string | null
}

/**
 * Denormalized recipe row shape the recipe-selection layer needs — no
 * serving-limit columns, since the LLM never proposes grams. Used for both
 * the LLM prompt table (recipe-prompt.ts) and the deterministic fallback
 * selector's own reasoning (recipe-selector-fallback.ts) — the pairing
 * fields below are read by both.
 */
export interface RecipeForPrompt {
  id: string
  name: string
  category: string
  /** 'liquid' | 'solid' | null — see recipe-consistency-normalize.ts. Rendered in the prompt table as an extra guard against a soup/tea being picked as a meal's anchor. */
  consistency: string | null
  mainOrMid: "main" | "mid"
  cuisine: string
  macroCategory: string | null
  commonality: number
  /** Dietitian-authored pairing data — see recipe-pairing.ts. "Must have" is a hard plausibility gate; "good to have" is prompt-visible guidance only. */
  mustHaveCategories: string[]
  goodToHaveCategories: string[]
  mustHaveRecipeNames: string[]
  goodToHaveRecipeNames: string[]
  proteinPer100G: number
  carbsPer100G: number
  fatPer100G: number
  fiberPer100G: number
  kcalPer100G: number
}

/** A `recipes` row minus the audit-only `rawCsvRow` blob — see allRecipesById. */
export type RecipeForPipeline = Omit<Recipe, "rawCsvRow">

export interface RecipeSelectorInput {
  cuisine: RecipeCuisine
  dietType: DietType
  mealCount: number
  dailyTarget: DailyRecipeTarget
  slots: MealSlotInfo[]
  eligibleRecipesForPrompt: RecipeForPrompt[]
  /**
   * Every field the pipeline actually reads. Excludes `rawCsvRow`, which is
   * an audit-only column: 46% of a 1.5 MB query payload that no runtime code
   * path ever reads, fetched cross-region on every generation.
   */
  allRecipesById: Map<string, RecipeForPipeline>
  eligibleCuisines: RecipeCuisine[]
  clientAllergenTags: string[]
  /** recipe_aliases rows for the eligible pool — grounding's alias tier. */
  aliasRows: { recipeId: string; alias: string }[]
  dayIndexOffset?: number
  previousWeekLastDayRecipeNames?: Record<string, string[]>
  /** Dietitian Knowledge RAG layer's retrieved chunks (gated by DIETITIAN_KNOWLEDGE_ENABLED) — descriptive prompt text only, never a number. See CLAUDE.md "Dietitian knowledge layer". */
  knowledgeChunks?: RetrievedKnowledgeChunk[]
  /** Diet Plan Examples RAG layer's retrieved examples (gated by DIET_PLAN_EXAMPLES_ENABLED) — descriptive prompt text only, ranked ABOVE knowledgeChunks in the rendered prompt. See CLAUDE.md "Diet plan examples layer". */
  dietPlanExamples?: RetrievedDietPlanExample[]
}

// LLM-selected (name only, no grams ever)
export interface SelectedRecipeItem {
  name: string
}
export interface SelectedRecipeMeal {
  slot: string
  items: SelectedRecipeItem[]
}
export interface SelectedRecipeDay {
  dayIndex: number
  meals: SelectedRecipeMeal[]
}
export interface RecipeSelection {
  days: SelectedRecipeDay[]
}

// Grounded (resolved to a real Recipe row) — grams start at the recipe's
// own idealGrams and are only ever changed by recipe-balancer.ts.
export interface GroundedRecipeItem {
  recipe: RecipeForPipeline
  grams: number
}
export interface GroundedRecipeMeal {
  slot: string
  items: GroundedRecipeItem[]
}
export interface GroundedRecipeDay {
  dayIndex: number
  meals: GroundedRecipeMeal[]
  totals: RecipeAchievedMacros
  cappedRecipeNames: string[]
  unknownRecipeNames: string[]
}
export interface GroundedRecipeSelection {
  days: GroundedRecipeDay[]
}

export interface RecipeSelectionResult {
  selection: GroundedRecipeSelection
  generationMode: "ai" | "fallback"
  modelUsed: string | null
  attempts: number
  warnings: string[]
}

/**
 * Column selection for every pipeline query against `recipes` — everything
 * except the audit-only `rawCsvRow`. Kept next to RecipeForPipeline so the
 * runtime shape and the type it satisfies cannot drift apart.
 */
export const RECIPE_PIPELINE_COLUMNS = (() => {
  const { rawCsvRow: _auditOnly, ...columns } = getTableColumns(recipes)
  return columns
})()
