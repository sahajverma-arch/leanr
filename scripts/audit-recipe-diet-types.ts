/**
 * Audits every recipe's stored `diet_types` against the recipe's OWN evidence
 * — its name, its allergen tags, and its ingredient list from
 * recipe_ingredients.csv — using the same rule the runtime eligibility check
 * applies (recipe-animal-content.ts). Prints every recipe whose label the
 * evidence contradicts, and the pool size per diet type before/after.
 *
 *   npx tsx --env-file=.env.local scripts/audit-recipe-diet-types.ts          # report only
 *   npx tsx --env-file=.env.local scripts/audit-recipe-diet-types.ts --fix    # also correct the DB
 *
 * Run it after any recipe CSV update. `seed-recipes.ts` applies the same rule
 * at ingestion, and the runtime check applies it again on every read, so a
 * clean audit is a third, independent confirmation — not the only defence.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { db } from "@/db"
import { recipes } from "@/db/schema"
import { parseCsvRows } from "@/lib/foods/csv-parser"
import { detectRecipeAnimalContent, evidenceSafeDietTypes } from "@/lib/foods/recipe-animal-content"
import { loadIngredientTextByRecipe } from "@/lib/foods/recipe-ingredient-text"

const DIET_TYPES = ["vegetarian", "eggetarian", "non_vegetarian", "vegan", "jain"] as const

async function main() {
  const fix = process.argv.includes("--fix")
  const ingredientText = loadIngredientTextByRecipe(
    parseCsvRows(readFileSync(join(process.cwd(), "src", "db", "seed-data", "recipe_ingredients.csv"), "utf8"))
  )

  const rows = await db
    .select({
      id: recipes.id,
      recipeId: recipes.recipeId,
      name: recipes.name,
      dietTypes: recipes.dietTypes,
      allergenTags: recipes.allergenTags,
      isActive: recipes.isActive,
    })
    .from(recipes)

  const before: Record<string, number> = {}
  const after: Record<string, number> = {}
  const changes: { id: string; name: string; from: string[]; to: string[]; reasons: string[] }[] = []
  let withIngredients = 0

  for (const r of rows) {
    const ingredientsText = ingredientText.byId.get(r.recipeId) ?? ingredientText.byName.get(r.name.toLowerCase()) ?? null
    if (ingredientsText) withIngredients++
    const evidence = { name: r.name, allergenTags: r.allergenTags, ingredientsText }
    const safe = evidenceSafeDietTypes(r.dietTypes, evidence)
    if (r.isActive) {
      for (const d of DIET_TYPES) {
        if (r.dietTypes.includes(d)) before[d] = (before[d] ?? 0) + 1
        if (safe.includes(d)) after[d] = (after[d] ?? 0) + 1
      }
    }
    if (safe.length !== r.dietTypes.length) {
      const reasons = detectRecipeAnimalContent(evidence).reasons
      if (r.dietTypes.includes("vegan") && !safe.includes("vegan") && r.allergenTags.includes("lactose")) reasons.push("vegan but lactose")
      if (r.dietTypes.includes("jain") && !safe.includes("jain") && r.allergenTags.includes("onion_garlic")) reasons.push("jain but onion/garlic")
      changes.push({ id: r.id, name: r.name, from: r.dietTypes, to: safe, reasons })
    }
  }

  console.log(`${rows.length} recipes, ${withIngredients} matched to an ingredient list.`)
  const vegBreaches = changes.filter((c) => c.from.includes("vegetarian") && !c.to.includes("vegetarian"))
  console.log(`\n== ${vegBreaches.length} labelled VEGETARIAN but contain meat/fish/egg ==`)
  for (const c of vegBreaches) console.log(`  ${c.name}  [${c.from.join(",")}] -> [${c.to.join(",")}]  <- ${[...new Set(c.reasons)].join("; ")}`)
  const other = changes.filter((c) => !vegBreaches.includes(c))
  console.log(`\n== ${other.length} other contradicted labels (vegan+dairy, jain+onion/garlic, egg-only) ==`)
  for (const c of other) console.log(`  ${c.name}  [${c.from.join(",")}] -> [${c.to.join(",")}]  <- ${[...new Set(c.reasons)].join("; ")}`)

  console.log("\nActive pool per diet type (label only -> after evidence):")
  for (const d of DIET_TYPES) console.log(`  ${d.padEnd(15)} ${before[d] ?? 0} -> ${after[d] ?? 0}`)

  if (fix && changes.length > 0) {
    for (const c of changes) await db.update(recipes).set({ dietTypes: c.to }).where(eq(recipes.id, c.id))
    console.log(`\nFIXED: corrected diet_types on ${changes.length} recipes.`)
  } else if (changes.length > 0) {
    console.log(`\nReport only. Re-run with --fix to correct ${changes.length} recipes in the database.`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
