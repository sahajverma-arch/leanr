/**
 * Shows the ingredient layer working against real seeded data.
 *
 *   npx tsx --env-file=.env.local scripts/demo-ingredient-edit.ts
 *   npx tsx --env-file=.env.local scripts/demo-ingredient-edit.ts "Palak Dal Khichdi"
 *   npx tsx --env-file=.env.local scripts/demo-ingredient-edit.ts "Palak Dal Khichdi" "moong dal" 60
 *
 * With no arguments it picks a few admitted recipes and edits the most
 * interesting ingredient in each, so one command demonstrates the feature.
 *
 * Read-only: it loads from the database and computes in memory. Nothing is
 * written, so this can be run against production safely.
 */
import { eq, inArray, sql as raw } from "drizzle-orm"

import {
  per100GOfPortion,
  setIngredientQuantity,
  toPortion,
  type PortionIngredient,
} from "@/lib/plan/ingredient-edit"
import type { IngredientQuantityKind } from "@/lib/foods/recipe-calculation-parser"

import { db } from "../src/db"
import {
  ingredients as ingredientsTable,
  recipeIngredientProfiles,
  recipeIngredients,
  recipes,
} from "../src/db/schema"

const n = (v: number, d = 2) => v.toFixed(d).padStart(d === 0 ? 4 : 7)

async function loadPortion(recipeName: string) {
  const [recipe] = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      cuisine: recipes.cuisine,
      carbs: recipes.carbsPer100G,
      protein: recipes.proteinPer100G,
      fat: recipes.fatPer100G,
      kcal: recipes.kcalPer100G,
    })
    .from(recipes)
    .where(eq(recipes.name, recipeName))
  if (!recipe) return { error: `no recipe called "${recipeName}"` as const }

  const [profile] = await db
    .select()
    .from(recipeIngredientProfiles)
    .where(eq(recipeIngredientProfiles.recipeId, recipe.id))
  if (!profile) {
    return { error: `"${recipeName}" is not in the trial — no ingredient breakdown available` as const }
  }

  const lines = await db
    .select({
      name: ingredientsTable.name,
      kind: recipeIngredients.kind,
      quantity: recipeIngredients.quantity,
      unit: recipeIngredients.unit,
      gramsPerUnit: recipeIngredients.gramsPerUnit,
      grams: recipeIngredients.grams,
      carbs: ingredientsTable.carbsPer100G,
      protein: ingredientsTable.proteinPer100G,
      fat: ingredientsTable.fatPer100G,
      fiber: ingredientsTable.fiberPer100G,
      kcal: ingredientsTable.kcalPer100G,
    })
    .from(recipeIngredients)
    .innerJoin(ingredientsTable, eq(recipeIngredients.ingredientId, ingredientsTable.id))
    .where(eq(recipeIngredients.recipeId, recipe.id))
    .orderBy(recipeIngredients.displayOrder)

  const batch: PortionIngredient[] = lines.map((l) => ({
    name: l.name,
    kind: l.kind as IngredientQuantityKind,
    quantity: l.quantity,
    unit: l.unit,
    gramsPerUnit: l.gramsPerUnit,
    grams: l.grams,
    per100G: {
      carbsG: l.carbs,
      proteinG: l.protein,
      fatG: l.fat,
      fiberG: l.fiber,
      kcal: l.kcal,
    },
  }))

  return { recipe, profile, portion: toPortion(batch, profile.servings, profile.portionGrams) }
}

/** The ingredient a dietitian would most plausibly reach for: the biggest protein contributor. */
function mostInterestingIngredient(portion: { ingredients: PortionIngredient[] }) {
  return [...portion.ingredients].sort(
    (a, b) => b.per100G.proteinG * b.grams - a.per100G.proteinG * a.grams,
  )[0]
}

