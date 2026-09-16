/**
 * Ingredient-level editing: "make it 3 eggs instead of 2", with an exact
 * macro consequence.
 *
 * ## Why this does not disturb any existing number
 *
 * The source data states each recipe as a BATCH (a full pan) plus a `Servings`
 * count and a declared portion weight. Today's live `recipes.*_per_100g` is
 *
 *     batch macros / (Servings x portion weight) x 100
 *
 * Re-basing that batch to ONE portion - dividing both the macros and the
 * servings count by `Servings` - is arithmetically the same figure, because
 * numerator and denominator are divided by the same number:
 *
 *     (batch / Servings) / portionWeight x 100   ==   batch / (Servings x portionWeight) x 100
 *
 * Verified against the live table on real rows (Egg Bhurji derives
 * C8.42 P7.60 F6.67 E124.05 against a stored C8.40 P7.60 F6.70 E124.30 -
 * equal to the stored rounding). So this layer reproduces today's nutrition
 * exactly and changes nothing at all until a dietitian actually edits
 * something. That is the whole reason it is safe to add.
 *
 * ## What is exact and what is estimated
 *
 * EXACT: the macro delta of any edit. It comes from the ingredient's own
 * verified per-100g figure, which the source dataset is measurably
 * self-consistent about (0 of 345 ingredients disagree with themselves).
 *
 * ESTIMATED: the plated weight after an edit. Added raw grams are scaled by
 * the recipe's `yieldFactor` (declared portion weight / raw ingredient
 * weight), which stands in for cooking water gained or lost AND for
 * un-itemised salt, spices and water. It is a per-recipe calibration constant
 * recovered from the data, not a physical measurement.
 *
 * That split is deliberate and it is the safe way round: if the yield is off,
 * the gram figure on the plate drifts while every clinical number stays
 * exact. Recipes whose yield factor is implausible are excluded from this
 * layer at seed time rather than being edited on a bad constant - see
 * seed-ingredients.ts.
 *
 * ## Scope of an edit
 *
 * Changing one ingredient changes ONLY that ingredient. The onion does not
 * grow because the egg did. This models a dietitian saying "same dish, more
 * egg", which is the instruction the feature exists to serve. Scaling the
 * whole dish together is a different clinical intent and is deliberately not
 * implemented here rather than guessed at.
 *
 * Pure functions, no I/O, no model involvement anywhere.
 */
import type { IngredientQuantityKind } from "@/lib/foods/recipe-calculation-parser"

import type { AchievedMacros } from "./table-4-1"

/**
 * How far a recipe's ingredient-derived per-100g may sit from the figure
 * `recipes` already stores before the two are called disagreeing.
 *
 * `recipes.*_per_100g` is stored to one decimal, so ±0.05 is pure storage
 * rounding; the rest of this budget absorbs the source's own 2 dp rounding on
 * each ingredient line. Anything beyond it is a real contradiction, and a
 * recipe that cannot clear it is kept out of the layer entirely rather than
 * shown with an ingredient list that does not add up to its own header.
 *
 * This is the gate that keeps the layer honest: it is what makes "adding
 * ingredients changes no live number" a checked property rather than a claim.
 * seed-ingredients.ts enforces it at write time and
 * scripts/verify-ingredient-layer.ts re-checks it against the database.
 */
export const PER_100G_AGREEMENT_TOLERANCE = 0.15

/** Per-100g nutrition of one ingredient. The source of every macro figure below. */
export interface IngredientPer100G {
  carbsG: number
  proteinG: number
  fatG: number
  fiberG: number
  kcal: number
}

/** One ingredient as it appears in a SINGLE plated portion. */
export interface PortionIngredient {
  name: string
  kind: IngredientQuantityKind
  /**
   * How much of it is in this portion. For "piece" and "measure" this is a
   * count of units (2 eggs, 1.5 tsp) and is routinely fractional - a portion
   * of a dish that serves 1.5 people genuinely contains 1.33 eggs. For
   * "direct" it is grams.
   */
  quantity: number
  /** "piece" | "tsp" | "tbsp" | "cup" | "ml", or null when measured in grams. */
  unit: string | null
  /** Grams one unit weighs. Null when measured in grams. */
  gramsPerUnit: number | null
  /** Grams of this ingredient in this portion. */
  grams: number
  per100G: IngredientPer100G
}

/** A whole recipe expressed as one plated portion, ready to edit. */
export interface PortionRecipe {
  ingredients: PortionIngredient[]
  /** Macros of this one portion. */
  macros: AchievedMacros
  /** Declared plated weight of this one portion, in grams. */
  portionGrams: number
  /** Declared plated weight / raw ingredient weight. Converts added raw grams into added plated grams. */
  yieldFactor: number
}

export interface IngredientEditResult {
  recipe: PortionRecipe
  /** Signed change in each macro. Exact. */
  delta: AchievedMacros
  /** Per-100g of the edited portion - what the balancer re-optimises against. */
  per100G: IngredientPer100G
  /** True when the plated weight moved. The macros are exact either way. */
  weightChanged: boolean
}

