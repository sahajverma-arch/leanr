/**
 * Dev tool: how evenly breakfast, lunch and dinner split the day's calories,
 * and whether a chosen protein-rich meal actually carries the most protein.
 * Replays the production balance + repairWeek() over the dish sets of every
 * saved recipe plan (never writes), and compares with the grams stored.
 *
 *   npx tsx --env-file=.env.local scripts/measure-meal-balance.ts [--rich=lunch|dinner|breakfast]
 */
import { eq, inArray } from "drizzle-orm"
import { db } from "../src/db"
import { dietPlanDays, dietPlanMeals, dietPlanRecipeItems, dietPlans, recipes } from "../src/db/schema"
import { isRecipeAllowedForDiet } from "../src/lib/foods/recipe-animal-content"
import { eligibleCuisinesFor, RECIPE_CUISINES, type RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { filterRecipePool } from "../src/lib/foods/recipe-pool-filters"
import { balanceDayToTargets } from "../src/lib/plan/recipe-balancer"
import { computeMealsTotals } from "../src/lib/plan/recipe-grounding"
import { describeMealBalanceProblems, isMainMealSlot, MEAL_KCAL_SHARE_TOLERANCE, PROTEIN_RICH_SHARE, slotKcalTargets } from "../src/lib/plan/recipe-meal-balance"
import { describePlausibilityProblems } from "../src/lib/plan/recipe-plausibility-validate"
import { buildRepairPool, repairWeek } from "../src/lib/plan/recipe-repair"
import { RECIPE_PIPELINE_COLUMNS, type DailyRecipeTarget, type GroundedRecipeDay, type RecipeForPipeline } from "../src/lib/plan/recipe-types"
import { isRecipeDayOffTarget, isRecipeWeekOffTarget } from "../src/lib/plan/recipe-validate"
import { findBackToBackRepeats, findVarietyViolations, varietyClassOf } from "../src/lib/plan/recipe-variety-tracker"

const RICH = process.argv.find((a) => a.startsWith("--rich="))?.slice(7)
const VERBOSE = process.argv.includes("--verbose")

/** How many sabzis repeat (count > 1) and salads/raitas repeat past 2 in a week — the dietitian's 29 Oct complaint. */
function sideRepeats(days: GroundedRecipeDay[]) {
  const counts = new Map<string, { n: number; cls: string }>()
  for (const d of days) for (const m of d.meals) for (const i of m.items) {
    const e = counts.get(i.recipe.name) ?? { n: 0, cls: varietyClassOf(i.recipe) }
    e.n++
    counts.set(i.recipe.name, e)
  }
  let sabziRepeats = 0, saladOver = 0
  for (const e of counts.values()) {
    if (e.cls === "sabzi" && e.n > 1) sabziRepeats++
    if (e.cls === "salad" && e.n > 2) saladOver++
  }
  return { sabziRepeats, saladOver }
}

/** A problem string with slot and dish names stripped, so problems of one kind group together. */
function problemKind(p: string): string {
  return p.replace(/^[a-z_]+('s)? /, "").replace(/"[^"]+"/g, '"…"').replace(/\([^)]*\)/g, "(…)").slice(0, 70)
}

/** Per-slot share of the day's calories (median over days), for the headline. */
const slotShares: Record<string, number[]> = {}

function splitStats(days: GroundedRecipeDay[], target: DailyRecipeTarget, collectShares = false) {
  const devs: number[] = []
  let richOk = 0, richDays = 0, richMost = 0, richFloor = 0
  for (const d of days) {
    const kcal = (m: GroundedRecipeDay["meals"][number]) => m.items.reduce((s, i) => s + (i.recipe.kcalPer100G * i.grams) / 100, 0)
    const prot = (m: GroundedRecipeDay["meals"][number]) => m.items.reduce((s, i) => s + (i.recipe.proteinPer100G * i.grams) / 100, 0)
    const mains = d.meals.filter((m) => isMainMealSlot(m.slot) && m.items.length > 0)
    const withFood = d.meals.filter((m) => m.items.length > 0)
    const targets = slotKcalTargets(withFood.map((m) => ({ slot: m.slot, kcal: kcal(m) })), target.kcal)
    // Worst slot's gap from its share, as a fraction of the DAY's calories (recipe-meal-balance.ts).
    if (targets.size > 0) devs.push(Math.max(...withFood.filter((m) => targets.has(m.slot)).map((m) => Math.abs(kcal(m) - targets.get(m.slot)!) / target.kcal)))
    if (collectShares) {
      const dayKcal = withFood.reduce((s, m) => s + kcal(m), 0)
      for (const m of withFood) (slotShares[m.slot] ??= []).push(kcal(m) / dayKcal)
    }
    if (RICH) {
      const rich = mains.find((m) => m.slot === RICH)
      if (rich) {
        richDays++
        if (mains.every((m) => m === rich || prot(m) <= prot(rich))) richMost++
        if (prot(rich) >= PROTEIN_RICH_SHARE * target.proteinG - 0.5) richFloor++
        if (mains.every((m) => m === rich || prot(m) <= prot(rich)) && prot(rich) >= PROTEIN_RICH_SHARE * target.proteinG - 0.5) richOk++
      }
    }
  }
  return { devs, richOk, richDays, richMost, richFloor }
}

const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] ?? NaN
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

async function main() {
  const plans = (
    await db
      .select({ id: dietPlans.id, targets: dietPlans.targets, region: dietPlans.region, dietType: dietPlans.dietType, generationMode: dietPlans.generationMode })
      .from(dietPlans)
      .where(eq(dietPlans.engine, "recipe"))
  ).filter((p) => p.generationMode !== "fixed_menu")
  const recipeRows = await db.select(RECIPE_PIPELINE_COLUMNS).from(recipes)
  const byId = new Map<string, RecipeForPipeline>(recipeRows.map((r) => [r.id, r]))
  const rows = await db
    .select({ pid: dietPlanDays.dietPlanId, day: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, order: dietPlanMeals.slotOrder, recipeId: dietPlanRecipeItems.recipeId, grams: dietPlanRecipeItems.grams })
    .from(dietPlanDays)
    .innerJoin(dietPlanMeals, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlanRecipeItems, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .where(inArray(dietPlanDays.dietPlanId, plans.map((p) => p.id)))

  let days = 0, daysOk = 0, weeksOk = 0, problems = 0, balanceWarnDays = 0, swaps = 0
  let sabziB = 0, sabziA = 0, saladB = 0, saladA = 0, overCapA = 0, backToBackA = 0
  const kinds = new Map<string, number>()
  const before: number[] = [], after: number[] = []
  let richOkB = 0, richOkA = 0, richDays = 0, mostA = 0, floorA = 0, mostB = 0
  const t0 = Date.now()
  for (const plan of plans) {
    const t = plan.targets as { kcal: number; proteinG: number; carbsG: number; fatG: number; fibreG: number }
    const target: DailyRecipeTarget = { kcal: t.kcal, proteinG: t.proteinG, carbsG: t.carbsG, fatG: t.fatG, fiberG: t.fibreG, ...(RICH ? { proteinRichSlot: RICH } : {}) }
    const cuisine = ((RECIPE_CUISINES as readonly string[]).includes(plan.region) ? plan.region : "General") as RecipeCuisine
    const cuisines = eligibleCuisinesFor(cuisine)
    const pool = filterRecipePool([...byId.values()].filter((r) => r.isActive && (cuisines as readonly string[]).includes(r.cuisine) && isRecipeAllowedForDiet(r, plan.dietType)))
    const constraints = { dietType: plan.dietType, eligibleCuisines: cuisines, allergenTags: [] as string[] }
    const mine = rows.filter((r) => r.pid === plan.id)
    const build = (useStored: boolean) =>
      [...new Set(mine.map((r) => r.day))].sort((a, b) => a - b).map((d) => {
        const dayRows = mine.filter((r) => r.day === d)
        const slots = [...new Map(dayRows.map((r) => [r.slot, r.order])).entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s)
        const ms = slots.map((slot) => ({ slot, items: dayRows.filter((r) => r.slot === slot).map((r) => { const recipe = byId.get(r.recipeId)!; return { recipe, grams: useStored ? r.grams : recipe.idealGrams } }) }))
        return { dayIndex: d, meals: ms, totals: computeMealsTotals(ms), cappedRecipeNames: [], unknownRecipeNames: [] } as GroundedRecipeDay
      })
    const stored = build(true)
    const b = splitStats(stored, target)
    before.push(...b.devs); richOkB += b.richOk; mostB += b.richMost
    const sb = sideRepeats(stored); sabziB += sb.sabziRepeats; saladB += sb.saladOver
    const balanced = build(false).map((d) => balanceDayToTargets(d, target))
    const result = repairWeek(balanced, target, buildRepairPool(pool, cuisine), constraints)
    swaps += result.swaps.length
    const a = splitStats(result.days, target, true)
    after.push(...a.devs); richOkA += a.richOk; richDays += a.richDays; mostA += a.richMost; floorA += a.richFloor
    const sa = sideRepeats(result.days); sabziA += sa.sabziRepeats; saladA += sa.saladOver
    overCapA += findVarietyViolations(result.days).length
    backToBackA += findBackToBackRepeats(result.days).length
    const avg = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
    let planDaysOk = 0, planProblems = 0
    for (const d of result.days) {
      days++
      if (!isRecipeDayOffTarget(d.totals, target)) { daysOk++; planDaysOk++ }
      const ps = describePlausibilityProblems(d, constraints)
      problems += ps.length; planProblems += ps.length
      for (const p of ps) kinds.set(problemKind(p), (kinds.get(problemKind(p)) ?? 0) + 1)
      if (describeMealBalanceProblems(d, target.kcal, target.proteinG, target.proteinRichSlot).length > 0) balanceWarnDays++
      for (const k of Object.keys(avg) as (keyof typeof avg)[]) avg[k] += d.totals[k] / result.days.length
    }
    const weekOk = !isRecipeWeekOffTarget(avg, target)
    if (weekOk) weeksOk++
    if (VERBOSE) {
      const dev = (k: keyof typeof avg) => `${(((avg[k] - target[k]) / target[k]) * 100).toFixed(1)}%`
      console.log(`  ${plan.id.slice(0, 8)} ${cuisine.padEnd(12)} ${plan.dietType.padEnd(14)} week ${weekOk ? "PASS" : "FAIL"}  kcal ${dev("kcal")} P ${dev("proteinG")} C ${dev("carbsG")} F ${dev("fatG")}  days ok ${planDaysOk}/${result.days.length}  problems ${planProblems}  sabzi repeats ${sa.sabziRepeats}  salads >2: ${sa.saladOver}`)
    }
  }
  console.log(`plans ${plans.length}${RICH ? `, protein-rich=${RICH}` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)}s, repair swaps ${swaps}`)
  console.log(`days within ±8%: ${daysOk}/${days}; weeks passing: ${weeksOk}/${plans.length}; plausibility problems: ${problems}; days with a meal-balance warning: ${balanceWarnDays}`)
  const tol = MEAL_KCAL_SHARE_TOLERANCE
  console.log(`worst slot gap from its calorie share (points of the day) — stored: med ${pct(q(before, 0.5))} p90 ${pct(q(before, 0.9))} within ±${pct(tol)}: ${before.filter((x) => x <= tol).length}/${before.length}`)
  console.log(`                                                        replay: med ${pct(q(after, 0.5))} p90 ${pct(q(after, 0.9))} within ±${pct(tol)}: ${after.filter((x) => x <= tol).length}/${after.length}`)
  for (const slot of ["breakfast", "mid_morning", "lunch", "evening", "dinner", "wake_up", "bedtime"]) {
    const s = slotShares[slot]
    if (s) console.log(`  replay ${slot.padEnd(12)} median share of day kcal ${pct(q(s, 0.5))} (p25 ${pct(q(s, 0.25))}, p75 ${pct(q(s, 0.75))})`)
  }
  if (RICH) console.log(`protein-rich ${RICH} has the most protein and >= ${pct(PROTEIN_RICH_SHARE)}: stored ${richOkB}/${richDays}, replay ${richOkA}/${richDays} (most protein: stored ${mostB}, replay ${mostA}; at the floor: replay ${floorA})`)
  console.log(`sabzis served more than once in a week: stored ${sabziB}, replay ${sabziA}; salads/raitas more than twice: stored ${saladB}, replay ${saladA}; replay over any cap: ${overCapA}, back-to-back: ${backToBackA}`)
  console.log("plausibility problems by kind (replay):")
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${k}`)
  process.exit(0)
}
main()
