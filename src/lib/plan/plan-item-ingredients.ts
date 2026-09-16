/**
 * Reading and editing the ingredients of ONE item on a generated plan.
 *
 * Sits between the server actions and the pure maths in ingredient-edit.ts:
 * this file knows about the database, that one knows about arithmetic.
 *
 * The state of an item's ingredients is the base recipe's batch, scaled to the
 * weight THIS item is actually plated at, with any dietitian overrides applied
 * on top. Only overridden ingredients are stored
 * (`diet_plan_recipe_item_ingredients`), so an untouched item reads back
 * byte-identically to what generation produced.
 *
 * A stored override is in the ingredient's own unit at plated scale — exactly
 * the number the dietitian typed, so what is saved is what they asked for.
 *
 * ## What an edit actually changes on the item
 *
 * A plan item's macros are `grams x per-100g snapshot`. Changing what is IN
 * the dish changes its per-100g, so an edit rewrites the item's four snapshot
 * columns and sets `grams` to the recomputed plated weight. The day is then
 * re-balanced by the caller exactly as it is after a swap or a delete — the
 * balancer is free to move this item's grams again unless it is locked.
 *
 * The snapshot columns keep doing their real job throughout: they are what
 * stops a later CSV re-ingestion rewriting an approved plan. An ingredient
 * edit is a deliberate, recorded change to THIS item by a human, which is a
 * different thing from data drifting underneath it.
 */
import { and, eq } from "drizzle-orm"

import { db } from "@/db"

import {
  per100GOfPortion,
  setIngredientQuantity,
  toPortion,
  type IngredientPer100G,
  type PortionIngredient,
  type PortionRecipe,
} from "./ingredient-edit"
import type { IngredientQuantityKind } from "@/lib/foods/recipe-calculation-parser"
import {
  dietPlanRecipeItemIngredients,
  dietPlanRecipeItems,
  ingredients as ingredientsTable,
  recipeIngredientProfiles,
  recipeIngredients,
} from "@/db/schema"
import type { PlanTx } from "./recipe-plan-edit"

/**
 * A database handle these helpers accept. Reads run on `db` directly; writes
 * run inside the same transaction as the re-balance that follows them.
 */
export type IngredientDb = PlanTx | typeof db

/** One ingredient row as the dialog renders it. */
export interface PlanItemIngredientRow {
  ingredientId: string
  name: string
  kind: IngredientQuantityKind
  /** Current amount in this portion — units for piece/measure, grams for direct. */
  quantity: number
  unit: string | null
  gramsPerUnit: number | null
  grams: number
  /** What this ingredient contributes to the dish right now. */
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  /** True when a dietitian has changed this one by hand. */
  edited: boolean
  /** The value generation produced, so the dialog can offer "reset". */
  originalQuantity: number
}

export interface PlanItemIngredientState {
  itemId: string
  recipeName: string
  rows: PlanItemIngredientRow[]
  portionGrams: number
  per100G: IngredientPer100G
  /** False when this recipe is not in the trial; the panel says so instead of listing anything. */
  available: boolean
  /** True when the dietitian pinned this dish's weight. An edit then changes composition only. */
  gramsLocked: boolean
}

interface LoadedPortion {
  portion: PortionRecipe
  idByName: Map<string, string>
  originalByName: Map<string, number>
}

/**
 * Builds what is actually on this plate: the base recipe scaled to the item's
 * own plated weight, then overrides applied. Returns null when the recipe is
 * not in the trial, which every caller treats as "no ingredient breakdown",
 * never as an error.
 *
 * `platedGrams` is the item's real weight, and it is NOT the recipe's declared
 * portion. The balancer plates a dish at whatever the day needs — measured on
 * real plans, only 40 percent of items land within 5 percent of one declared
 * portion and plenty sit at 2x or 3x it. Listing one nominal portion against a
 * dish plated at three would be a breakdown that does not add up to the dish
 * above it, which is the one thing this panel must never do.
 */
