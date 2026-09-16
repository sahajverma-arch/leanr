/**
 * Seeds the ingredient layer from src/db/seed-data/recipe_ingredients.csv.
 * Re-run with `npm run seed:ingredients`.
 *
 * TRIAL SCOPE, and it is deliberately narrow: only recipes measured as CLEAN
 * are admitted. Every other recipe simply gets no rows, and the app shows no
 * ingredient breakdown for it. Admitting a dish on shaky data would be worse
 * than admitting none — the point of ingredient editing is that the number a
 * dietitian sees moves for a reason they can trust.
 *
 * A recipe is admitted only when ALL of these hold:
 *   1. it exists in `recipes` (joined on recipe_id, falling back to name)
 *   2. its Calculation parses with no problems reported
 *   3. every ingredient carries macros
 *   4. summed ingredients reconcile to the recipe's own stated totals (<=1%)
 *   5. its yield factor is plausible (0.4–3.0)
 *   6. no ingredient it uses is quarantined for bad nutrition
 *
 * Rule 6 is why the canonical demo dish, Egg Bhurji, is NOT in the trial: it
 * contains "french beans" carrying dried-rajma nutrition (350 kcal/100 g for a
 * fresh vegetable), which overstates that dish by ~17% today. Editing would
 * make that error visible and blameable on the new feature. Fix the ingredient
 * row, re-seed, and the dish admits itself.
 *
 * Mirrors seed-recipes.ts: Drizzle builders rather than raw `sql` templates,
 * idempotent (delete-then-reinsert per recipe, same as recipe_aliases), and a
 * warnings banner that must be read rather than skipped past.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parseCsvRows } from "@/lib/foods/csv-parser"
import {
  parseCalculation,
  per100GFrom,
  type ParsedIngredientLine,
} from "@/lib/foods/recipe-calculation-parser"
import { PER_100G_AGREEMENT_TOLERANCE } from "@/lib/plan/ingredient-edit"

import { db } from "./index"
import {
  ingredients as ingredientsTable,
  ingredientUnits,
  recipeIngredientProfiles,
  recipeIngredients,
  recipes,
} from "./schema"

/** Column indices, read off the real header row of recipe_ingredients.csv. */
const COL = {
  recipeId: 0,
  name: 1,
  servings: 6,
  carbs: 8,
  protein: 9,
  fat: 10,
  fiber: 11,
  energy: 12,
  calculation: 15,
  measuredWeight: 42,
} as const

/** Worst acceptable gap between summed ingredients and the recipe's stated totals. */
const MAX_RECONCILIATION_GAP = 0.01
/** Outside this band the yield factor is not modelling cooking, it is modelling a data error. */
const MIN_YIELD_FACTOR = 0.4
const MAX_YIELD_FACTOR = 3.0

/**
 * Ingredients whose nutrition is wrong or ambiguous. Every recipe using one is
 * held out until the row is fixed. Measured, not guessed — see the ingredient
 * audit in the data-quality findings.
 */
const QUARANTINE: Record<string, string> = {
  "french beans": "350 kcal/100g, 64 g carbs — dried-rajma values on a fresh vegetable (real ~31 kcal)",
  "green beans": "350 kcal/100g — same dried-legume values as french beans",
  "black beans": "349 kcal/100g — dried values; needs splitting into dried vs cooked",
  beans: "145 kcal/100g is plausible for cooked rajma but this name is used to mean green beans",
  "sprouted moth beans": "166 kcal/100g — inconsistent with other sprouted legumes, unverified",
  "unsweetened cocoa powder": "stated 229 kcal/100g against 419 by Atwater",
  "roasted chana": "stated 200 kcal/100g against 413 by Atwater",
  "soybean dal": "stated 416 kcal/100g against 264 by Atwater",
  "flaxseed powder": "stated 500 kcal/100g against 600 by Atwater",
  "samak rice": "stated 379.5 kcal/100g against 441.9 by Atwater",
  "water chestnut flour": "stated 278.1 kcal/100g against 318.0 by Atwater",
  "cinnamon powder": "stated 271.2 kcal/100g against 342.4 by Atwater",
  gond: "stated 300 kcal/100g against 349 by Atwater",
  "tomato puree": "stated 38 kcal/100g against 44.4 by Atwater",
  "brazil nut": "stated 714 kcal/100g against 550 by Atwater",
  "wheat gol gappa pellets": "stated 371 kcal/100g against 207 by Atwater",
  "green chutney": "stated 66.7 kcal/100g against 96.1 by Atwater",
  kokum: "stated 65 kcal/100g against 71.6 by Atwater",
}

