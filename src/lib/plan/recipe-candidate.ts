/**
 * One recipe row as a dish picker needs it — shared by the plan page's
 * swap/add dialogs and the review page's fixed-menu picker, so every picker
 * shows the same numbers for the same dish.
 */
import { macroProfileTags, type MacroProfileTag } from "./recipe-macro-profile"

export interface SwapCandidate {
  id: string
  nameEn: string
  householdMeasure: string | null
  /**
   * Recipe-engine only: what this dish would actually cost, at its own
   * typical portion. A picker that lists names alone tells a dietitian
   * nothing about the one thing they are choosing on - see CLAUDE.md
   * "Editing a saved plan".
   */
  preview?: { grams: number; kcal: number; proteinG: number; carbsG: number; fatG: number }
  /**
   * Recipe-engine only: which macro-profile filters this dish satisfies,
   * computed from its own verified per-100g macros (recipe-macro-profile.ts).
   * Sent with the candidate rather than recomputed in the browser so the chip
   * and the numbers printed beside it can never disagree.
   */
  macroTags?: MacroProfileTag[]
}

/**
 * One recipe row as the picker needs it: its macros at its own authored
 * typical portion, plus the macro-profile tags the filter chips act on. Both
 * derived from the same per-100g figures, so a dish tagged "high protein"
 * always shows a protein figure that justifies it.
 */
export function recipeToCandidate(recipe: {
  id: string
  name: string
  unitLabel: string | null
  idealGrams: number
  kcalPer100G: number
  proteinPer100G: number
  carbsPer100G: number
  fatPer100G: number
}): SwapCandidate {
  const f = recipe.idealGrams / 100
  return {
    id: recipe.id,
    nameEn: recipe.name,
    householdMeasure: recipe.unitLabel,
    preview: {
      grams: recipe.idealGrams,
      kcal: recipe.kcalPer100G * f,
      proteinG: recipe.proteinPer100G * f,
      carbsG: recipe.carbsPer100G * f,
      fatG: recipe.fatPer100G * f,
    },
    macroTags: macroProfileTags(recipe),
  }
}

