/**
 * Dev tool: compose + validate a recipe-engine week against an EXPLICIT macro
 * target, with no counselling roadmap and no client record.
 *
 * Exists because a dietitian often has only a prescribed macro split (and no
 * intake session yet), and because the LLM path can be unavailable or
 * non-convergent — see CLAUDE.md "The recipe engine". Recipe NAMES come from
 * a hand-authored JSON file shaped exactly like the LLM's own output contract
 * (recipe-schema.ts); every gram, macro and check below runs through the same
 * production code the live engine uses, so a week that passes here is one the
 * engine itself would accept. Never proposes a gram or macro figure.
 *
 * Usage (targets are required; kcal is Atwater-derived, never given):
 *   npx tsx --env-file=.env.local scripts/compose-plan.ts dump \
 *     --cuisine "North Indian" --diet eggetarian --p 63 --c 304 --f 55
 *   ... check <selection.json>   -> BLOCKING problems vs advisory notes
 *   ... grams <selection.json>   -> per-item grams and which hit a serving bound
 *   ... export <selection.json>  -> validated week as JSON (refuses unless clean)
 *
 * Never imported by production code.
 */
import { and, eq, inArray } from "drizzle-orm"
import * as fs from "fs"

import { db } from "../src/db"
import { mealTemplates, recipeAliases, recipes } from "../src/db/schema"
import { eligibleCuisinesFor, templateRegionForCuisine, type RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { recipeSeasonMatches } from "../src/lib/foods/recipe-season-mapping"
import { balanceDayToTargets } from "../src/lib/plan/recipe-balancer"
import { blockingProblems, diagnoseDay } from "../src/lib/plan/recipe-day-diagnosis"
import { buildRecipeIndex, groundSelection } from "../src/lib/plan/recipe-grounding"
import type { ClientRecipeConstraints } from "../src/lib/plan/recipe-plausibility-validate"
import { buildInitialMessages } from "../src/lib/plan/recipe-prompt"
import { llmRecipeSelectionSchema } from "../src/lib/plan/recipe-schema"
import type { DailyRecipeTarget, GroundedRecipeDay, MealSlotInfo, RecipeForPrompt, RecipeSelectorInput } from "../src/lib/plan/recipe-types"
import { isRecipeWeekOffTarget } from "../src/lib/plan/recipe-validate"
import { findDaysNeedingVarietyRetry, findVarietyViolations } from "../src/lib/plan/recipe-variety-tracker"
import { seasonFor } from "../src/lib/plan/season"

/** Not supplied by dietitians in practice; the platform's standard adult reference. Soft target — never gates a plan (recipe-validate.ts). */
const DEFAULT_FIBRE_G = 30

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function requireNum(name: string): number {
  const raw = arg(name)
  const n = Number(raw)
  if (!raw || !Number.isFinite(n)) throw new Error(`Missing or invalid --${name}`)
  return n
}

function readOpts() {
  const cuisine = (arg("cuisine") ?? "North Indian") as RecipeCuisine
  const dietType = arg("diet") ?? "vegetarian"
  const mealCount = Number(arg("meals") ?? 5)
  const proteinG = requireNum("p")
  const carbsG = requireNum("c")
  const fatG = requireNum("f")
  const fiberG = Number(arg("fibre") ?? DEFAULT_FIBRE_G)
  // kcal is ALWAYS derived from the three macros, never taken as input —
  // an independently-supplied figure could silently disagree with them.
  const target: DailyRecipeTarget = { kcal: proteinG * 4 + carbsG * 4 + fatG * 9, proteinG, carbsG, fatG, fiberG }
  const outDir = arg("out") ?? "."
  return { cuisine, dietType, mealCount, target, outDir }
}

async function build() {
  const { cuisine, dietType, mealCount, target, outDir } = readOpts()
  const season = seasonFor(new Date().toISOString().slice(0, 10), cuisine)

  const slotRows = await db
    .select({ slot: mealTemplates.slot, slotOrder: mealTemplates.slotOrder, timeHint: mealTemplates.timeHint })
    .from(mealTemplates)
    .where(and(eq(mealTemplates.region, templateRegionForCuisine(cuisine)), eq(mealTemplates.mealCount, mealCount)))
  const slots: MealSlotInfo[] = slotRows
    .map((r) => ({ slot: r.slot, slotOrder: r.slotOrder, timeHint: r.timeHint }))
    .sort((a, b) => a.slotOrder - b.slotOrder)

  const eligibleCuisines = eligibleCuisinesFor(cuisine)
  const rows = await db.select().from(recipes).where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisines)))
  const filtered = rows.filter((r) => r.dietTypes.includes(dietType) && recipeSeasonMatches(r.season, season))

  const forPrompt: RecipeForPrompt[] = filtered.map((r) => ({
    id: r.id, name: r.name, category: r.category, consistency: r.consistency,
    mainOrMid: r.mainOrMid as "main" | "mid", cuisine: r.cuisine, macroCategory: r.macroCategory,
    commonality: r.commonality, mustHaveCategories: r.mustHaveCategories, goodToHaveCategories: r.goodToHaveCategories,
    mustHaveRecipeNames: r.mustHaveRecipeNames, goodToHaveRecipeNames: r.goodToHaveRecipeNames,
    proteinPer100G: r.proteinPer100G, carbsPer100G: r.carbsPer100G, fatPer100G: r.fatPer100G,
    fiberPer100G: r.fiberPer100G, kcalPer100G: r.kcalPer100G,
  }))

  const aliasRows = await db
    .select({ recipeId: recipeAliases.recipeId, alias: recipeAliases.alias })
    .from(recipeAliases)
    .where(inArray(recipeAliases.recipeId, filtered.map((r) => r.id)))

  const input: RecipeSelectorInput = {
    cuisine, dietType: dietType as RecipeSelectorInput["dietType"], mealCount,
    dailyTarget: target, slots, eligibleRecipesForPrompt: forPrompt,
    allRecipesById: new Map(filtered.map((r) => [r.id, r])),
    eligibleCuisines, clientAllergenTags: [], aliasRows,
  }
  const constraints: ClientRecipeConstraints = { dietType, eligibleCuisines, allergenTags: [] }
  return { input, constraints, season, filtered, outDir }
}

