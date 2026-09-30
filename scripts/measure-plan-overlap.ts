/**
 * Dev tool: how much do different clients' recipe plans share? Never writes.
 * Never imported by production code.
 *   npx tsx --env-file=.env.local scripts/measure-plan-overlap.ts ["North Indian"]
 */
import { eq, inArray } from "drizzle-orm"
import { db } from "../src/db"
import { clients, dietPlanDays, dietPlanMeals, dietPlanRecipeItems, dietPlans, recipes } from "../src/db/schema"

async function main() {
  const cuisine = process.argv[2] ?? "North Indian"
  const plans = (
    await db
      .select({ p: dietPlans, name: clients.name })
      .from(dietPlans)
      .innerJoin(clients, eq(dietPlans.clientId, clients.id))
      .where(eq(dietPlans.engine, "recipe"))
  )
    .filter((x) => x.p.region === cuisine)
    .sort((a, b) => +a.p.createdAt - +b.p.createdAt)
  const allRows = await db
    .select({ pid: dietPlanDays.dietPlanId, day: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, n: recipes.name })
    .from(dietPlanDays)
    .innerJoin(dietPlanMeals, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
    .innerJoin(dietPlanRecipeItems, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
    .innerJoin(recipes, eq(recipes.id, dietPlanRecipeItems.recipeId))
    .where(inArray(dietPlanDays.dietPlanId, plans.map((x) => x.p.id)))

  const sets = plans.map(({ p, name }) => {
    const rows = allRows.filter((r) => r.pid === p.id)
    const bySlot = new Map<string, Set<string>>()
    for (const r of rows) {
      const s = bySlot.get(r.slot) ?? new Set<string>()
      s.add(r.n)
      bySlot.set(r.slot, s)
    }
    return { label: `${name.slice(0, 12)} ${p.dietType.slice(0, 7)} ${p.createdAt.toISOString().slice(5, 10)}`, s: new Set(rows.map((r) => r.n)), bySlot, rows }
  })
  const jac = (a: Set<string>, b: Set<string>) => {
    let i = 0
    for (const x of a) if (b.has(x)) i++
    return i / (a.size + b.size - i)
  }
  let tot = 0
  let n = 0
  for (let a = 0; a < sets.length; a++)
    for (let b = a + 1; b < sets.length; b++) {
      tot += jac(sets[a].s, sets[b].s)
      n++
    }
  console.log(`${sets.length} ${cuisine} plans, mean pairwise overlap (Jaccard of distinct dishes) ${((tot / Math.max(1, n)) * 100).toFixed(0)}%`)
  const freq = new Map<string, number>()
  for (const x of sets) for (const d of x.s) freq.set(d, (freq.get(d) ?? 0) + 1)
  console.log(`distinct dishes used across ALL these plans: ${freq.size}`)
  console.log("dishes in >= half of the plans:")
  for (const [d, c] of [...freq].sort((a, b) => b[1] - a[1])) if (c >= sets.length / 2) console.log(`  ${d}: ${c}/${sets.length}`)
  for (const slot of ["breakfast", "mid_morning", "lunch", "evening", "dinner"]) {
    const f = new Map<string, number>()
    for (const x of sets) for (const d of x.bySlot.get(slot) ?? []) f.set(d, (f.get(d) ?? 0) + 1)
    console.log(`${slot}: ${f.size} distinct across plans; top ${[...f].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, c]) => `${d}(${c})`).join(", ")}`)
  }
  // Lunch/dinner plate shape: how many days are "Roti + X" / "Rice + X"
  const last = sets[sets.length - 1]
  if (last) {
    console.log(`\nMost recent: ${last.label}`)
    const byDaySlot = new Map<string, string[]>()
    for (const r of last.rows) {
      const k = `${r.slot}|${r.day}`
      byDaySlot.set(k, [...(byDaySlot.get(k) ?? []), r.n])
    }
    for (const slot of ["breakfast", "mid_morning", "lunch", "evening", "dinner"])
      for (let d = 0; d < 7; d++) {
        const v = byDaySlot.get(`${slot}|${d}`)
        if (v) console.log(`  ${slot} d${d}: ${v.join(" + ")}`)
      }
  }
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
