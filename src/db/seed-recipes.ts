/**
 * Seeds `recipes` and `recipe_aliases` from src/db/seed-data/recipe_database.csv
 * (1224 raw rows -> 1222 real recipes after dropping 1 leaked-spreadsheet
 * garbage row and deduping 2 true-duplicate name groups — see
 * recipe-csv-parser.ts). Mirrors seed-foods.ts's idempotent upsert-by-name
 * pattern: Drizzle's own `.update()`/`.insert()` builders, never a raw
 * `sql` template (array-literal-safety — see seed-foods.ts's own comment).
 * Re-run with `npm run seed:recipes`.
 *
 * Refuses to proceed if parseRecipeCsv() reports any unresolved duplicate
 * name group — a genuine collision needs a human decision (see
 * scripts/inspect-recipe-duplicates.ts), never a silent guess.
 *
 * Every warning list below must be reviewed before trusting a seed run, not
 * skipped past — this is the one place `commonality`/`priority`'s real
 * distribution and every classification gap actually surfaces.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import { classifyRecipeDietTypes } from "@/lib/foods/recipe-diet-classifier"
import { normalizeRecipeAllergenTags } from "@/lib/foods/recipe-allergen-normalize"
import { normalizeRecipeConsistency } from "@/lib/foods/recipe-consistency-normalize"
import { normalizeCuisine } from "@/lib/foods/recipe-cuisine-mapping"
import { parsePairingList } from "@/lib/foods/recipe-pairing-normalize"
import { normalizeRecipeSeason } from "@/lib/foods/recipe-season-mapping"
import { computeServingLimits } from "@/lib/foods/recipe-quantity-normalize"
import { deriveRecipeUnit } from "@/lib/foods/recipe-unit-label"
import { resolveAliasCollisions } from "@/lib/foods/recipe-alias-generation"
import { parseRecipeCsv, type RawRecipeRow } from "@/lib/foods/recipe-csv-parser"
import { matchRecipeLinks, parseRecipeLinksCsv } from "@/lib/foods/recipe-links"
import { CurationOverrideTracker } from "@/lib/foods/recipe-curation-overrides"
import { recipeCategoryBucket } from "@/lib/plan/recipe-category"

import { db } from "./index"
import { recipeAliases, recipes } from "./schema"

function normalizeHeavyLight(raw: string): "light" | "medium" | "heavy" {
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === "light") return "light"
  if (cleaned === "heavy") return "heavy"
  if (cleaned === "medium") return "medium"
  throw new Error(`seed-recipes: unrecognized Heavy Light value "${raw}" — extend normalizeHeavyLight before proceeding.`)
}

function normalizeMainOrMid(raw: string): "main" | "mid" {
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === "main") return "main"
  if (cleaned === "mid") return "mid"
  throw new Error(`seed-recipes: unrecognized Main/Mid value "${raw}" — extend normalizeMainOrMid before proceeding.`)
}

function normalizePriority(raw: string): "primary" | "secondary" | null {
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === "primary") return "primary"
  if (cleaned === "secondary") return "secondary"
  return null
}

function buildRecipeValues(row: RawRecipeRow, overrides: CurationOverrideTracker, recipeUrl: string | null) {
  const dietClassification = classifyRecipeDietTypes(row.dietPrefRaw)
  const allergenNormalization = normalizeRecipeAllergenTags(row.allergenRaw)
  const cuisine = normalizeCuisine(row.cuisineRaw)
  const seasonResult = normalizeRecipeSeason(row.seasonRaw)
  // Dietitian corrections to two classification fields only — see
  // recipe-curation-overrides.ts. Macros and serving ranges are never
  // touched, and rawCsvRow below still preserves the untouched source row.
  const category = overrides.applyCategory(row.name, row.category)
  const season = overrides.applySeason(row.name, seasonResult.season)
  const servingLimits = computeServingLimits(row)
  const unit = deriveRecipeUnit(row)
  const commonality = Number.parseInt(row.commonalityRaw, 10)
  const consistency = normalizeRecipeConsistency(row.consistencyRaw)

  const allergenTags = new Set(allergenNormalization.tags)
  if (dietClassification.containsEgg) allergenTags.add("egg")
  if (dietClassification.containsFish) allergenTags.add("fish")
  if (dietClassification.containsSeafood) allergenTags.add("seafood")

  return {
    values: {
      recipeId: row.recipeId,
      name: row.name,
      dietTypes: dietClassification.dietTypes,
      cuisine,
      category,
      macroCategory: row.macroCategoryRaw.trim() || null,
      heavyLight: normalizeHeavyLight(row.heavyLightRaw),
      consistency,
      mainOrMid: normalizeMainOrMid(row.mainOrMidRaw),
      commonality: Number.isFinite(commonality) ? commonality : 0,
      priority: normalizePriority(row.priorityRaw),
      mustHaveCategories: parsePairingList(row.mustHaveCategoryRaw),
      goodToHaveCategories: parsePairingList(row.goodToHaveCategoryRaw),
      mustHaveRecipeNames: parsePairingList(row.mustHaveRecipeRaw),
      goodToHaveRecipeNames: parsePairingList(row.goodToHaveRecipeRaw),
      season,
      allergenTags: [...allergenTags],
      minGrams: servingLimits.minGrams,
      maxGrams: servingLimits.maxGrams,
      idealGrams: servingLimits.idealGrams,
      servingLimitsSource: servingLimits.source,
      unitLabel: unit?.unitLabel ?? null,
      perUnitGrams: unit?.perUnitGrams ?? null,
      proteinPer100G: row.proteinPer100G,
      carbsPer100G: row.carbsPer100G,
      fatPer100G: row.fatPer100G,
      fiberPer100G: row.fiberPer100G,
      recipeUrl,
      rawCsvRow: row as unknown as Record<string, unknown>,
    },
    diagnostics: {
      unclassifiedDietTokens: dietClassification.unclassifiedTokens,
      unclassifiedAllergenTokens: allergenNormalization.unclassifiedTokens,
      cuisineWasRelabeled: cuisine === "General" && row.cuisineRaw.trim() !== "General" && row.cuisineRaw.trim() !== "Gujrati",
      rawCuisine: row.cuisineRaw,
      seasonUnrecognized: seasonResult.unrecognized,
      categoryBucket: recipeCategoryBucket(category, row.name),
      category,
      servingLimitsFlags: servingLimits.flags,
      servingLimitsSource: servingLimits.source,
      hasNaturalUnit: unit !== null,
      consistencyUnrecognized: consistency === null,
    },
  }
}

async function main() {
  const csvText = readFileSync(join(process.cwd(), "src/db/seed-data/recipe_database.csv"), "utf8")
  const parsed = parseRecipeCsv(csvText)

  console.log(`Parsed ${parsed.rows.length} real recipe rows (${parsed.garbageRowCount} garbage row(s) dropped).`)

  // Public recipe-page links, matched by name against the dietitian's
  // hyperlink workbook export. Display metadata only — nothing here can
  // change a macro, a serving range or which recipes are eligible, so a
  // name that fails to match costs a link on a PDF, never a number.
  const parsedLinks = parseRecipeLinksCsv(readFileSync(join(process.cwd(), "src/db/seed-data/recipe_links.csv"), "utf8"))
  const links = matchRecipeLinks(
    parsed.rows.map((r) => r.name),
    parsedLinks.links
  )

  if (parsed.duplicates.length > 0) {
    console.error(`\nRefusing to seed: ${parsed.duplicates.length} unresolved duplicate name group(s) found.`)
    for (const d of parsed.duplicates) {
      console.error(`  "${d.name}" — ${d.rows.length} non-equivalent rows. Inspect with scripts/inspect-recipe-duplicates.ts and hardcode a resolution in recipe-csv-parser.ts.`)
    }
    process.exit(1)
  }

  const unclassifiedDietTokens = new Set<string>()
  const unclassifiedAllergenTokens = new Set<string>()
  const relabeledCuisineCounts = new Map<string, number>()
  const unrecognizedSeasonCount = { n: 0 }
  const otherCategoryNames = new Map<string, string[]>()
  const fallbackServingLimitRecipes: string[] = []
  const noNaturalUnitCount = { n: 0 }
  const unrecognizedConsistencyCount = { n: 0 }
  const pairingCounts = { mustCategory: 0, goodCategory: 0, mustRecipe: 0, goodRecipe: 0 }
  const commonalityDistribution = new Map<number, number>()
  const priorityDistribution = new Map<string, number>()
  const overrides = new CurationOverrideTracker()

  const existingByName = new Map<string, string>()
  for (const r of await db.select({ id: recipes.id, name: recipes.name }).from(recipes)) {
    existingByName.set(r.name, r.id)
  }

  console.log(`Seeding ${parsed.rows.length} recipes...`)
  let inserted = 0
  let updated = 0
  for (const row of parsed.rows) {
    const { values, diagnostics } = buildRecipeValues(row, overrides, links.urlByRecipeName.get(row.name) ?? null)

    diagnostics.unclassifiedDietTokens.forEach((t) => unclassifiedDietTokens.add(t))
    diagnostics.unclassifiedAllergenTokens.forEach((t) => unclassifiedAllergenTokens.add(t))
    if (diagnostics.cuisineWasRelabeled) {
      relabeledCuisineCounts.set(diagnostics.rawCuisine, (relabeledCuisineCounts.get(diagnostics.rawCuisine) ?? 0) + 1)
    }
    if (diagnostics.seasonUnrecognized) unrecognizedSeasonCount.n++
    if (diagnostics.categoryBucket === "other") {
      const list = otherCategoryNames.get(diagnostics.category) ?? []
      list.push(row.name)
      otherCategoryNames.set(diagnostics.category, list)
    }
    if (diagnostics.servingLimitsSource === "fallback_category_default") fallbackServingLimitRecipes.push(row.name)
    if (!diagnostics.hasNaturalUnit) noNaturalUnitCount.n++
    if (diagnostics.consistencyUnrecognized) unrecognizedConsistencyCount.n++
    if (values.mustHaveCategories.length > 0) pairingCounts.mustCategory++
    if (values.goodToHaveCategories.length > 0) pairingCounts.goodCategory++
    if (values.mustHaveRecipeNames.length > 0) pairingCounts.mustRecipe++
    if (values.goodToHaveRecipeNames.length > 0) pairingCounts.goodRecipe++
    commonalityDistribution.set(values.commonality, (commonalityDistribution.get(values.commonality) ?? 0) + 1)
    priorityDistribution.set(values.priority ?? "(none)", (priorityDistribution.get(values.priority ?? "(none)") ?? 0) + 1)

    const existingId = existingByName.get(row.name)
    if (existingId) {
      await db.update(recipes).set(values).where(eq(recipes.id, existingId))
      updated++
    } else {
      await db.insert(recipes).values(values)
      inserted++
    }
  }
  console.log(`Recipes: ${inserted} inserted, ${updated} updated.`)

  console.log("\n=== Ingestion warnings (review before trusting this seed) ===")
  console.log(`Unclassified Diet Pref tokens: ${[...unclassifiedDietTokens].join(", ") || "(none)"}`)
  console.log(`Unclassified Allergen tokens: ${[...unclassifiedAllergenTokens].join(", ") || "(none)"}`)
  console.log(`Cuisine relabels to General:`)
  for (const [raw, count] of [...relabeledCuisineCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}\t"${raw}"`)
  }
  console.log(`Unrecognized Season values: ${unrecognizedSeasonCount.n}`)
  const unmatchedOverrides = overrides.unmatched()
  console.log(
    `Curation overrides applied (recipe-curation-overrides.ts) — category: ${overrides.appliedCategoryCount}, season: ${overrides.appliedSeasonCount}`
  )
  if (unmatchedOverrides.category.length > 0 || unmatchedOverrides.season.length > 0) {
    console.log(`  STALE override entries matching no recipe (renamed source row?) — fix or remove them:`)
    unmatchedOverrides.category.forEach((n) => console.log(`    category: "${n}"`))
    unmatchedOverrides.season.forEach((n) => console.log(`    season: "${n}"`))
  }
  console.log(`Categories falling to "other" bucket (extend recipe-category.ts):`)
  for (const [cat, names] of otherCategoryNames) {
    console.log(`  "${cat}" (${names.length}) — e.g. ${names.slice(0, 3).join(", ")}`)
  }
  console.log(`Recipes using fallback_category_default serving limits: ${fallbackServingLimitRecipes.length}`)
  if (fallbackServingLimitRecipes.length > 0 && fallbackServingLimitRecipes.length <= 30) {
    fallbackServingLimitRecipes.forEach((n) => console.log(`  - ${n}`))
  }
  console.log(`Recipes with no natural unit (gram-only display): ${noNaturalUnitCount.n} / ${parsed.rows.length}`)
  console.log(`Recipes with blank/unrecognized Consistency (stored as null): ${unrecognizedConsistencyCount.n} / ${parsed.rows.length}`)
  console.log(
    `Recipes with pairing data — must-have category: ${pairingCounts.mustCategory}, good-to-have category: ${pairingCounts.goodCategory}, must-have recipe: ${pairingCounts.mustRecipe}, good-to-have recipe: ${pairingCounts.goodRecipe} (of ${parsed.rows.length})`
  )
  console.log(`Commonality distribution: ${[...commonalityDistribution.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(", ")}`)
  console.log(`Priority distribution: ${[...priorityDistribution.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`)
  console.log(
    `Recipe links (recipe_links.csv): ${links.urlByRecipeName.size} / ${parsed.rows.length} recipes linked ` +
      `(${links.matchedExact} exact, ${links.matchedNormalized} name-normalized, ${links.matchedOverride} override).`
  )
  parsedLinks.warnings.forEach((w) => console.log(`  link row skipped — ${w}`))
  if (links.ambiguous.length > 0) {
    console.log(`  AMBIGUOUS workbook names (dropped, never guessed at) — give one an override in recipe-links.ts:`)
    links.ambiguous.forEach((a) => console.log(`    ${a.names.map((n) => `"${n}"`).join(" vs ")}`))
  }
  if (links.unusedOverrides.length > 0) {
    console.log(`  STALE link overrides naming a workbook row that no longer exists — fix or remove them in recipe-links.ts:`)
    links.unusedOverrides.forEach((n) => console.log(`    "${n}"`))
  }
  console.log(`  Workbook links matching no recipe: ${links.unmatchedLinks.length}`)
  if (links.unmatchedLinks.length > 0 && links.unmatchedLinks.length <= 30) {
    links.unmatchedLinks.forEach((l) => console.log(`    - "${l.name}"`))
  }

  // Aliases: recompute fresh every run — delete every "generated" alias
  // (never touches a "manual" one a dietitian might add later) and reinsert.
  const allRecipes = await db.select({ id: recipes.id, name: recipes.name }).from(recipes)
  const { aliases, dropped } = resolveAliasCollisions(allRecipes)

  console.log(`\n=== Aliases ===`)
  console.log(`Generated ${aliases.length} aliases across ${allRecipes.length} recipes.`)
  console.log(`Dropped ${dropped.length} ambiguous alias candidate(s):`)
  dropped.slice(0, 20).forEach((d) => console.log(`  "${d.alias}" claimed by ${d.recipeIds.length} recipes`))

  await db.delete(recipeAliases).where(eq(recipeAliases.source, "generated"))
  const ALIAS_CHUNK = 500
  for (let i = 0; i < aliases.length; i += ALIAS_CHUNK) {
    const chunk = aliases.slice(i, i + ALIAS_CHUNK).map((a) => ({ recipeId: a.recipeId, alias: a.alias, source: "generated" as const }))
    if (chunk.length > 0) await db.insert(recipeAliases).values(chunk).onConflictDoNothing()
  }

  console.log("\nDone.")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err)
    process.exit(1)
  })
