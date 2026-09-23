/**
 * Dev tool: generate N independent whole-week plans in N calls (no day
 * retries), keep every one of them, and pick the week that best matches the
 * client's target.
 *
 * WHY THIS EXISTS. The production selector spends 19-22 calls grinding one
 * week through per-day retries and then throws the ENTIRE week away if any
 * day still fails — good days included. Measured on this project's own runs,
 * 18 retry calls repaired exactly one day. N independent attempts buy more
 * genuine variation per rupee than retrying one bad week does.
 *
 * ACCEPTANCE RULE — a deliberate, confirmed departure from recipe-validate.ts's
 * per-day gate, and the reason this lives in a script rather than in
 * recipe-selector.ts: a week is accepted on its WEEKLY AVERAGE
 * (isRecipeWeekOffTarget), which is exactly the standard the exchange engine
 * already holds itself to (assertWeeklyAverageWithinTolerance). Production
 * reject semantics are UNCHANGED by this file — see CLAUDE.md's "Do not"
 * list. Per-day deviations are still computed and reported, never hidden.
 *
 * Never writes to the database. Emits a render-plan-pdf.tsx payload.
 *
 *   npx tsx --env-file=.env.local scripts/best-of-n-week.ts <roadmapId> "<cuisine>" [--n 5] [--out <week.json>]
 *
 * Never imported by production code.
 */
import { isAnimalProteinRecipe } from "@/lib/foods/recipe-animal-content"
import * as fs from "fs"

import { buildRecipeRunContext } from "./lib/recipe-run-input"
import type { RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { balanceDayToTargets } from "../src/lib/plan/recipe-balancer"
import { blockingProblems } from "../src/lib/plan/recipe-day-diagnosis"
import { groundSelection } from "../src/lib/plan/recipe-grounding"
import { createOpenAIClient, OPENAI_MODEL } from "../src/lib/plan/openai-client"
import { buildInitialMessages } from "../src/lib/plan/recipe-prompt"
import { llmRecipeSelectionSchema } from "../src/lib/plan/recipe-schema"
import type { GroundedRecipeDay, RecipeAchievedMacros } from "../src/lib/plan/recipe-types"
import { isRecipeDayOffTarget, isRecipeWeekOffTarget } from "../src/lib/plan/recipe-validate"
import { findVarietyViolations } from "../src/lib/plan/recipe-variety-tracker"

const MACRO_KEYS = ["kcal", "proteinG", "carbsG", "fatG"] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** Same permissive extraction the production selector uses — a model may wrap JSON in prose. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response")
  return JSON.parse(raw.slice(start, end + 1))
}

function weeklyAverage(days: GroundedRecipeDay[]): RecipeAchievedMacros {
  const n = days.length || 1
  return {
    kcal: days.reduce((s, d) => s + d.totals.kcal, 0) / n,
    proteinG: days.reduce((s, d) => s + d.totals.proteinG, 0) / n,
    carbsG: days.reduce((s, d) => s + d.totals.carbsG, 0) / n,
    fatG: days.reduce((s, d) => s + d.totals.fatG, 0) / n,
    fiberG: days.reduce((s, d) => s + d.totals.fiberG, 0) / n,
  }
}

/** Mean absolute % deviation of the weekly average across kcal/P/C/F. Lower is better; this is the ranking score. */
function meanAbsDeviationPct(avg: RecipeAchievedMacros, target: RecipeAchievedMacros): number {
  const devs = MACRO_KEYS.map((k) => Math.abs(avg[k] - target[k]) / target[k])
  return (devs.reduce((a, b) => a + b, 0) / devs.length) * 100
}

interface Attempt {
  n: number
  days: GroundedRecipeDay[]
  avg: RecipeAchievedMacros
  score: number
  weekPasses: boolean
  daysPassing: number
  varietyViolations: number
  latencyMs: number
}