async function run(selection: unknown) {
  const { input, constraints, outDir } = await build()
  const parsed = llmRecipeSelectionSchema.parse(selection)
  const index = buildRecipeIndex([...input.allRecipesById.values()], input.aliasRows)
  const days: GroundedRecipeDay[] = groundSelection(parsed, index).days.map((d) => balanceDayToTargets(d, input.dailyTarget))

  const varietyRetry = findDaysNeedingVarietyRetry(days)
  const overused = new Set(findVarietyViolations(days).map((v) => v.name))
  const reports = days.map((day) => {
    const blocking = blockingProblems(day, input, constraints, overused)
    const all = diagnoseDay(day, input, constraints, overused)
    return { day, blocking, advisory: all.filter((p) => !blocking.includes(p)), varietyFlag: varietyRetry.has(day.dayIndex) }
  })

  const n = days.length || 1
  const avg = {
    kcal: days.reduce((s, d) => s + d.totals.kcal, 0) / n,
    proteinG: days.reduce((s, d) => s + d.totals.proteinG, 0) / n,
    carbsG: days.reduce((s, d) => s + d.totals.carbsG, 0) / n,
    fatG: days.reduce((s, d) => s + d.totals.fatG, 0) / n,
    fiberG: days.reduce((s, d) => s + d.totals.fiberG, 0) / n,
  }
  const allPass = reports.every((r) => r.blocking.length === 0 && !r.varietyFlag) && !isRecipeWeekOffTarget(avg, input.dailyTarget)
  return { reports, days, avg, weekOff: isRecipeWeekOffTarget(avg, input.dailyTarget), allPass, input, outDir }
}

