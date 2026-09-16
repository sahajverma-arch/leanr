/**
 * Proves the ingredient layer changed nothing.
 *
 *   npx tsx --env-file=.env.local scripts/verify-ingredient-layer.ts
 *
 * The layer's whole safety argument is that rebuilding a recipe's nutrition
 * from its ingredients lands on the figure `recipes` already stores, because
 * re-basing a batch to one portion divides numerator and denominator by the
 * same `Servings`. That is an arithmetic identity, but an identity is only
 * worth as much as the data it runs on — so this checks it against EVERY
 * admitted recipe rather than trusting the argument.
 *
 * Read-only. Safe to run against production, and the right thing to run before
 * deciding whether the trial is working.
 */
import { eq, sql as raw } from "drizzle-orm"

import { PER_100G_AGREEMENT_TOLERANCE } from "@/lib/plan/ingredient-edit"

import { db } from "../src/db"
import {
  ingredients as ingredientsTable,
  recipeIngredientProfiles,
  recipeIngredients,
  recipes,
} from "../src/db/schema"

/**
 * The same budget seed-ingredients.ts admits recipes under, imported rather
 * than restated so the check and the gate can never drift apart.
 */
const TOLERANCE_PER_100G = PER_100G_AGREEMENT_TOLERANCE

async function main() {
  const rows = await db
    .select({
      name: recipes.name,
      storedProtein: recipes.proteinPer100G,
      storedCarbs: recipes.carbsPer100G,
      storedFat: recipes.fatPer100G,
      servings: recipeIngredientProfiles.servings,
      portionGrams: recipeIngredientProfiles.portionGrams,
      yieldFactor: recipeIngredientProfiles.yieldFactor,
      // Batch macros summed from the ingredient rows themselves.
      batchProtein: raw<number>`sum(${recipeIngredients.grams} * ${ingredientsTable.proteinPer100G} / 100)`,
      batchCarbs: raw<number>`sum(${recipeIngredients.grams} * ${ingredientsTable.carbsPer100G} / 100)`,
      batchFat: raw<number>`sum(${recipeIngredients.grams} * ${ingredientsTable.fatPer100G} / 100)`,
      lineCount: raw<number>`count(*)::int`,
    })
    .from(recipeIngredientProfiles)
    .innerJoin(recipes, eq(recipes.id, recipeIngredientProfiles.recipeId))
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipeIngredientProfiles.recipeId))
    .innerJoin(ingredientsTable, eq(ingredientsTable.id, recipeIngredients.ingredientId))
    .groupBy(
      recipes.name,
      recipes.proteinPer100G,
      recipes.carbsPer100G,
      recipes.fatPer100G,
      recipeIngredientProfiles.servings,
      recipeIngredientProfiles.portionGrams,
      recipeIngredientProfiles.yieldFactor,
    )

  console.log(`Checking ${rows.length} admitted recipes.\n`)

  const drifted: { name: string; macro: string; derived: number; stored: number }[] = []
  let worst = 0
  let totalLines = 0

  for (const r of rows) {
    totalLines += r.lineCount
    // portion macros / portion grams * 100, which reduces to
    // batch macros / (servings * portion grams) * 100.
    const denom = r.servings * r.portionGrams
    const checks: [string, number, number][] = [
      ["protein", (Number(r.batchProtein) / denom) * 100, r.storedProtein],
      ["carbs", (Number(r.batchCarbs) / denom) * 100, r.storedCarbs],
      ["fat", (Number(r.batchFat) / denom) * 100, r.storedFat],
    ]
    for (const [macro, derived, stored] of checks) {
      const gap = Math.abs(derived - stored)
      worst = Math.max(worst, gap)
      if (gap > TOLERANCE_PER_100G) drifted.push({ name: r.name, macro, derived, stored })
    }
  }

  console.log(`  recipe-ingredient lines:      ${totalLines}`)
  console.log(`  worst per-100g disagreement:  ${worst.toFixed(4)} g`)
  console.log(`  recipes that disagree:        ${new Set(drifted.map((d) => d.name)).size}\n`)

  if (drifted.length === 0) {
    console.log("  PASS — every admitted recipe rebuilds to the nutrition already stored.")
    console.log("  The layer is descriptive only. Nothing a client sees today has moved.")
  } else {
    console.log("  FAIL — these recipes would change if the layer were trusted:")
    for (const d of drifted.slice(0, 20)) {
      console.log(
        `    ${d.name.slice(0, 40).padEnd(40)} ${d.macro.padEnd(8)} ` +
          `derived ${d.derived.toFixed(2)} vs stored ${d.stored.toFixed(2)}`,
      )
    }
    if (drifted.length > 20) console.log(`    ... and ${drifted.length - 20} more`)
  }

  const [{ ingredientCount }] = await db
    .select({ ingredientCount: raw<number>`count(*)::int` })
    .from(ingredientsTable)
  console.log(`\n  ingredient master: ${ingredientCount} rows`)

  process.exit(drifted.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
