/**
 * Deterministic, non-LLM recipe choice for total LLM outage — this
 * codebase's whole ethos is "plan generation always succeeds, worst case
 * with honest warnings" at the SELECTION layer; whether the resulting plan
 * clears the macro/plausibility/variety gates is a separate question the
 * caller (recipe-selector.ts) still checks identically for both paths, per
 * the confirmed "reject, no exemption for the fallback" decision.
 *
 * Per slot, picks one recipe per required meal-role bucket, rotated
 * deterministically by stableHash(dayIndex, slot, bucket) — same small
 * per-file pattern food-selector-fallback.ts/archetype-selector.ts/
 * mixed-veg-day.ts already use elsewhere in this codebase.
 */

import { evidenceSafeDietTypes } from "@/lib/foods/recipe-animal-content"
import { recipeCategoryBucket, type RecipeCategoryBucket } from "./recipe-category"
import { isSelfContainedMeal, STAPLE_BUCKETS } from "./recipe-meal-structure"
import { findPairingCompanion, isMustHaveSatisfied } from "./recipe-pairing"
import type { RecipeForPrompt, RecipeSelection, RecipeSelectorInput, SelectedRecipeDay, SelectedRecipeMeal } from "./recipe-types"

const SLOT_BUCKET_PLAN: Record<string, RecipeCategoryBucket[]> = {
  breakfast: ["bread", "light_meal"],
  mid_morning: ["fruit", "beverage"],
  lunch: ["rice_pulao", "dal_curry", "sabzi"],
  evening: ["snack", "beverage"],
  dinner: ["bread", "dal_curry", "sabzi"],
  bedtime: ["beverage"],
}
const DEFAULT_SLOT_BUCKETS: RecipeCategoryBucket[] = ["light_meal"]

// Non-vegetarian: dinner always (not probabilistic) gets a real non-veg
// pick when one is eligible — mirroring CLAUDE.md's established exchange-
// engine precedent (meat_lean anchored permanently to dinner; "non-
// vegetarian" already has "eggetarian" as its own diet type for egg-only
// clients, so a fallback that only sometimes serves real meat defeats that
// distinction). Lunch stays vegetarian-style, same day-structure split.
const NON_VEG_SUBSTITUTE_SLOT = "dinner"

function isRealNonVegRecipe(dietTypes: string[]): boolean {
  return dietTypes.length === 1 && dietTypes[0] === "non_vegetarian"
}

