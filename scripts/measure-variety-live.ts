/**
 * Dev tool: run the production selectRecipes() for several real roadmaps and
 * report how varied the resulting weeks are — within each week and across
 * them. Makes real OpenAI calls (RECIPE_BEST_OF_N per run). Never writes.
 *
 *   npx tsx --env-file=.env.local scripts/measure-variety-live.ts "North Indian" <roadmapId>... [--runs 1] [--no-seed]
 *
 * --no-seed leaves varietySeed unset: the prompt is then exactly as it was
 * before recipe-week-rotation.ts (the code-side variety pass still runs).
 * Never imported by production code.
 */
import { randomUUID } from "crypto"

import { buildRecipeRunContext } from "./lib/recipe-run-input"
import type { RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { env } from "../src/lib/env"
import { selectRecipes } from "../src/lib/plan/recipe-selector"
import type { GroundedRecipeDay } from "../src/lib/plan/recipe-types"
import { computeWeeklyAverage } from "../src/lib/plan/recipe-week-score"
import { findBackToBackRepeats, findVarietyViolations, isEverydayStaple } from "../src/lib/plan/recipe-variety-tracker"

function dishes(days: GroundedRecipeDay[]) {
  return days.flatMap((d) => d.meals.flatMap((m) => m.items.map((i) => i.recipe)))
}

async function main() {
  const args = process.argv.slice(2)
  const cuisine = args[0] as RecipeCuisine
  const runsAt = args.indexOf("--runs")
  const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 1
  const noSeed = args.includes("--no-seed")
  const roadmapIds = args.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i] !== String(runs))

  const weeks: { label: string; days: GroundedRecipeDay[] }[] = []
  for (const roadmapId of roadmapIds) {
    const ctx = await buildRecipeRunContext(roadmapId, cuisine)
    for (let run = 0; run < runs; run++) {
      const input = noSeed ? ctx.input : { ...ctx.input, varietySeed: `${roadmapId}:1:${randomUUID()}` }
      const t0 = Date.now()
      const result = await selectRecipes(input, ctx.constraints, {
        bestOfN: env.RECIPE_BEST_OF_N,
        onAttempt: (log) => {
          if (!log.validationResult.ok) console.log(`  attempt ${log.attemptNumber} failed after ${log.latencyMs}ms: ${log.validationResult.errors.join("; ").slice(0, 300)}`)
        },
      })
      const days = result.selection.days
      const all = dishes(days)
      const mains = all.filter((r) => !isEverydayStaple(r))
      const avg = computeWeeklyAverage(days)
      const pct = (a: number, t: number) => `${(((a - t) / t) * 100).toFixed(1)}%`
      console.log(`\n${ctx.clientName} (${ctx.dietType}) run ${run + 1} — ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.repairSwaps.length} repair swaps`)
      console.log(
        `  items ${all.length}, distinct ${new Set(all.map((r) => r.name)).size}; dishes ${mains.length}, distinct dishes ${new Set(mains.map((r) => r.name)).size}`
      )
      console.log(
        `  over cap: ${findVarietyViolations(days).map((v) => `${v.name} x${v.count}`).join(", ") || "none"}; back-to-back: ${findBackToBackRepeats(days).map((r) => `${r.name}@d${r.dayIndex}`).join(", ") || "none"}`
      )
      console.log(
        `  weekly avg vs target: kcal ${pct(avg.kcal, ctx.dailyTarget.kcal)}, P ${pct(avg.proteinG, ctx.dailyTarget.proteinG)}, C ${pct(avg.carbsG, ctx.dailyTarget.carbsG)}, F ${pct(avg.fatG, ctx.dailyTarget.fatG)}`
      )
      for (const slot of ["breakfast", "lunch", "dinner", "evening"]) {
        console.log(`  ${slot.padEnd(9)} ${days.map((d) => d.meals.find((m) => m.slot === slot)?.items.map((i) => i.recipe.name).join(" + ") ?? "-").join(" | ")}`)
      }
      weeks.push({ label: `${ctx.clientName} #${run + 1}`, days })
    }
  }

  const sets = weeks.map((w) => new Set(dishes(w.days).map((r) => r.name)))
  let total = 0
  let pairs = 0
  for (let a = 0; a < sets.length; a++)
    for (let b = a + 1; b < sets.length; b++) {
      let shared = 0
      for (const x of sets[a]) if (sets[b].has(x)) shared++
      total += shared / (sets[a].size + sets[b].size - shared)
      pairs++
    }
  const freq = new Map<string, number>()
  for (const s of sets) for (const d of s) freq.set(d, (freq.get(d) ?? 0) + 1)
  console.log(`\n${weeks.length} weeks, mean pairwise overlap ${((total / Math.max(1, pairs)) * 100).toFixed(0)}%, ${freq.size} distinct dishes overall`)
  console.log(`in every week: ${[...freq].filter(([, c]) => c === weeks.length).map(([d]) => d).join(", ") || "none"}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