async function main() {
  const roadmapId = process.argv[2]
  const cuisine = (process.argv[3] ?? "North Indian") as RecipeCuisine
  const n = Number(arg("n") ?? 5)
  const outPath = arg("out")
  if (!roadmapId) throw new Error("usage: best-of-n-week.ts <roadmapId> \"<cuisine>\" [--n 5] [--out <week.json>]")

  const ctx = await buildRecipeRunContext(roadmapId, cuisine)
  const t = ctx.dailyTarget
  console.log(`Client: ${ctx.clientName}  |  diet=${ctx.dietType}  cuisine=${cuisine}  season=${ctx.season}`)
  console.log(`Target/day: kcal=${t.kcal.toFixed(0)} P=${t.proteinG.toFixed(1)} C=${t.carbsG.toFixed(1)} F=${t.fatG.toFixed(1)} fib=${t.fiberG.toFixed(1)}`)
  console.log(`Eligible recipe pool: ${ctx.poolSize}`)

  if (process.argv.includes("--dry-run")) {
    const chars = buildInitialMessages(ctx.input).reduce((a, m) => a + m.content.length, 0)
    console.log(`\nDRY RUN — would make ${n} calls of ~${Math.round(chars / 4)} tokens each. No API calls made.`)
    process.exit(0)
  }

  const client = createOpenAIClient()
  const messages = buildInitialMessages(ctx.input)
  const attempts: Attempt[] = []

  for (let i = 1; i <= n; i++) {
    const started = Date.now()
    try {
      const completion = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
      })
      const latencyMs = Date.now() - started
      const raw = completion.choices[0]?.message?.content
      if (!raw) throw new Error("empty response")

      const parsed = llmRecipeSelectionSchema.parse(extractJson(raw))
      const grounded = groundSelection(parsed, ctx.index)
      const days = grounded.days.map((d) => balanceDayToTargets(d, t))
      const avg = weeklyAverage(days)
      const daysPassing = days.filter(
        (d) => !isRecipeDayOffTarget(d.totals, t) && blockingProblems(d, ctx.input, ctx.constraints, new Set()).length === 0
      ).length

      attempts.push({
        n: i,
        days,
        avg,
        score: meanAbsDeviationPct(avg, t),
        weekPasses: !isRecipeWeekOffTarget(avg, t),
        daysPassing,
        varietyViolations: findVarietyViolations(days).length,
        latencyMs,
      })
      const a = attempts[attempts.length - 1]
      console.log(
        `  attempt ${i}/${n}: weeklyAvgDev=${a.score.toFixed(2)}%  weekPasses=${a.weekPasses}  daysFullyPassing=${a.daysPassing}/7  varietyViolations=${a.varietyViolations}  ${a.latencyMs}ms`
      )
    } catch (err) {
      console.log(`  attempt ${i}/${n}: FAILED — ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (attempts.length === 0) {
    console.error("\nEvery attempt failed. Nothing to choose from.")
    process.exit(1)
  }

  // Rank purely on the confirmed acceptance rule (weekly-average closeness).
  // daysPassing/variety are reported for judgement but deliberately do NOT
  // reorder the winner — mixing them in would quietly reintroduce the per-day
  // gate this tool was asked to stop using.
  const ranked = [...attempts].sort((a, b) => a.score - b.score)
  const best = ranked[0]

  console.log(`\n=== Ranking (by weekly-average deviation) ===`)
  ranked.forEach((a, i) => console.log(`  ${i + 1}. attempt ${a.n}: ${a.score.toFixed(2)}%  weekPasses=${a.weekPasses}  days=${a.daysPassing}/7`))

  console.log(`\n=== WINNER: attempt ${best.n} ===`)
  console.log(`Weekly average: kcal=${best.avg.kcal.toFixed(0)} P=${best.avg.proteinG.toFixed(1)} C=${best.avg.carbsG.toFixed(1)} F=${best.avg.fatG.toFixed(1)} fib=${best.avg.fiberG.toFixed(1)}`)
  MACRO_KEYS.forEach((k) => {
    const dev = ((best.avg[k] - t[k]) / t[k]) * 100
    console.log(`  ${k.padEnd(9)} ${best.avg[k].toFixed(1)} vs ${t[k].toFixed(1)}  (${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%)`)
  })
  console.log(`\nACCEPTED on weekly average: ${best.weekPasses ? "YES" : "NO"}`)
  console.log(`Days also passing the stricter per-day gate: ${best.daysPassing}/7`)

  for (const day of best.days) {
    const d = day.totals
    console.log(`\n=== Day ${day.dayIndex} — kcal=${d.kcal.toFixed(0)} P=${d.proteinG.toFixed(1)} C=${d.carbsG.toFixed(1)} F=${d.fatG.toFixed(1)} fib=${d.fiberG.toFixed(1)} ===`)
    for (const meal of day.meals) {
      console.log(`  ${meal.slot.padEnd(12)} ${meal.items.map((i) => `${i.recipe.name} (${i.grams}g)`).join(", ") || "(empty)"}`)
    }
  }

  if (outPath) {
    const dev = (k: (typeof MACRO_KEYS)[number]) => ((best.avg[k] - t[k]) / t[k]) * 100
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          cuisine,
          dietType: ctx.dietType,
          clientName: ctx.clientName,
          target: t,
          weeklyAverage: best.avg,
          statusTitle: best.weekPasses
            ? "ACCEPTED ON WEEKLY AVERAGE — DIETITIAN REVIEW REQUIRED"
            : "NOT VALIDATED — DO NOT ISSUE TO A CLIENT",
          statusLevel: best.weekPasses ? "warn" : "error",
          statusNote: best.weekPasses
            ? `Accepted on WEEKLY-AVERAGE macros (kcal ${dev("kcal").toFixed(1)}%, protein ${dev("proteinG").toFixed(1)}%, carbs ${dev("carbsG").toFixed(1)}%, fat ${dev("fatG").toFixed(1)}%) — the same standard the exchange engine uses. Best of ${attempts.length} independent single-call attempts on ${OPENAI_MODEL}. ${best.daysPassing} of 7 days also clear the stricter per-day tolerance; the rest vary day to day around the target. Not written to the database. Portion sizes on bulky low-calorie items can be balancer artifacts — check them before issuing.`
            : `NOT accepted: weekly-average macros are outside tolerance. Best of ${attempts.length} attempts, shown for review only.`,
          provenanceNote: `Best-of-${attempts.length} selection, ${OPENAI_MODEL}, one call per attempt, no day retries. Recipe names proposed by the model; every gram computed by the production balancer. Engineering review artifact.`,
          days: best.days.map((d) => ({
            dayIndex: d.dayIndex,
            totals: d.totals,
            meals: d.meals.map((m) => ({
              slot: m.slot,
              slotOrder: ctx.slots.find((s) => s.slot === m.slot)?.slotOrder ?? 0,
              items: m.items.map((i) => ({
                name: i.recipe.name,
                grams: i.grams,
                category: i.recipe.category,
                unitLabel: i.recipe.unitLabel,
                perUnitGrams: i.recipe.perUnitGrams,
                isNonVeg: isAnimalProteinRecipe(i.recipe),
                kcal: (i.recipe.kcalPer100G * i.grams) / 100,
                proteinG: (i.recipe.proteinPer100G * i.grams) / 100,
                carbsG: (i.recipe.carbsPer100G * i.grams) / 100,
                fatG: (i.recipe.fatPer100G * i.grams) / 100,
                fiberG: (i.recipe.fiberPer100G * i.grams) / 100,
              })),
            })),
          })),
        },
        null,
        2
      )
    )
    console.log(`\nwrote ${outPath}`)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