async function demo(recipeName: string, ingredientName?: string, newQuantity?: number) {
  const loaded = await loadPortion(recipeName)
  if ("error" in loaded) {
    console.log(`\n${recipeName}: ${loaded.error}\n`)
    return
  }
  const { recipe, profile, portion } = loaded

  console.log("\n" + "=".repeat(74))
  console.log(`${recipe.name.toUpperCase()}   [${recipe.cuisine}]`)
  console.log("=".repeat(74))
  console.log(
    `  batch serves ${profile.servings} · one portion = ${profile.portionGrams} g · ` +
      `yield ${profile.yieldFactor.toFixed(2)}`,
  )

  console.log("\n  ONE PORTION CONTAINS")
  for (const i of portion.ingredients) {
    const qty =
      i.kind === "direct" ? `${i.grams.toFixed(1)} g` : `${i.quantity.toFixed(2)} ${i.unit}`
    console.log(
      `    ${i.name.slice(0, 26).padEnd(26)} ${qty.padStart(12)}  ${n(i.grams, 1)} g   ` +
        `P${n(i.per100G.proteinG * i.grams / 100)} C${n(i.per100G.carbsG * i.grams / 100)} ` +
        `F${n(i.per100G.fatG * i.grams / 100)}`,
    )
  }
  const m = portion.macros
  console.log(
    `    ${"PORTION TOTAL".padEnd(26)} ${"".padStart(12)}  ${n(profile.portionGrams, 1)} g   ` +
      `P${n(m.proteinG)} C${n(m.carbsG)} F${n(m.fatG)}  ${m.kcal.toFixed(0)} kcal`,
  )

  // The safety check, run live: rebuilding per-100g from ingredients must land
  // on what the recipes table already stores, or this layer is changing
  // nutrition rather than describing it.
  const derived = per100GOfPortion(portion.macros, profile.portionGrams)
  const worst = Math.max(
    Math.abs(derived.proteinG - recipe.protein),
    Math.abs(derived.carbsG - recipe.carbs),
    Math.abs(derived.fatG - recipe.fat),
  )
  console.log(
    `\n  derived per-100g  P${n(derived.proteinG)} C${n(derived.carbsG)} F${n(derived.fatG)} ` +
      `${derived.kcal.toFixed(1)} kcal`,
  )
  console.log(
    `  stored  per-100g  P${n(recipe.protein)} C${n(recipe.carbs)} F${n(recipe.fat)} ` +
      `${recipe.kcal.toFixed(1)} kcal   ${worst < 0.1 ? "MATCH" : `OFF BY ${worst.toFixed(2)}`}`,
  )

  const target = ingredientName
    ? portion.ingredients.find((i) => i.name === ingredientName)
    : mostInterestingIngredient(portion)
  if (!target) {
    console.log(`\n  (no ingredient called "${ingredientName}" in this dish)\n`)
    return
  }
  const to =
    newQuantity ??
    (target.kind === "direct"
      ? Math.round((target.grams * 1.5) / 5) * 5
      : Math.max(1, Math.ceil(target.quantity)) + 1)

  const result = setIngredientQuantity(portion, target.name, to)
  const d = result.delta
  const unitWord = target.kind === "direct" ? "g" : (target.unit ?? "units")
  console.log(
    `\n  EDIT  ${target.name}: ${target.quantity.toFixed(2)} -> ${to} ${unitWord}`,
  )
  console.log(
    `    delta        P${n(d.proteinG)} C${n(d.carbsG)} F${n(d.fatG)}  ` +
      `${d.kcal >= 0 ? "+" : ""}${d.kcal.toFixed(0)} kcal`,
  )
  const nm = result.recipe.macros
  console.log(
    `    new portion  P${n(nm.proteinG)} C${n(nm.carbsG)} F${n(nm.fatG)}  ${nm.kcal.toFixed(0)} kcal`,
  )
  console.log(
    `    new weight   ${result.recipe.portionGrams.toFixed(1)} g ` +
      `(was ${profile.portionGrams} g)`,
  )
  console.log(
    `    new per-100g P${n(result.per100G.proteinG)} C${n(result.per100G.carbsG)} ` +
      `F${n(result.per100G.fatG)}   <- what the balancer would re-optimise against`,
  )
}

async function main() {
  const [name, ingredient, qty] = process.argv.slice(2)
  if (name) {
    await demo(name, ingredient, qty ? Number(qty) : undefined)
    process.exit(0)
  }

  const [{ count }] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(recipeIngredientProfiles)
  console.log(`\n${count} recipes are in the ingredient trial.`)

  // A spread: something counted, something gram-measured, something with a
  // high yield (water added) and something that cooks down.
  const picks = await db
    .select({ name: recipes.name })
    .from(recipeIngredientProfiles)
    .innerJoin(recipes, eq(recipes.id, recipeIngredientProfiles.recipeId))
    .where(inArray(recipes.name, [
      "Palak Dal Khichdi",
      "Acuri Eggs",
      "Moong Dal Paratha",
      "Gongura Pappu (Gongura Dal)",
      "Kolkata Egg Rolls",
    ]))

  for (const p of picks) await demo(p.name)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