async function main() {
  const cmd = process.argv[2]
  const file = process.argv[3]

  if (cmd === "dump") {
    const { input, season, filtered, outDir } = await build()
    fs.writeFileSync(`${outDir}/prompt-dump.txt`, buildInitialMessages(input).map((m) => `=== ${m.role} ===\n${m.content}`).join("\n\n"))
    console.log(`cuisine=${input.cuisine} diet=${input.dietType} season=${season} meals=${input.mealCount}`)
    console.log(`eligible cuisines: ${input.eligibleCuisines.join(", ")}`)
    console.log(`slots: ${input.slots.map((s) => s.slot).join(", ")}`)
    console.log(`target: ${JSON.stringify(input.dailyTarget)}`)
    console.log(`pool: ${filtered.length} recipes`)
    console.log(`prompt written to ${outDir}/prompt-dump.txt`)
  } else if (cmd === "check") {
    const { reports, avg, weekOff, allPass, input } = await run(JSON.parse(fs.readFileSync(file, "utf8")))
    for (const r of reports) {
      const ok = r.blocking.length === 0 && !r.varietyFlag
      const t = r.day.totals
      console.log(`\nDay ${r.day.dayIndex}: ${ok ? "PASS" : "FAIL"} (kcal=${t.kcal.toFixed(0)} P=${t.proteinG.toFixed(1)} C=${t.carbsG.toFixed(1)} F=${t.fatG.toFixed(1)} fib=${t.fiberG.toFixed(1)})`)
      r.blocking.forEach((p) => console.log(`  [BLOCKING] ${p}`))
      r.advisory.forEach((p) => console.log(`  (advisory) ${p}`))
    }
    const t = input.dailyTarget
    console.log(`\nWeekly avg: kcal=${avg.kcal.toFixed(0)} P=${avg.proteinG.toFixed(1)} C=${avg.carbsG.toFixed(1)} F=${avg.fatG.toFixed(1)} fib=${avg.fiberG.toFixed(1)}`)
    console.log(`Target:     kcal=${t.kcal.toFixed(0)} P=${t.proteinG.toFixed(1)} C=${t.carbsG.toFixed(1)} F=${t.fatG.toFixed(1)}`)
    console.log(`Week off target: ${weekOff}`)
    console.log(`\n${allPass ? "ALL DAYS PASS" : "NOT READY"}`)
  } else if (cmd === "grams") {
    const { days } = await run(JSON.parse(fs.readFileSync(file, "utf8")))
    for (const day of days) {
      console.log(`\n=== Day ${day.dayIndex} ===`)
      for (const meal of day.meals) {
        console.log(`  ${meal.slot}:`)
        for (const i of meal.items) {
          const lo = i.grams <= i.recipe.minGrams + 2
          const hi = i.grams >= i.recipe.maxGrams - 2
          console.log(`    ${i.recipe.name}: ${i.grams}g (${i.recipe.minGrams}-${i.recipe.idealGrams}-${i.recipe.maxGrams})${lo ? " [MIN]" : ""}${hi ? " [MAX]" : ""}`)
        }
      }
    }
  } else if (cmd === "export") {
    const { reports, days, avg, allPass, input, outDir } = await run(JSON.parse(fs.readFileSync(file, "utf8")))
    if (!allPass) {
      console.error("Refusing to export: not every day passes. Run `check` first.")
      process.exit(1)
    }
    fs.writeFileSync(`${outDir}/week-export.json`, JSON.stringify({
      cuisine: input.cuisine, dietType: input.dietType,
      target: input.dailyTarget, weeklyAverage: avg,
      days: days.map((d) => ({
        dayIndex: d.dayIndex, totals: d.totals,
        meals: d.meals.map((m) => ({
          slot: m.slot, slotOrder: input.slots.find((s) => s.slot === m.slot)?.slotOrder ?? 0,
          items: m.items.map((i) => ({
            name: i.recipe.name, grams: i.grams, category: i.recipe.category,
            unitLabel: i.recipe.unitLabel, perUnitGrams: i.recipe.perUnitGrams,
            isNonVeg: !i.recipe.dietTypes.includes("vegetarian"),
            kcal: (i.recipe.kcalPer100G * i.grams) / 100, proteinG: (i.recipe.proteinPer100G * i.grams) / 100,
            carbsG: (i.recipe.carbsPer100G * i.grams) / 100, fatG: (i.recipe.fatPer100G * i.grams) / 100,
            fiberG: (i.recipe.fiberPer100G * i.grams) / 100,
          })),
        })),
      })),
      advisories: reports.flatMap((r) => r.advisory.map((a) => `Day ${r.day.dayIndex}: ${a}`)),
    }, null, 2))
    console.log(`exported -> ${outDir}/week-export.json`)
  } else {
    console.error("usage: dump | check <json> | grams <json> | export <json>   (see header for flags)")
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
