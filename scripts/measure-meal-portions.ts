/**
 * Dev tool: how realistic are lunch/dinner plates on saved recipe plans?
 * Counts sabzi/dal/staple dishes per meal and their grams. Never writes.
 *   npx tsx --env-file=.env.local scripts/measure-meal-portions.ts
 */
import { eq, inArray } from "drizzle-orm"
import { db } from "../src/db"
import { clients, dietPlanDays, dietPlanMeals, dietPlanRecipeItems, dietPlans, recipes } from "../src/db/schema"
import { recipeCategoryBucket } from "../src/lib/plan/recipe-category"

async function main() {
  const plans = await db
    .select({ id: dietPlans.id, name: clients.name, created: dietPlans.createdAt, mode: dietPlans.generationMode })
    .from(dietPlans)
    .innerJoin(clients, eq(dietPlans.clientId, clients.id))
    .where(eq(dietPlans.engine, "recipe"))
  const rows = await db
    .select({
      pid: dietPlanDays.dietPlanId, day: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, mealId: dietPlanMeals.id,
      name: recipes.name, category: recipes.category, mainOrMid: recipes.mainOrMid, grams: dietPlanRecipeItems.grams,
      min: recipes.minGrams, ideal: recipes.idealGrams, max: recipes.maxGrams, unit: recipes.unitLabel, per: recipes.perUnitGrams,
    })
    .from(dietPlanDays)
    .innerJoin(dietPlanMeals, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlanRecipeItems, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(recipes, eq(recipes.id, dietPlanRecipeItems.recipeId))
    .where(inArray(dietPlanDays.dietPlanId, plans.map((p) => p.id)))

  const byMeal = new Map<string, typeof rows>()
  for (const r of rows) byMeal.set(r.mealId, [...(byMeal.get(r.mealId) ?? []), r])
  let meals = 0, twoSabzi = 0, sabziPlusDal = 0
  const grams: Record<string, number[]> = { sabzi: [], dal_curry: [], rice_pulao: [], bread: [] }
  const ranges: Record<string, number[][]> = { sabzi: [], dal_curry: [], rice_pulao: [], bread: [] }
  const examples: string[] = []
  for (const items of byMeal.values()) {
    if (!["lunch", "dinner"].includes(items[0].slot)) continue
    meals++
    const b = items.map((i) => ({ ...i, bucket: recipeCategoryBucket(i.category, i.name) }))
    const sabzi = b.filter((i) => i.bucket === "sabzi")
    if (sabzi.length >= 2) {
      twoSabzi++
      if (examples.length < 12) examples.push(`${items[0].slot}: ${b.map((i) => `${i.name}[${i.bucket}/${i.category}] ${i.grams}g`).join(" + ")}`)
    }
    if (sabzi.length >= 1 && b.some((i) => i.bucket === "dal_curry")) sabziPlusDal++
    for (const i of b) if (grams[i.bucket]) { grams[i.bucket].push(i.grams); ranges[i.bucket].push([i.min, i.ideal, i.max]) }
  }
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))] }
  console.log(`plans ${plans.length}, lunch/dinner meals ${meals}, meals with 2+ sabzi ${twoSabzi}, with sabzi+dal ${sabziPlusDal}`)
  for (const [k, a] of Object.entries(grams)) {
    if (!a.length) continue
    const r = ranges[k]
    console.log(`${k.padEnd(10)} n=${a.length} grams p10=${q(a, 0.1)} p25=${q(a, 0.25)} med=${q(a, 0.5)} p75=${q(a, 0.75)} | <=60g: ${a.filter((g) => g <= 60).length} | authored min med=${q(r.map((x) => x[0]), 0.5)} ideal med=${q(r.map((x) => x[1]), 0.5)} max med=${q(r.map((x) => x[2]), 0.5)}`)
  }
  console.log("\nexamples of 2+ sabzi:\n" + examples.join("\n"))
  process.exit(0)
}
main()
