/**
 * Converts a persisted diet_plan_recipe_items row (+ its recipe) into the
 * shared PlanViewItem shape — near-identical to the deleted dish engine's
 * own adapter. Every macro is computed from the SNAPSHOT columns, never a
 * live `recipes` join: a later CSV re-ingestion that corrects a recipe's
 * macros must never retroactively change an already-approved historical
 * plan's displayed numbers.
 *
 * quantityLabel is the one exception to snapshotting — a recipe's serving-
 * unit convention ("roti", "cup") is presentation metadata, not nutrition,
 * so it's read live from `recipes` rather than frozen at generation time.
 *
 * exchangeType/dishFamilyId are null/[] — every recipe is already a
 * complete, realistically-named identity with no exchange-vocabulary or
 * pooling/renaming layer needed (format-item.ts/meal-composition.ts/
 * vegetable-dish-naming.ts already no-op correctly on a null exchangeType).
 */

import type { DietPlanRecipeItem, Recipe } from "@/db/schema"

import { formatRecipeQuantity } from "./recipe-quantity-display"
import type { PlanViewItem } from "./plan-guidelines"

export function recipeItemToPlanViewItem(
  item: DietPlanRecipeItem,
  recipe: Pick<Recipe, "name" | "category" | "unitLabel" | "perUnitGrams" | "minGrams" | "maxGrams">
): PlanViewItem {
  const factor = item.grams / 100
  return {
    id: item.id,
    foodId: item.recipeId,
    nameEn: recipe.name,
    householdMeasure: null,
    servingRawG: item.grams,
    exchangeType: null,
    exchangeCount: 0,
    kcal: item.proteinPer100GSnapshot * 4 * factor + item.carbsPer100GSnapshot * 4 * factor + item.fatPer100GSnapshot * 9 * factor,
    proteinG: item.proteinPer100GSnapshot * factor,
    carbsG: item.carbsPer100GSnapshot * factor,
    fatG: item.fatPer100GSnapshot * factor,
    fiberG: item.fiberPer100GSnapshot * factor,
    dishFamilyId: null,
    tags: [],
    quantityLabel: formatRecipeQuantity(recipe, item.grams),
    // What the plan page's edit dialog needs. unitLabel/perUnitGrams/min/max
    // are read LIVE from `recipes`, not snapshotted, for the same reason
    // quantityLabel is: a serving-unit convention and a realistic portion
    // range are properties of the dish, not of this plan's nutrition. The
    // per-100g figures beside them ARE the snapshot, so the dialog's
    // arithmetic matches the macros already on the page.
    editing: {
      gramsLocked: item.gramsLocked,
      unitLabel: recipe.unitLabel,
      perUnitGrams: recipe.perUnitGrams,
      minGrams: recipe.minGrams,
      maxGrams: recipe.maxGrams,
      per100G: {
        kcal: item.proteinPer100GSnapshot * 4 + item.carbsPer100GSnapshot * 4 + item.fatPer100GSnapshot * 9,
        proteinG: item.proteinPer100GSnapshot,
        carbsG: item.carbsPer100GSnapshot,
        fatG: item.fatPer100GSnapshot,
        fiberG: item.fiberPer100GSnapshot,
      },
    },
  }
}