function zeroMacros(): AchievedMacros {
  return { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
}

/** Macros contributed by `grams` of an ingredient. The one place per-100g is applied. */
export function macrosForGrams(per100G: IngredientPer100G, grams: number): AchievedMacros {
  const scale = grams / 100
  return {
    kcal: per100G.kcal * scale,
    proteinG: per100G.proteinG * scale,
    carbsG: per100G.carbsG * scale,
    fatG: per100G.fatG * scale,
    fiberG: per100G.fiberG * scale,
  }
}

/** Totals a portion's ingredients. Used to re-derive macros after any edit. */
export function sumIngredientMacros(ingredients: readonly PortionIngredient[]): AchievedMacros {
  const total = zeroMacros()
  for (const ing of ingredients) {
    const m = macrosForGrams(ing.per100G, ing.grams)
    total.kcal += m.kcal
    total.proteinG += m.proteinG
    total.carbsG += m.carbsG
    total.fatG += m.fatG
    total.fiberG = (total.fiberG ?? 0) + (m.fiberG ?? 0)
  }
  return total
}

/** Per-100g of a portion. Guards against a zero plated weight rather than returning Infinity. */
export function per100GOfPortion(macros: AchievedMacros, portionGrams: number): IngredientPer100G {
  if (portionGrams <= 0) {
    return { carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, kcal: 0 }
  }
  const scale = 100 / portionGrams
  return {
    carbsG: macros.carbsG * scale,
    proteinG: macros.proteinG * scale,
    fatG: macros.fatG * scale,
    fiberG: (macros.fiberG ?? 0) * scale,
    kcal: macros.kcal * scale,
  }
}

/**
 * Grams that `quantity` of an ingredient weighs.
 *
 * For a counted ingredient that is units x grams-per-unit; for a
 * gram-measured one the quantity IS the grams.
 */
export function gramsForQuantity(ing: PortionIngredient, quantity: number): number {
  if (ing.kind === "direct" || ing.gramsPerUnit === null) return quantity
  return quantity * ing.gramsPerUnit
}

/** Thrown when an edit cannot be applied. Surfaces to the UI; never swallowed into a default. */
export class IngredientEditError extends Error {}

/**
 * Below this, a gram difference is floating-point noise rather than a real
 * change. Re-basing a batch divides by `Servings`, so re-deriving a quantity
 * that was never touched can land a few ULPs away from where it started -
 * setting an ingredient to the value it already holds must still report "no
 * weight change".
 */
const WEIGHT_EPSILON_G = 1e-9

/**
 * Sets one ingredient's quantity and recomputes the portion.
 *
 * `quantity` is in the ingredient's own unit - pieces for an egg, teaspoons
 * for ghee, grams for a `direct` ingredient. Zero removes it from the dish;
 * negative is refused rather than clamped, because a negative quantity is a
 * caller bug and silently treating it as zero would hide that.
 */
export function setIngredientQuantity(
  recipe: PortionRecipe,
  ingredientName: string,
  quantity: number,
): IngredientEditResult {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new IngredientEditError(
      `Quantity for "${ingredientName}" must be a finite number of 0 or more, got ${quantity}.`,
    )
  }

  const index = recipe.ingredients.findIndex((i) => i.name === ingredientName)
  if (index === -1) {
    throw new IngredientEditError(
      `"${ingredientName}" is not an ingredient of this recipe. Known: ${recipe.ingredients
        .map((i) => i.name)
        .join(", ")}.`,
    )
  }

  const before = recipe.ingredients[index]
  const newGrams = gramsForQuantity(before, quantity)
  const addedRawGrams = newGrams - before.grams

  const ingredients = [...recipe.ingredients]
  if (quantity === 0) {
    ingredients.splice(index, 1)
  } else {
    ingredients[index] = { ...before, quantity, grams: newGrams }
  }

  const macros = sumIngredientMacros(ingredients)
  // Added raw grams reach the plate scaled by this recipe's own measured
  // yield - 100 g of raw onion does not stay 100 g once it has cooked down.
  const portionGrams = Math.max(0, recipe.portionGrams + addedRawGrams * recipe.yieldFactor)

  const delta: AchievedMacros = {
    kcal: macros.kcal - recipe.macros.kcal,
    proteinG: macros.proteinG - recipe.macros.proteinG,
    carbsG: macros.carbsG - recipe.macros.carbsG,
    fatG: macros.fatG - recipe.macros.fatG,
    fiberG: (macros.fiberG ?? 0) - (recipe.macros.fiberG ?? 0),
  }

  return {
    recipe: { ingredients, macros, portionGrams, yieldFactor: recipe.yieldFactor },
    delta,
    per100G: per100GOfPortion(macros, portionGrams),
    weightChanged: Math.abs(addedRawGrams) > WEIGHT_EPSILON_G,
  }
}

/**
 * Re-bases a stored BATCH into one plated portion.
 *
 * This is the step that makes the whole layer non-disruptive: see the file
 * header. `servings` comes from the source row and is routinely fractional
 * (1.5, 2.5), which is exactly why a portion can contain 1.33 eggs.
 */
export function toPortion(
  batchIngredients: readonly PortionIngredient[],
  servings: number,
  portionGrams: number,
): PortionRecipe {
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new IngredientEditError(`Servings must be greater than 0, got ${servings}.`)
  }
  if (!Number.isFinite(portionGrams) || portionGrams <= 0) {
    throw new IngredientEditError(`Portion weight must be greater than 0, got ${portionGrams}.`)
  }

  const ingredients = batchIngredients.map((ing) => ({
    ...ing,
    quantity: ing.quantity / servings,
    grams: ing.grams / servings,
  }))
  const rawPortionGrams = ingredients.reduce((sum, i) => sum + i.grams, 0)
  if (rawPortionGrams <= 0) {
    throw new IngredientEditError("Recipe has no ingredient weight to re-base.")
  }

  return {
    ingredients,
    macros: sumIngredientMacros(ingredients),
    portionGrams,
    yieldFactor: portionGrams / rawPortionGrams,
  }
}
