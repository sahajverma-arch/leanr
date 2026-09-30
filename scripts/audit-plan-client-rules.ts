/**
 * Audits EVERY saved diet plan, both engines, against its client's CURRENT
 * counselling answers: diet type (by the dish's own evidence), declared
 * allergies, and dislikes — the same rule the plan page's red banner and
 * approval use (src/lib/plan/client-food-rules.ts). Read-only; never writes.
 *
 *   npx tsx --env-file=.env.local scripts/audit-plan-client-rules.ts
 *
 * Run it after any change to the matching rules or the recipe data, and
 * whenever a client reports being given something they said they don't eat.
 */
import { eq, inArray } from "drizzle-orm"

import { db } from "@/db"
import {
  clients,
  counsellingSessions,
  dietPlanDays,
  dietPlanItems,
  dietPlanMeals,
  dietPlanRecipeItems,
  dietPlans,
  foods,
  recipes,
  roadmaps,
} from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { clientFoodRules, foodRuleViolation, recipeRuleViolation } from "@/lib/plan/client-food-rules"

async function main() {
  const plans = await db
    .select({ plan: dietPlans, clientName: clients.name, answers: counsellingSessions.answers })
    .from(dietPlans)
    .innerJoin(clients, eq(dietPlans.clientId, clients.id))
    .innerJoin(roadmaps, eq(dietPlans.roadmapId, roadmaps.id))
    .innerJoin(counsellingSessions, eq(roadmaps.sessionId, counsellingSessions.id))

  const planIds = plans.map((p) => p.plan.id)
  const recipeRows = planIds.length
    ? await db
        .select({ planId: dietPlanDays.dietPlanId, dayIndex: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, name: recipes.name, dietTypes: recipes.dietTypes, allergenTags: recipes.allergenTags })
        .from(dietPlanRecipeItems)
        .innerJoin(dietPlanMeals, eq(dietPlanRecipeItems.dietPlanMealId, dietPlanMeals.id))
        .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
        .innerJoin(recipes, eq(dietPlanRecipeItems.recipeId, recipes.id))
        .where(inArray(dietPlanDays.dietPlanId, planIds))
    : []
  const foodRows = planIds.length
    ? await db
        .select({ planId: dietPlanDays.dietPlanId, dayIndex: dietPlanDays.dayIndex, slot: dietPlanMeals.slot, nameEn: foods.nameEn, dietTypes: foods.dietTypes, allergens: foods.allergens })
        .from(dietPlanItems)
        .innerJoin(dietPlanMeals, eq(dietPlanItems.dietPlanMealId, dietPlanMeals.id))
        .innerJoin(dietPlanDays, eq(dietPlanMeals.dietPlanDayId, dietPlanDays.id))
        .innerJoin(foods, eq(dietPlanItems.foodId, foods.id))
        .where(inArray(dietPlanDays.dietPlanId, planIds))
    : []

  let flagged = 0
  let approvedFlagged = 0
  const byKind = { diet: 0, allergy: 0, dislike: 0 }
  for (const { plan, clientName, answers } of plans.sort((a, b) => +a.plan.createdAt - +b.plan.createdAt)) {
    const rules = clientFoodRules(answers as Answers, plan.dietType)
    const hits = new Map<string, { reason: string; where: string[] }>()
    const record = (name: string, reason: string | null, dayIndex: number, slot: string) => {
      if (!reason) return
      const h = hits.get(name) ?? { reason, where: [] }
      h.where.push(`d${dayIndex + 1} ${slot}`)
      hits.set(name, h)
    }
    for (const r of recipeRows.filter((x) => x.planId === plan.id)) record(r.name, recipeRuleViolation(r, rules), r.dayIndex, r.slot)
    for (const f of foodRows.filter((x) => x.planId === plan.id)) record(f.nameEn, foodRuleViolation(f, rules), f.dayIndex, f.slot)
    if (hits.size === 0) continue

    flagged++
    if (plan.status === "approved") approvedFlagged++
    const a = answers as Answers
    console.log(
      `\n${plan.status.toUpperCase()} ${plan.engine} plan ${plan.id} — ${clientName}, week ${plan.weekNumber}, ${plan.dietType}, created ${plan.createdAt.toISOString().slice(0, 10)}`
    )
    console.log(`  answers: diet=${JSON.stringify(a.q33 ?? null)} allergies=${JSON.stringify(a.q27 ?? null)} dislikes=${JSON.stringify(a.q36 ?? null)}`)
    for (const [name, { reason, where }] of hits) {
      console.log(`  - ${name}: ${reason}  [${where.join(", ")}]`)
      if (reason.startsWith("not suitable")) byKind.diet++
      else if (reason.includes("allergen")) byKind.allergy++
      else byKind.dislike++
    }
  }

  const clientsWithAvoid = plans.filter(({ answers }) => {
    const a = answers as Answers
    return (typeof a.q36 === "string" && a.q36.trim() !== "") || (Array.isArray(a.q27) && a.q27.some((x) => x !== "No known allergy or intolerance"))
  })
  console.log(
    `\n=== ${plans.length} plans checked (${recipeRows.length} recipe items, ${foodRows.length} exchange items); ` +
      `${new Set(clientsWithAvoid.map((p) => p.plan.clientId)).size} clients have a dislike or allergy/intolerance recorded ===`
  )
  console.log(`Plans with food the client must not have: ${flagged} (${approvedFlagged} APPROVED)`)
  console.log(`Distinct problem dishes per plan — diet: ${byKind.diet}, allergy: ${byKind.allergy}, dislike: ${byKind.dislike}`)
  process.exit(0)
}

main()