export async function loadItemPortion(
  tx: IngredientDb,
  itemId: string,
  recipeId: string,
  platedGrams: number,
): Promise<LoadedPortion | null> {
  const [profile] = await tx
    .select()
    .from(recipeIngredientProfiles)
    .where(eq(recipeIngredientProfiles.recipeId, recipeId))
  if (!profile) return null

  const lines = await tx
    .select({
      ingredientId: ingredientsTable.id,
      name: ingredientsTable.name,
      kind: recipeIngredients.kind,
      quantity: recipeIngredients.quantity,
      unit: recipeIngredients.unit,
      gramsPerUnit: recipeIngredients.gramsPerUnit,
      grams: recipeIngredients.grams,
      carbs: ingredientsTable.carbsPer100G,
      protein: ingredientsTable.proteinPer100G,
      fat: ingredientsTable.fatPer100G,
      fiber: ingredientsTable.fiberPer100G,
      kcal: ingredientsTable.kcalPer100G,
    })
    .from(recipeIngredients)
    .innerJoin(ingredientsTable, eq(recipeIngredients.ingredientId, ingredientsTable.id))
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(recipeIngredients.displayOrder)
  if (lines.length === 0) return null

  const idByName = new Map<string, string>()
  const batch: PortionIngredient[] = lines.map(
    (l: {
      ingredientId: string
      name: string
      kind: string
      quantity: number
      unit: string | null
      gramsPerUnit: number | null
      grams: number
      carbs: number
      protein: number
      fat: number
      fiber: number
      kcal: number
    }) => {
      idByName.set(l.name, l.ingredientId)
      return {
        name: l.name,
        kind: l.kind as IngredientQuantityKind,
        quantity: l.quantity,
        unit: l.unit,
        gramsPerUnit: l.gramsPerUnit,
        grams: l.grams,
        per100G: {
          carbsG: l.carbs,
          proteinG: l.protein,
          fatG: l.fat,
          fiberG: l.fiber,
          kcal: l.kcal,
        },
      }
    },
  )

  // Dividing the batch by `servings / portions` instead of by `servings` lands
  // on the plated amount directly. yieldFactor is a ratio of two weights that
  // both scale by `portions`, so it is unchanged — as it must be, being a
  // property of how the dish cooks rather than of how much was served.
  const plated =
    Number.isFinite(platedGrams) && platedGrams > 0 ? platedGrams : profile.portionGrams
  const portions = plated / profile.portionGrams
  let portion = toPortion(batch, profile.servings / portions, plated)
  const originalByName = new Map(portion.ingredients.map((i) => [i.name, i.quantity]))

  const overrides = await tx
    .select({
      ingredientId: dietPlanRecipeItemIngredients.ingredientId,
      quantity: dietPlanRecipeItemIngredients.quantity,
      name: ingredientsTable.name,
    })
    .from(dietPlanRecipeItemIngredients)
    .innerJoin(ingredientsTable, eq(dietPlanRecipeItemIngredients.ingredientId, ingredientsTable.id))
    .where(eq(dietPlanRecipeItemIngredients.dietPlanRecipeItemId, itemId))

  for (const o of overrides as { name: string; quantity: number }[]) {
    // An override naming an ingredient the recipe no longer has is skipped
    // rather than thrown on: the recipe could have been re-seeded since.
    if (!portion.ingredients.some((i) => i.name === o.name)) continue
    portion = setIngredientQuantity(portion, o.name, o.quantity).recipe
  }

  return { portion, idByName, originalByName }
}

/** Shapes a loaded portion for the dialog. */
export function toIngredientState(
  itemId: string,
  recipeName: string,
  loaded: LoadedPortion | null,
  gramsLocked: boolean,
): PlanItemIngredientState {
  if (!loaded) {
    return {
      itemId,
      recipeName,
      rows: [],
      portionGrams: 0,
      per100G: { carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, kcal: 0 },
      available: false,
      gramsLocked,
    }
  }
  const { portion, idByName, originalByName } = loaded
  const rows: PlanItemIngredientRow[] = portion.ingredients.map((i) => {
    const original = originalByName.get(i.name) ?? i.quantity
    return {
      ingredientId: idByName.get(i.name)!,
      name: i.name,
      kind: i.kind,
      quantity: i.quantity,
      unit: i.unit,
      gramsPerUnit: i.gramsPerUnit,
      grams: i.grams,
      kcal: (i.per100G.kcal * i.grams) / 100,
      proteinG: (i.per100G.proteinG * i.grams) / 100,
      carbsG: (i.per100G.carbsG * i.grams) / 100,
      fatG: (i.per100G.fatG * i.grams) / 100,
      edited: Math.abs(original - i.quantity) > 1e-9,
      originalQuantity: original,
    }
  })
  return {
    itemId,
    recipeName,
    rows,
    portionGrams: portion.portionGrams,
    per100G: per100GOfPortion(portion.macros, portion.portionGrams),
    available: true,
    gramsLocked,
  }
}

/**
 * Writes an edited portion back onto the item.
 *
 * `grams` follows the recomputed plated weight so the dish's total macros
 * actually move with the edit; the per-100g snapshots follow the new
 * composition. The caller re-balances the day afterwards.
 *
 * UNLESS the weight is locked. A lock is a dietitian saying "three rotis" in
 * so many words, and the balancer honours it exactly (recipe-balancer.ts), so
 * writing a weight over it here would destroy that instruction AND then freeze
 * the replacement — the edit would look like it worked and would have silently
 * overruled them. A locked dish keeps its weight and changes only what is in
 * it.
 */
export async function writePortionToItem(
  tx: IngredientDb,
  itemId: string,
  portion: PortionRecipe,
  gramsLocked: boolean,
): Promise<void> {
  const per100 = per100GOfPortion(portion.macros, portion.portionGrams)
  await tx
    .update(dietPlanRecipeItems)
    .set({
      ...(gramsLocked ? {} : { grams: Math.round(portion.portionGrams * 10) / 10 }),
      proteinPer100GSnapshot: Math.round(per100.proteinG * 100) / 100,
      carbsPer100GSnapshot: Math.round(per100.carbsG * 100) / 100,
      fatPer100GSnapshot: Math.round(per100.fatG * 100) / 100,
      fiberPer100GSnapshot: Math.round(per100.fiberG * 100) / 100,
    })
    .where(eq(dietPlanRecipeItems.id, itemId))
}

/** Clears every override on an item, returning it to the recipe as generated. */
export async function clearItemOverrides(tx: IngredientDb, itemId: string): Promise<void> {
  await tx
    .delete(dietPlanRecipeItemIngredients)
    .where(eq(dietPlanRecipeItemIngredients.dietPlanRecipeItemId, itemId))
}

/** Records one ingredient override, replacing any previous value for it. */
export async function upsertItemOverride(
  tx: IngredientDb,
  itemId: string,
  ingredientId: string,
  quantity: number,
): Promise<void> {
  await tx
    .delete(dietPlanRecipeItemIngredients)
    .where(
      and(
        eq(dietPlanRecipeItemIngredients.dietPlanRecipeItemId, itemId),
        eq(dietPlanRecipeItemIngredients.ingredientId, ingredientId),
      ),
    )
  await tx
    .insert(dietPlanRecipeItemIngredients)
    .values({ dietPlanRecipeItemId: itemId, ingredientId, quantity })
}