function num(raw: string | undefined): number | null {
  const cleaned = (raw ?? "").trim().replace(/,/g, "")
  const match = /^-?\d*\.?\d+/.exec(cleaned)
  return match ? Number(match[0]) : null
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "")
}

interface AdmittedRecipe {
  recipeUuid: string
  recipeName: string
  lines: ParsedIngredientLine[]
  servings: number
  portionGrams: number
  rawBatchGrams: number
  yieldFactor: number
  reconciliationGap: number
  /** The live stored per-100g this recipe's ingredients must rebuild to. */
  stored: { proteinG: number; carbsG: number; fatG: number }
}

async function main() {
  const csvPath = join(process.cwd(), "src", "db", "seed-data", "recipe_ingredients.csv")
  const rows = parseCsvRows(readFileSync(csvPath, "utf8"))
  const dataRows = rows.slice(1)
  console.log(`Read ${dataRows.length} rows from recipe_ingredients.csv`)

  const liveRecipes = await db
    .select({
      id: recipes.id,
      recipeId: recipes.recipeId,
      name: recipes.name,
      proteinPer100G: recipes.proteinPer100G,
      carbsPer100G: recipes.carbsPer100G,
      fatPer100G: recipes.fatPer100G,
    })
    .from(recipes)
  const byRecipeId = new Map(liveRecipes.map((r) => [r.recipeId.trim(), r]))
  const byName = new Map(liveRecipes.map((r) => [normalizeName(r.name), r]))
  console.log(`Live recipes: ${liveRecipes.length}`)

  const admitted: AdmittedRecipe[] = []
  const rejected = new Map<string, string[]>()
  const reject = (reason: string, recipeName: string) => {
    const list = rejected.get(reason) ?? []
    list.push(recipeName)
    rejected.set(reason, list)
  }

  for (const row of dataRows) {
    const recipeName = (row[COL.name] ?? "").trim()
    if (!recipeName || /^\d+$/.test(recipeName)) continue

    const live =
      byRecipeId.get((row[COL.recipeId] ?? "").trim()) ?? byName.get(normalizeName(recipeName))
    if (!live) {
      reject("not present in the live recipes table", recipeName)
      continue
    }

    const { ingredients: lines, problems } = parseCalculation(row[COL.calculation] ?? "")
    if (problems.length > 0) {
      reject(`source could not cost every ingredient (${problems[0]})`, recipeName)
      continue
    }
    if (lines.length === 0) {
      reject("no ingredient data", recipeName)
      continue
    }

    const servings = num(row[COL.servings])
    const portionGrams = num(row[COL.measuredWeight])
    if (!servings || servings <= 0 || !portionGrams || portionGrams <= 0) {
      reject("missing servings or portion weight", recipeName)
      continue
    }

    const stated = {
      carbsG: num(row[COL.carbs]),
      proteinG: num(row[COL.protein]),
      fatG: num(row[COL.fat]),
      fiberG: num(row[COL.fiber]),
      kcal: num(row[COL.energy]),
    }
    if (Object.values(stated).some((v) => v === null)) {
      reject("recipe has no stated totals to reconcile against", recipeName)
      continue
    }

    const summed = {
      carbsG: lines.reduce((s, l) => s + l.carbsG, 0),
      proteinG: lines.reduce((s, l) => s + l.proteinG, 0),
      fatG: lines.reduce((s, l) => s + l.fatG, 0),
      fiberG: lines.reduce((s, l) => s + l.fiberG, 0),
      kcal: lines.reduce((s, l) => s + l.kcal, 0),
    }
    const reconciliationGap = Math.max(
      ...(Object.keys(summed) as (keyof typeof summed)[]).map((k) =>
        Math.abs(summed[k] - stated[k]!) / Math.max(stated[k]!, 1),
      ),
    )
    if (reconciliationGap > MAX_RECONCILIATION_GAP) {
      // Overwhelmingly an un-itemised spoon of cooking oil: the gap is
      // fat-only and energy is off by exactly 9x it. One added line fixes each.
      reject(
        `ingredients do not sum to stated totals (>${MAX_RECONCILIATION_GAP * 100}%)`,
        recipeName,
      )
      continue
    }

    const rawBatchGrams = lines.reduce((s, l) => s + l.grams, 0)
    if (rawBatchGrams <= 0) {
      reject("no ingredient weight", recipeName)
      continue
    }
    const yieldFactor = (servings * portionGrams) / rawBatchGrams
    if (yieldFactor < MIN_YIELD_FACTOR || yieldFactor > MAX_YIELD_FACTOR) {
      reject(
        `implausible yield factor (outside ${MIN_YIELD_FACTOR}–${MAX_YIELD_FACTOR})`,
        recipeName,
      )
      continue
    }

    const quarantined = lines.map((l) => l.name).filter((n) => QUARANTINE[n])
    if (quarantined.length > 0) {
      reject(`uses a quarantined ingredient (${[...new Set(quarantined)].join(", ")})`, recipeName)
      continue
    }

    admitted.push({
      recipeUuid: live.id,
      recipeName: live.name,
      lines,
      servings,
      portionGrams,
      rawBatchGrams,
      yieldFactor,
      reconciliationGap,
      stored: {
        proteinG: live.proteinPer100G,
        carbsG: live.carbsPer100G,
        fatG: live.fatPer100G,
      },
    })
  }

  // ---- one source row per live recipe --------------------------------------
  // The source file genuinely contains duplicate Recipe IDs (which is why
  // `recipes.recipe_id` is deliberately not unique), and two rows can also
  // share a name. Either way both resolve to the same live recipe and would
  // both try to write ingredient lines for it. Identical lists collapse
  // silently; genuinely different ones are a real ambiguity and are refused
  // rather than resolved by a coin flip.
  const signature = (r: AdmittedRecipe) =>
    r.lines.map((l) => `${l.name}:${l.grams}`).join("|") + `@${r.servings}/${r.portionGrams}`
  const byRecipeUuid = new Map<string, AdmittedRecipe>()
  const ambiguous = new Set<string>()
  for (const rec of admitted) {
    const seen = byRecipeUuid.get(rec.recipeUuid)
    if (!seen) {
      byRecipeUuid.set(rec.recipeUuid, rec)
    } else if (signature(seen) !== signature(rec)) {
      ambiguous.add(rec.recipeUuid)
      reject("two different source rows claim this recipe with different ingredients", rec.recipeName)
    }
  }
  for (const uuid of ambiguous) byRecipeUuid.delete(uuid)
  admitted.length = 0
  admitted.push(...byRecipeUuid.values())

  // ---- ingredient master, built only from admitted recipes ------------------
  // An ingredient's per-100g is recovered from its largest observed use, where
  // the source's 2 dp rounding does least damage.
  const master = new Map<
    string,
    { per100: NonNullable<ReturnType<typeof per100GFrom>>; grams: number; units: Map<string, number>; uses: number }
  >()
  const noPer100G = new Set<string>()

  for (const rec of admitted) {
    for (const line of rec.lines) {
      const existing = master.get(line.name)
      const per100 = per100GFrom(line)
      if (per100 && (!existing || line.grams > existing.grams)) {
        master.set(line.name, {
          per100,
          grams: line.grams,
          units: existing?.units ?? new Map(),
          uses: existing?.uses ?? 0,
        })
      } else if (!existing) {
        master.set(line.name, {
          per100: per100 ?? { carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, kcal: 0 },
          grams: line.grams,
          units: new Map(),
          uses: 0,
        })
      }
      const entry = master.get(line.name)!
      entry.uses += 1
      if (line.unit && line.gramsPerUnit !== null) entry.units.set(line.unit, line.gramsPerUnit)
    }
  }
  for (const [name, entry] of master) {
    if (entry.grams < 10) noPer100G.add(name)
  }

  // An ingredient with no use at 10 g or more cannot yield a trustworthy
  // per-100g, so every recipe using it is dropped rather than approximated.
  const droppedForPrecision = admitted.filter((r) => r.lines.some((l) => noPer100G.has(l.name)))
  for (const r of droppedForPrecision) {
    reject("an ingredient is never used at >=10 g, so its per-100g is unreliable", r.recipeName)
  }
  const precisionSafe = admitted.filter((r) => !r.lines.some((l) => noPer100G.has(l.name)))

  // ---- the gate that keeps the layer honest --------------------------------
  // Everything above validates the SOURCE row. This validates the result: does
  // rebuilding the recipe from the ingredient master land on the per-100g the
  // app already serves? If not, a dietitian would open the dish and find an
  // ingredient list that does not add up to the header above it, and no amount
  // of correct arithmetic downstream would rescue that.
  //
  // It catches two quite different things with one rule. Small drift, where
  // the master takes an ingredient's per-100g from its largest observed use
  // and that disagrees slightly with this recipe's own rounded line. And
  // genuinely broken stored rows: "Watermelon" and "Moong Dal Idli" are stored
  // at 0 macros (the known mis-ingested rows that recipe-pool-filters.ts
  // already drops from the app), so the ingredients rebuild them to REAL
  // nutrition and the gap is enormous. The ingredient data is right and the
  // stored row is wrong there — but a trial layer is not the place to
  // unilaterally overwrite a recipe's nutrition, so they stay out and stay
  // reported.
  const finalRecipes: AdmittedRecipe[] = []
  for (const rec of precisionSafe) {
    const denom = rec.servings * rec.portionGrams
    const derived = {
      proteinG: (rec.lines.reduce((s, l) => s + (master.get(l.name)!.per100.proteinG * l.grams) / 100, 0) / denom) * 100,
      carbsG: (rec.lines.reduce((s, l) => s + (master.get(l.name)!.per100.carbsG * l.grams) / 100, 0) / denom) * 100,
      fatG: (rec.lines.reduce((s, l) => s + (master.get(l.name)!.per100.fatG * l.grams) / 100, 0) / denom) * 100,
    }
    const worst = Math.max(
      Math.abs(derived.proteinG - rec.stored.proteinG),
      Math.abs(derived.carbsG - rec.stored.carbsG),
      Math.abs(derived.fatG - rec.stored.fatG),
    )
    if (worst > PER_100G_AGREEMENT_TOLERANCE) {
      reject(
        `ingredients do not rebuild the stored per-100g (off by ${worst.toFixed(2)} g/100 g)`,
        rec.recipeName,
      )
      continue
    }
    finalRecipes.push(rec)
  }

  const usedNames = new Set(finalRecipes.flatMap((r) => r.lines.map((l) => l.name)))

  console.log(`\nAdmitted ${finalRecipes.length} recipes, ${usedNames.size} distinct ingredients.`)

  // ---- write ---------------------------------------------------------------
  // Rebuilt from scratch every run, same discipline as recipe_aliases: the CSV
  // is the source of truth and no stale row may survive a re-seed. A full wipe
  // is also the fast path here — the alternative is a few thousand sequential
  // round trips to a database on the other side of the world, which is the
  // exact latency trap the plan-write path already had to be rescued from.
  // These four tables are standalone, so nothing outside them is affected.
  await db.delete(recipeIngredientProfiles)
  await db.delete(recipeIngredients)
  await db.delete(ingredientUnits)
  await db.delete(ingredientsTable)

  const ingredientRows = [...usedNames].map((name) => {
    const entry = master.get(name)!
    return {
      name,
      carbsPer100G: entry.per100.carbsG,
      proteinPer100G: entry.per100.proteinG,
      fatPer100G: entry.per100.fatG,
      fiberPer100G: entry.per100.fiberG,
      kcalPer100G: entry.per100.kcal,
      usageCount: entry.uses,
      quarantineReason: QUARANTINE[name] ?? null,
    }
  })
  const ingredientIdByName = new Map<string, string>()
  for (let i = 0; i < ingredientRows.length; i += 500) {
    const inserted = await db
      .insert(ingredientsTable)
      .values(ingredientRows.slice(i, i + 500))
      .returning({ id: ingredientsTable.id, name: ingredientsTable.name })
    for (const row of inserted) ingredientIdByName.set(row.name, row.id)
  }

  const unitRows = [...usedNames].flatMap((name) =>
    [...master.get(name)!.units].map(([unit, gramsPerUnit]) => ({
      ingredientId: ingredientIdByName.get(name)!,
      unit,
      gramsPerUnit,
    })),
  )
  for (let i = 0; i < unitRows.length; i += 500) {
    await db.insert(ingredientUnits).values(unitRows.slice(i, i + 500))
  }
  console.log(`Wrote ${ingredientRows.length} ingredients and ${unitRows.length} unit conversions.`)

  const lineRows = finalRecipes.flatMap((rec) =>
    rec.lines.map((line, order) => ({
      recipeId: rec.recipeUuid,
      ingredientId: ingredientIdByName.get(line.name)!,
      kind: line.kind,
      quantity: line.kind === "direct" ? line.grams : line.count!,
      unit: line.unit,
      gramsPerUnit: line.gramsPerUnit,
      grams: line.grams,
      displayOrder: order,
    })),
  )
  for (let i = 0; i < lineRows.length; i += 500) {
    await db.insert(recipeIngredients).values(lineRows.slice(i, i + 500))
  }

  const profileRows = finalRecipes.map((rec) => ({
    recipeId: rec.recipeUuid,
    servings: rec.servings,
    portionGrams: rec.portionGrams,
    rawBatchGrams: rec.rawBatchGrams,
    yieldFactor: rec.yieldFactor,
    reconciliationGap: rec.reconciliationGap,
  }))
  for (let i = 0; i < profileRows.length; i += 500) {
    await db.insert(recipeIngredientProfiles).values(profileRows.slice(i, i + 500))
  }
  console.log(`Wrote ${lineRows.length} recipe-ingredient lines and ${profileRows.length} profiles.`)

  // ---- warnings, to be read rather than skipped ----------------------------
  console.log("\n--- HELD OUT OF THE TRIAL ---")
  const ordered = [...rejected.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [reason, names] of ordered) {
    console.log(`  ${String(names.length).padStart(4)}  ${reason}`)
    console.log(`        e.g. ${names.slice(0, 3).join(", ")}`)
  }
  const totalHeldOut = [...rejected.values()].reduce((s, v) => s + v.length, 0)
  console.log(
    `\n  ${finalRecipes.length} admitted / ${totalHeldOut} held out ` +
      `(${Math.round((finalRecipes.length / (finalRecipes.length + totalHeldOut)) * 100)}% of matched rows)`,
  )
  console.log("\nEvery held-out recipe simply shows no ingredient breakdown. Nothing is degraded.")
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
