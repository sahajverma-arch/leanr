/**
 * The free-text ingredient list for each recipe, from recipe_ingredients.csv,
 * for the diet-type evidence check in recipe-animal-content.ts. Used at
 * ingestion (seed-recipes.ts) and by scripts/audit-recipe-diet-types.ts.
 *
 * Concatenates every column that names ingredients — both "All Ingredients"
 * columns, "Key Ingredients", and the machine-written "Calculation" trail —
 * because any one of them may be blank for a given row, and a missed egg is
 * worse than a redundant one. Column indices read off the real header row
 * (the same file seed-ingredients.ts reads).
 */
const COL = { recipeId: 0, name: 1, allIngredientsA: 2, allIngredientsB: 3, keyIngredients: 5, calculation: 15 } as const

export interface IngredientTextIndex {
  byId: Map<string, string>
  /** Lower-cased recipe name — the fallback when a row's id does not match. */
  byName: Map<string, string>
}

export function loadIngredientTextByRecipe(rows: string[][]): IngredientTextIndex {
  const byId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const row of rows.slice(1)) {
    const text = [COL.allIngredientsA, COL.allIngredientsB, COL.keyIngredients, COL.calculation]
      .map((i) => row[i] ?? "")
      .join(" | ")
      .trim()
    if (!text || text === "| | |") continue
    const id = (row[COL.recipeId] ?? "").trim()
    const name = (row[COL.name] ?? "").trim().toLowerCase()
    if (id) byId.set(id, text)
    if (name) byName.set(name, text)
  }
  return { byId, byName }
}
