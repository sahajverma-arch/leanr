/**
 * Dev-only tool: exercises selectRecipes() end-to-end against a real
 * roadmap and real OpenAI calls, without going through the HTTP route (no
 * auth/session plumbing needed). Useful for the real prompt/model tuning
 * work CLAUDE.md's "The recipe engine" section flags as still open — run
 * with a roadmap id and optionally a cuisine:
 *   npx tsx --env-file=.env.local scripts/live-test-recipe-engine.ts <roadmapId> ["North Indian"]
 * Never imported by production code.
 */
import { eq, and, inArray } from "drizzle-orm"

import { db } from "../src/db"
import { clients, counsellingSessions, mealTemplates, recipeAliases, recipes, roadmaps } from "../src/db/schema"
import type { Answers } from "../src/lib/counselling/questions"
import { weekTargets, type RoadmapResult } from "../src/lib/counselling/roadmap"
import { clientRecipeAllergenTagsFromAnswers, dietTypeFromAnswers } from "../src/lib/plan/client-profile-from-answers"
import { eligibleCuisinesFor, templateRegionForCuisine, type RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { selectRecipes, RecipeSelectionRejectedError } from "../src/lib/plan/recipe-selector"
import { buildInitialMessages } from "../src/lib/plan/recipe-prompt"
import type { ClientRecipeConstraints } from "../src/lib/plan/recipe-plausibility-validate"
import type { DailyRecipeTarget, GroundedRecipeDay, MealSlotInfo, RecipeForPrompt, RecipeSelectorInput } from "../src/lib/plan/recipe-types"
import { filterRecipePool } from "../src/lib/foods/recipe-pool-filters"
import { seasonFor } from "../src/lib/plan/season"

/** Prints every day's meals, grams and achieved macros. Used on BOTH the success and rejection paths — a rejected week is exactly the one worth reading. */
function printWeek(days: GroundedRecipeDay[], target: DailyRecipeTarget) {
  if (days.length === 0) {
    console.log("\n(no days to show)")
    return
  }
  for (const day of days) {
    const t = day.totals
    console.log(`\n=== Day ${day.dayIndex} — kcal=${t.kcal.toFixed(0)} P=${t.proteinG.toFixed(1)} C=${t.carbsG.toFixed(1)} F=${t.fatG.toFixed(1)} fib=${t.fiberG.toFixed(1)} ===`)
    for (const meal of day.meals) {
      const items = meal.items.map((i) => `${i.recipe.name} (${i.grams}g)`).join(", ")
      console.log(`  ${meal.slot.padEnd(12)} ${items || "(empty)"}`)
    }
  }
  console.log(`\nTarget per day: kcal=${target.kcal.toFixed(0)} P=${target.proteinG.toFixed(1)} C=${target.carbsG.toFixed(1)} F=${target.fatG.toFixed(1)} fib=${target.fiberG.toFixed(1)}`)
}

async function main() {
  const roadmapId = process.argv[2]
  const cuisine = (process.argv[3] ?? "North Indian") as RecipeCuisine
  const mealCount = 5

  const [roadmapRow] = await db.select().from(roadmaps).where(eq(roadmaps.id, roadmapId)).limit(1)
  if (!roadmapRow) throw new Error("roadmap not found")
  const [sessionRow] = await db
    .select({ session: counsellingSessions, client: clients })
    .from(counsellingSessions)
    .innerJoin(clients, eq(counsellingSessions.clientId, clients.id))
    .where(eq(counsellingSessions.id, roadmapRow.sessionId))
    .limit(1)
  if (!sessionRow) throw new Error("session not found")
  const { session, client } = sessionRow

  console.log(`Client: ${client.name}`)

  const roadmapOutput = roadmapRow.output as RoadmapResult
  const dailyTarget = weekTargets(roadmapOutput, 1)
  const dietType = dietTypeFromAnswers(session.answers as Answers)
  console.log(`Diet type: ${dietType}`)
  console.log(`Daily target: kcal=${dailyTarget.kcal.toFixed(0)} protein=${dailyTarget.proteinG.toFixed(1)} carbs=${dailyTarget.carbsG.toFixed(1)} fat=${dailyTarget.fatG.toFixed(1)} fibre=${dailyTarget.fibreG.toFixed(1)}`)

  const templateRegion = templateRegionForCuisine(cuisine)
  const season = seasonFor(new Date().toISOString().slice(0, 10), cuisine)
  const slotRows = await db
    .select({ slot: mealTemplates.slot, slotOrder: mealTemplates.slotOrder, timeHint: mealTemplates.timeHint })
    .from(mealTemplates)
    .where(and(eq(mealTemplates.region, templateRegion), eq(mealTemplates.mealCount, mealCount)))
  const slots: MealSlotInfo[] = slotRows.map((r) => ({ slot: r.slot, slotOrder: r.slotOrder, timeHint: r.timeHint }))
  console.log(`Slots: ${slots.map((s) => s.slot).join(", ")}`)
  console.log(`Season: ${season}`)

  const eligibleCuisines = eligibleCuisinesFor(cuisine)
  const cuisineRows = await db
    .select()
    .from(recipes)
    .where(and(eq(recipes.isActive, true), inArray(recipes.cuisine, eligibleCuisines)))
  const clientRecipeAllergenTags = clientRecipeAllergenTagsFromAnswers(session.answers as Answers)
  const dailyRecipeTarget: DailyRecipeTarget = {
    kcal: dailyTarget.kcal,
    proteinG: dailyTarget.proteinG,
    carbsG: dailyTarget.carbsG,
    fatG: dailyTarget.fatG,
    fiberG: dailyTarget.fibreG,
  }

  // Same pool filters production applies (recipe-pool-filters.ts). Without
  // this the script measured a 394-recipe pool where the real route uses 281,
  // which makes every local run unrepresentative — a wrong instrument is
  // worse than no instrument.
  const filtered = filterRecipePool(cuisineRows.filter(
      (r) =>
        r.dietTypes.includes(dietType) &&
        (r.season === "all_year" || r.season === season) &&
        !r.allergenTags.some((t) => clientRecipeAllergenTags.includes(t))
    ))
  console.log(`Eligible recipe pool: ${filtered.length} / ${cuisineRows.length} cuisine-matched / ${await db.$count(recipes)} total`)

  const eligibleRecipesForPrompt: RecipeForPrompt[] = filtered.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    consistency: r.consistency,
    mainOrMid: r.mainOrMid as "main" | "mid",
    cuisine: r.cuisine,
    macroCategory: r.macroCategory,
    commonality: r.commonality,
    mustHaveCategories: r.mustHaveCategories,
    goodToHaveCategories: r.goodToHaveCategories,
    mustHaveRecipeNames: r.mustHaveRecipeNames,
    goodToHaveRecipeNames: r.goodToHaveRecipeNames,
    proteinPer100G: r.proteinPer100G,
    carbsPer100G: r.carbsPer100G,
    fatPer100G: r.fatPer100G,
    fiberPer100G: r.fiberPer100G,
    kcalPer100G: r.kcalPer100G,
  }))

  const aliasRows = await db
    .select({ recipeId: recipeAliases.recipeId, alias: recipeAliases.alias })
    .from(recipeAliases)
    .where(
      inArray(
        recipeAliases.recipeId,
        filtered.map((r) => r.id)
      )
    )

  const input: RecipeSelectorInput = {
    cuisine,
    dietType,
    mealCount,
    dailyTarget: dailyRecipeTarget,
    slots,
    eligibleRecipesForPrompt,
    allRecipesById: new Map(filtered.map((r) => [r.id, r])),
    eligibleCuisines,
    clientAllergenTags: clientRecipeAllergenTags,
    aliasRows,
  }
  const constraints: ClientRecipeConstraints = { dietType, eligibleCuisines, allergenTags: clientRecipeAllergenTags }

  // Cost probe: build the real prompt and size it WITHOUT calling the API.
  // A rejected week costs one whole-week call plus (retry rounds x failing
  // days) day-retry calls, each re-sending the whole eligible-recipe table,
  // so the table's size — not the model alone — sets the bill.
  if (process.argv.includes("--dry-run")) {
    const messages = buildInitialMessages(input)
    const chars = messages.reduce((n, m) => n + m.content.length, 0)
    const approxTokens = Math.round(chars / 4)
    console.log(`\n=== DRY RUN (no API calls) ===`)
    console.log(`Recipes in prompt table: ${eligibleRecipesForPrompt.length}`)
    console.log(`Prompt chars: ${chars}  (~${approxTokens} tokens, rough 4-chars/token estimate)`)
    console.log(`Worst case for a rejected week: 1 week call + 3 rounds x 7 days = 22 calls`)
    console.log(`Approx input tokens billed, worst case: ~${(approxTokens * 22).toLocaleString()} (before prompt caching)`)
    process.exit(0)
  }

  console.log("\nCalling selectRecipes()...")
  const startedAt = Date.now()
  try {
    // --single: one whole-week call, zero day retries. A rejected week
    // normally costs 22 calls (1 + 3 rounds x 7 days); this costs 1, which
    // is enough to SEE what the model composes even though skipping the
    // retries makes rejection more likely, not less.
    const single = process.argv.includes("--single")
    // --best-of N exercises the real production best-of-N path inside
    // selectRecipes(), not the standalone best-of-n-week.ts script — so a
    // green run here is evidence about what actually ships.
    const bestOfIdx = process.argv.indexOf("--best-of")
    const bestOfN = bestOfIdx === -1 ? undefined : Number(process.argv[bestOfIdx + 1])
    const result = await selectRecipes(input, constraints, {
      ...(bestOfN ? { bestOfN } : {}),
      ...(single ? { maxWeekAttempts: 1, maxDayRetries: 0 } : {}),
      onAttempt: (log) => console.log(`  attempt#${log.attemptNumber} day=${log.dayIndex ?? "week"} ok=${log.validationResult.ok} errors=${JSON.stringify(log.validationResult.errors).slice(0, 200)} latency=${log.latencyMs}ms`),
    })
    console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    console.log(`generationMode=${result.generationMode} modelUsed=${result.modelUsed} attempts=${result.attempts}`)
    console.log(`warnings: ${JSON.stringify(result.warnings)}`)

    const days = result.selection.days
    const weeklyAvg = {
      kcal: days.reduce((s, d) => s + d.totals.kcal, 0) / days.length,
      proteinG: days.reduce((s, d) => s + d.totals.proteinG, 0) / days.length,
      carbsG: days.reduce((s, d) => s + d.totals.carbsG, 0) / days.length,
      fatG: days.reduce((s, d) => s + d.totals.fatG, 0) / days.length,
      fiberG: days.reduce((s, d) => s + d.totals.fiberG, 0) / days.length,
    }
    console.log(`\nWeekly average achieved: kcal=${weeklyAvg.kcal.toFixed(0)} protein=${weeklyAvg.proteinG.toFixed(1)} carbs=${weeklyAvg.carbsG.toFixed(1)} fat=${weeklyAvg.fatG.toFixed(1)} fiber=${weeklyAvg.fiberG.toFixed(1)}`)
    console.log(`Target:                  kcal=${dailyRecipeTarget.kcal.toFixed(0)} protein=${dailyRecipeTarget.proteinG.toFixed(1)} carbs=${dailyRecipeTarget.carbsG.toFixed(1)} fat=${dailyRecipeTarget.fatG.toFixed(1)} fiber=${dailyRecipeTarget.fiberG.toFixed(1)}`)
    console.log(
      `Deviation %: kcal=${((Math.abs(weeklyAvg.kcal - dailyRecipeTarget.kcal) / dailyRecipeTarget.kcal) * 100).toFixed(1)} protein=${((Math.abs(weeklyAvg.proteinG - dailyRecipeTarget.proteinG) / dailyRecipeTarget.proteinG) * 100).toFixed(1)} carbs=${((Math.abs(weeklyAvg.carbsG - dailyRecipeTarget.carbsG) / dailyRecipeTarget.carbsG) * 100).toFixed(1)} fat=${((Math.abs(weeklyAvg.fatG - dailyRecipeTarget.fatG) / dailyRecipeTarget.fatG) * 100).toFixed(1)}`
    )

    printWeek(days, dailyRecipeTarget)
  } catch (err) {
    if (err instanceof RecipeSelectionRejectedError) {
      console.log(`\nREJECTED: ${err.message}`)
      for (const dp of err.dayProblems) {
        console.log(`  Day ${dp.dayIndex}:`)
        dp.problems.forEach((p) => console.log(`    - ${p}`))
      }
      // Show what was actually composed, not just what was wrong with it —
      // the rejected week is the whole point of a debugging run.
      printWeek(err.rejectedDays, dailyRecipeTarget)
    } else {
      throw err
    }
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
