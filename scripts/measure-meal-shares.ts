/**
 * Dev tool (read-only): how the day's calories are split across slots in
 * saved recipe plans, and how often a sabzi or salad repeats in one week.
 *   npx tsx --env-file=.env.local scripts/measure-meal-shares.ts [--since=2026-10-13]
 */
import { eq, inArray, ilike, or } from "drizzle-orm"
import { db } from "../src/db"
import { dietPlanDays, dietPlanMeals, dietPlanRecipeItems, dietPlans, recipes } from "../src/db/schema"
import { recipeCategoryBucket } from "../src/lib/plan/recipe-category"
import { isEverydayStaple, repeatCapFor } from "../src/lib/plan/recipe-variety-tracker"

const SINCE = process.argv.find((a) => a.startsWith("--since="))?.slice(8)
const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] ?? NaN
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

async function main() {
  const plans = (
    await db
      .select({ id: dietPlans.id, targets: dietPlans.targets, region: dietPlans.region, dietType: dietPlans.dietType, generationMode: dietPlans.generationMode, createdAt: dietPlans.createdAt })
      .from(dietPlans)
      .where(eq(dietPlans.engine, "recipe"))
  ).filter((p) => p.generationMode !== "fixed_menu" && (!SINCE || p.createdAt >= new Date(SINCE)))
  const rows = await db
    .select({
      pid: dietPlanDays.dietPlanId, day: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, grams: dietPlanRecipeItems.grams,
      name: recipes.name, category: recipes.category, mainOrMid: recipes.mainOrMid, kcal: recipes.kcalPer100G, protein: recipes.proteinPer100G, fat: recipes.fatPer100G,
    })
    .from(dietPlanDays)
    .innerJoin(dietPlanMeals, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlanRecipeItems, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(recipes, eq(recipes.id, dietPlanRecipeItems.recipeId))
    .where(inArray(dietPlanDays.dietPlanId, plans.map((p) => p.id)))

  console.log(`${plans.length} recipe plans${SINCE ? ` since ${SINCE}` : ""}`)
  const shares: Record<string, number[]> = {}
  const snackShare: number[] = []
  const bfItems = new Map<string, number>()
  let dayCount = 0
  const sabziCounts: number[] = [], saladCounts: number[] = []
  let sabziOver1 = 0, saladOver1 = 0, sabziDistinct = 0, saladDistinct = 0
  const bfOddities: string[] = []
  for (const plan of plans) {
    const mine = rows.filter((r) => r.pid === plan.id)
    const perDish = new Map<string, { n: number; bucket: string; mainOrMid: string; category: string }>()
    for (const d of [...new Set(mine.map((r) => r.day))]) {
      dayCount++
      const dayRows = mine.filter((r) => r.day === d)
      const kcalBySlot = new Map<string, number>()
      for (const r of dayRows) kcalBySlot.set(r.slot, (kcalBySlot.get(r.slot) ?? 0) + (r.kcal * r.grams) / 100)
      const total = [...kcalBySlot.values()].reduce((s, k) => s + k, 0)
      let snack = 0
      for (const [slot, k] of kcalBySlot) {
        ;(shares[slot] ??= []).push(k / total)
        if (!["breakfast", "lunch", "dinner"].includes(slot)) snack += k
      }
      snackShare.push(snack / total)
      for (const r of dayRows) {
        const bucket = recipeCategoryBucket(r.category, r.name)
        if (r.slot === "breakfast") {
          bfItems.set(r.name, (bfItems.get(r.name) ?? 0) + 1)
          if (bucket === "salad" || bucket === "other" || /peanut|butter|spread/i.test(r.name)) bfOddities.push(`${r.name} [${r.category}/${r.mainOrMid}] ${r.grams} g`)
        }
        if (["lunch", "dinner"].includes(r.slot) && (bucket === "sabzi" || bucket === "salad")) {
          const e = perDish.get(r.name) ?? { n: 0, bucket, mainOrMid: r.mainOrMid, category: r.category }
          e.n++
          perDish.set(r.name, e)
        }
      }
    }
    for (const [, e] of perDish) {
      if (e.bucket === "sabzi") { sabziCounts.push(e.n); sabziDistinct++; if (e.n > 1) sabziOver1++ }
      else { saladCounts.push(e.n); saladDistinct++; if (e.n > 1) saladOver1++ }
    }
  }
  console.log(`days: ${dayCount}`)
  for (const slot of ["breakfast", "mid_morning", "lunch", "evening", "dinner", "wake_up", "bedtime"]) {
    const s = shares[slot]
    if (!s) continue
    console.log(`  ${slot.padEnd(12)} share of day kcal: median ${pct(q(s, 0.5))}  p25 ${pct(q(s, 0.25))}  p75 ${pct(q(s, 0.75))}  (n=${s.length})`)
  }
  console.log(`  all snacks combined: median ${pct(q(snackShare, 0.5))}  p25 ${pct(q(snackShare, 0.25))}  p75 ${pct(q(snackShare, 0.75))}`)
  const hist = (a: number[]) => [1, 2, 3, 4, 5].map((k) => `${k}x: ${a.filter((n) => n === k).length}`).join(", ") + `, 6+: ${a.filter((n) => n >= 6).length}`
  console.log(`sabzi dishes at lunch/dinner (distinct per week): ${sabziDistinct}; weekly count histogram ${hist(sabziCounts)}`)
  console.log(`salad/raita dishes at lunch/dinner (distinct per week): ${saladDistinct}; weekly count histogram ${hist(saladCounts)}`)
  console.log(`top breakfast items: ${[...bfItems].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n}(${c})`).join(", ")}`)
  console.log(`breakfast oddities (raita/other/spread): ${bfOddities.length}`)
  const odd = new Map<string, number>()
  for (const o of bfOddities) odd.set(o.replace(/ \d+ g$/, ""), (odd.get(o.replace(/ \d+ g$/, "")) ?? 0) + 1)
  for (const [o, c] of [...odd].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${o}: ${c}`)

  const special = await db.select({ name: recipes.name, category: recipes.category, mainOrMid: recipes.mainOrMid, min: recipes.minGrams, ideal: recipes.idealGrams, max: recipes.maxGrams, kcal: recipes.kcalPer100G, protein: recipes.proteinPer100G, fat: recipes.fatPer100G, cuisine: recipes.cuisine }).from(recipes).where(or(ilike(recipes.name, "%peanut butter%"), ilike(recipes.name, "%veg raita%")))
  for (const s of special) console.log(`  ${s.name} | ${s.category} | ${s.mainOrMid} | ${s.min}/${s.ideal}/${s.max} g | ${s.kcal} kcal, P${s.protein} F${s.fat} /100g | staple=${isEverydayStaple(s)} cap=${repeatCapFor(s)} bucket=${recipeCategoryBucket(s.category, s.name)}`)
  process.exit(0)
}
main()