function stableHash(...parts: string[]): number {
  const str = parts.join("|")
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * Best-effort repair for the deterministic path: recipe-plausibility-
 * validate.ts's "must have" pairing gate applies identically to the
 * fallback (no exemption — see CLAUDE.md, "The recipe engine"), but the
 * fallback has no LLM to retry with if a picked item's requirement goes
 * unmet, so it's checked and filled in right here instead, deterministically
 * (findPairingCompanion's own rotation, not a random pick). Mutates
 * `picked` in place. Leaves a requirement unmet only when the eligible pool
 * genuinely has no real companion at all — a legitimate, surfaced rejection
 * downstream, not something to silently paper over.
 */
function repairMustHavePairings(picked: RecipeForPrompt[], pool: RecipeForPrompt[], rotationDay: number, slot: string, hasRealAnimalProtein: boolean): void {
  for (const item of [...picked]) {
    const siblingCategories = picked.filter((p) => p !== item).map((p) => p.category)
    const siblingNames = picked.filter((p) => p !== item).map((p) => p.name)
    if (isMustHaveSatisfied(item, siblingCategories, siblingNames)) continue
    // A real animal-protein pick already fills the "needs a Sabzi/Dal/Curry
    // accompaniment" role a staple's own must-have wants — and this meal
    // has already deliberately excluded dal_curry/sabzi from its bucket
    // picks for exactly that reason (see the useNonVeg branch below), so
    // searching the full pool here would just reintroduce the pairing that
    // exclusion exists to prevent. Same exemption as
    // recipe-plausibility-validate.ts's own hasRealAnimalProtein check.
    if (hasRealAnimalProtein) continue
    const exclude = new Set(picked.map((p) => p.name.toLowerCase()))
    const rotationIndex = stableHash(String(rotationDay), slot, "companion", item.name)
    const companion = findPairingCompanion(pool, item.mustHaveCategories, item.mustHaveRecipeNames, rotationIndex, exclude)
    if (companion) picked.push(companion)
  }
}

/**
 * Best-effort de-duplication for the deterministic path: a self-contained
 * dish (Khichdi, Kadhi-with-rice, or a Heavy/Light Meal composite) already
 * IS the staple+dal course — recipe-plausibility-validate.ts now rejects a
 * meal that also bolts on a separate staple alongside one (a direct
 * dietitian correction on a hand-built plan: "no one eats ajwain paratha
 * with khichdi and tofu chilla"), and the fallback has no LLM to retry
 * with, so the redundant staple is dropped right here instead. Mutates
 * `picked` in place — run before repairMustHavePairings so it never wastes
 * a companion search on a staple about to be removed anyway.
 */
function removeRedundantStaple(picked: RecipeForPrompt[]): void {
  const hasSelfContained = picked.some((p) => isSelfContainedMeal(p.category, recipeCategoryBucket(p.category, p.name), p.carbsPer100G))
  if (!hasSelfContained) return
  for (let i = picked.length - 1; i >= 0; i--) {
    const item = picked[i]
    const bucket = recipeCategoryBucket(item.category, item.name)
    if (STAPLE_BUCKETS.has(bucket) && !isSelfContainedMeal(item.category, bucket, item.carbsPer100G)) {
      picked.splice(i, 1)
    }
  }
}

export function recipeSelectorFallback(input: RecipeSelectorInput): RecipeSelection {
  const weekOffset = input.dayIndexOffset ?? 0

  const byBucket = new Map<RecipeCategoryBucket, RecipeForPrompt[]>()
  for (const r of input.eligibleRecipesForPrompt) {
    const bucket = recipeCategoryBucket(r.category, r.name)
    const list = byBucket.get(bucket) ?? []
    list.push(r)
    byBucket.set(bucket, list)
  }

  const nonVegPool = input.eligibleRecipesForPrompt.filter((r) => {
    const full = input.allRecipesById.get(r.id)
    return full ? isRealNonVegRecipe(evidenceSafeDietTypes(full.dietTypes, full)) : false
  })

  const days: SelectedRecipeDay[] = []
  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const rotationDay = dayIndex + weekOffset
    const meals: SelectedRecipeMeal[] = input.slots.map((slotInfo) => {
      let buckets = SLOT_BUCKET_PLAN[slotInfo.slot] ?? DEFAULT_SLOT_BUCKETS
      const picked: RecipeForPrompt[] = []

      const useNonVeg = input.dietType === "non_vegetarian" && slotInfo.slot === NON_VEG_SUBSTITUTE_SLOT && nonVegPool.length > 0
      if (useNonVeg) {
        const pick = nonVegPool[stableHash(String(rotationDay), slotInfo.slot, "non_veg") % nonVegPool.length]
        picked.push(pick)
        buckets = buckets.filter((b) => b !== "dal_curry" && b !== "sabzi")
      }

      for (const bucket of buckets) {
        const pool = byBucket.get(bucket)
        if (!pool || pool.length === 0) continue
        const pick = pool[stableHash(String(rotationDay), slotInfo.slot, bucket) % pool.length]
        picked.push(pick)
      }

      if (picked.length === 0 && input.eligibleRecipesForPrompt.length > 0) {
        const pool = input.eligibleRecipesForPrompt
        const pick = pool[stableHash(String(rotationDay), slotInfo.slot, "any") % pool.length]
        picked.push(pick)
      }

      removeRedundantStaple(picked)
      repairMustHavePairings(picked, input.eligibleRecipesForPrompt, rotationDay, slotInfo.slot, useNonVeg)

      return { slot: slotInfo.slot, items: picked.map((p) => ({ name: p.name })) }
    })
    days.push({ dayIndex, meals })
  }

  return { days }
}
