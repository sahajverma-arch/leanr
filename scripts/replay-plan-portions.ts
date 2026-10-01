/**
 * Dev tool: replays the production balance + repairWeek() pipeline over the
 * dish sets of every saved recipe plan, and reports how realistic the
 * resulting lunch/dinner plates are (sabzi count per meal, portion sizes)
 * alongside macro convergence. Never writes.
 *
 *   npx tsx --env-file=.env.local scripts/replay-plan-portions.ts [--new-limits]
 *
 * --new-limits recomputes every recipe's serving range from its raw CSV row
 * with the CURRENT recipe-quantity-normalize.ts, i.e. what a re-seed would
 * store, so a fix can be measured before the database is re-seeded.
 */
import { eq, inArray } from "drizzle-orm"
import { db } from "../src/db"
import { dietPlanDays, dietPlanMeals, dietPlanRecipeItems, dietPlans, recipes } from "../src/db/schema"
import { isRecipeAllowedForDiet } from "../src/lib/foods/recipe-animal-content"
import { eligibleCuisinesFor, RECIPE_CUISINES, type RecipeCuisine } from "../src/lib/foods/recipe-cuisine-mapping"
import { filterRecipePool } from "../src/lib/foods/recipe-pool-filters"
import { computeServingLimits } from "../src/lib/foods/recipe-quantity-normalize"
import type { RawRecipeRow } from "../src/lib/foods/recipe-csv-parser"
import { balanceDayToTargets } from "../src/lib/plan/recipe-balancer"
import { recipeCategoryBucket } from "../src/lib/plan/recipe-category"
import { computeMealsTotals } from "../src/lib/plan/recipe-grounding"
import { describePlausibilityProblems } from "../src/lib/plan/recipe-plausibility-validate"
import { buildRepairPool, repairWeek } from "../src/lib/plan/recipe-repair"
import { RECIPE_PIPELINE_COLUMNS, type DailyRecipeTarget, type GroundedRecipeDay, type RecipeForPipeline } from "../src/lib/plan/recipe-types"
import { isRecipeDayOffTarget, isRecipeWeekOffTarget } from "../src/lib/plan/recipe-validate"

const NEW_LIMITS = process.argv.includes("--new-limits")

async function main() {
  const plans = (await db.select().from(dietPlans).where(eq(dietPlans.engine, "recipe"))).filter((p) => p.generationMode !== "fixed_menu")
  const recipeRows = await db.select({ ...RECIPE_PIPELINE_COLUMNS, raw: recipes.rawCsvRow }).from(recipes)
  const byId = new Map<string, RecipeForPipeline>()
  for (const { raw, ...r } of recipeRows) {
    if (NEW_LIMITS) {
      const l = computeServingLimits(raw as RawRecipeRow)
      byId.set(r.id, { ...r, minGrams: l.minGrams, maxGrams: l.maxGrams, idealGrams: l.idealGrams })
    } else byId.set(r.id, r)
  }
  const rows = await db
    .select({ pid: dietPlanDays.dietPlanId, day: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, order: dietPlanMeals.slotOrder, recipeId: dietPlanRecipeItems.recipeId, grams: dietPlanRecipeItems.grams })
    .from(dietPlanDays)
    .innerJoin(dietPlanMeals, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlanRecipeItems, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .where(inArray(dietPlanDays.dietPlanId, plans.map((p) => p.id)))

  let days = 0, daysOk = 0, weeksOk = 0, meals = 0, twoSabzi = 0, problems = 0, rotiOnlyMeals = 0, oneRoti = 0
  const grams: Record<string, number[]> = { sabzi: [], dal_curry: [], rice_pulao: [], bread: [] }
  for (const plan of plans) {
    const t = plan.targets as { kcal: number; proteinG: number; carbsG: number; fatG: number; fibreG: number }
    const target: DailyRecipeTarget = { kcal: t.kcal, proteinG: t.proteinG, carbsG: t.carbsG, fatG: t.fatG, fiberG: t.fibreG }
    const cuisine = ((RECIPE_CUISINES as readonly string[]).includes(plan.region) ? plan.region : "General") as RecipeCuisine
    const cuisines = eligibleCuisinesFor(cuisine)
    const pool = filterRecipePool([...byId.values()].filter((r) => r.isActive && (cuisines as readonly string[]).includes(r.cuisine) && isRecipeAllowedForDiet(r, plan.dietType)))
    const constraints = { dietType: plan.dietType, eligibleCuisines: cuisines, allergenTags: [] as string[] }
    const mine = rows.filter((r) => r.pid === plan.id)
    const weekDays: GroundedRecipeDay[] = [...new Set(mine.map((r) => r.day))].sort((a, b) => a - b).map((d) => {
      const dayRows = mine.filter((r) => r.day === d)
      const slots = [...new Map(dayRows.map((r) => [r.slot, r.order])).entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s)
      const ms = slots.map((slot) => ({ slot, items: dayRows.filter((r) => r.slot === slot).map((r) => { const recipe = byId.get(r.recipeId)!; return { recipe, grams: recipe.idealGrams } }) }))
      return balanceDayToTargets({ dayIndex: d, meals: ms, totals: computeMealsTotals(ms), cappedRecipeNames: [], unknownRecipeNames: [] }, target)
    })
    const repaired = repairWeek(weekDays, target, buildRepairPool(pool, cuisine), constraints).days
    const avg = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 }
    for (const d of repaired) {
      days++
      if (!isRecipeDayOffTarget(d.totals, target)) daysOk++
      problems += describePlausibilityProblems(d, constraints).length
      for (const k of Object.keys(avg) as (keyof typeof avg)[]) avg[k] += d.totals[k] / repaired.length
      for (const m of d.meals) {
        if (!["lunch", "dinner"].includes(m.slot)) continue
        meals++
        const b = m.items.map((i) => ({ bucket: recipeCategoryBucket(i.recipe.category, i.recipe.name), g: i.grams }))
        if (b.filter((x) => x.bucket === "sabzi").length >= 2) twoSabzi++
        for (const x of b) grams[x.bucket]?.push(x.g)
        const rotis = m.items.filter((i) => i.recipe.unitLabel === "piece" && /roti|paratha|thepla|bhakri/i.test(i.recipe.category))
        const otherStaple = b.some((x) => x.bucket === "rice_pulao")
        if (rotis.length > 0 && !otherStaple) {
          rotiOnlyMeals++
          const pieces = rotis.reduce((n, i) => n + i.grams / (i.recipe.perUnitGrams ?? i.grams), 0)
          if (pieces < 1.9) oneRoti++
        }
      }
    }
    if (!isRecipeWeekOffTarget(avg, target)) weeksOk++
  }
  const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))]
  console.log(`${NEW_LIMITS ? "NEW" : "CURRENT"} limits — plans ${plans.length}, days within ±8%: ${daysOk}/${days}, weeks passing: ${weeksOk}/${plans.length}, plausibility problems: ${problems}`)
  console.log(`lunch/dinner meals ${meals}, with 2+ sabzi: ${twoSabzi}; roti as only staple: ${rotiOnlyMeals}, of which under 2 rotis: ${oneRoti}`)
  const floor: Record<string, number> = { sabzi: 100, dal_curry: 120, rice_pulao: 150, bread: 80 }
  for (const [k, a] of Object.entries(grams)) console.log(`  ${k.padEnd(10)} n=${a.length} p10=${q(a, 0.1)} p25=${q(a, 0.25)} med=${q(a, 0.5)} p75=${q(a, 0.75)}  below ${floor[k]} g: ${a.filter((g) => g < floor[k]).length}`)
  process.exit(0)
}
main()
