/**
 * A seeded "this week's rotation" for the recipe prompt — so two clients with
 * the same cuisine and diet type, two weeks of one client, and the N
 * best-of-N attempts of one generation do not all start from the same dishes.
 *
 * WHY THIS EXISTS, measured on the 14 real North Indian plans saved by
 * 2026-09-29: Roti was in 14 of 14, Jeera Rice 13, Rajma Curry 12, White
 * Chana Curry 12, Kala Chana 10 — out of a pool with 18 real dals/curries and
 * 17 rotis. Every client got the same prompt (same pool, same order, same
 * rules) at temperature 0.3, so the model's favourite handful won every
 * time, and the five best-of-N attempts were five near-copies of one week:
 * N bought no variety at all.
 *
 * What changes per seed is descriptive only: which dishes are SUGGESTED as
 * the week's backbone, and the order of the recipe table. The eligible pool
 * is untouched — every dish in the table is still offered, and the model may
 * use any of them when a target needs it. No number is involved anywhere:
 * THE ONE RULE is untouched.
 */

import { recipeCategoryBucket, type RecipeCategoryBucket } from "./recipe-category"
import type { RecipeForPrompt } from "./recipe-types"
import { isEverydayStaple } from "./recipe-variety-tracker"

/** 32-bit string hash — the same small rolling hash this codebase duplicates per file on purpose (see CLAUDE.md). */
function stableHash(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) hash = (Math.imul(hash, 31) + input.charCodeAt(i)) | 0
  return hash >>> 0
}

/** mulberry32: a tiny seeded PRNG, so a given seed always produces the same rotation. */
function seededRandom(seed: string): () => number {
  let state = stableHash(seed) || 1
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Weighted sampling without replacement (Efraimidis–Spirakis): each item
 * draws key = u^(1/w) and the top k keys win. A higher weight makes a dish
 * more likely, never certain — so the client's own cuisine and dishes they
 * have not had recently are favoured, while every week still differs.
 */
function weightedSample<T>(items: readonly T[], k: number, weight: (item: T) => number, random: () => number): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(random(), 1 / Math.max(weight(item), 1e-6)) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, k)
    .map((x) => x.item)
}

interface RotationGroup {
  label: string
  count: number
  pick: (r: RecipeForPrompt, bucket: RecipeCategoryBucket) => boolean
}

const PORRIDGE = /porridge|oats|pudding|daliya|dalia/i

/** Protein per 100 g below which a dal/curry is not suggested as the day's protein dish. */
const MIN_PROTEIN_DAL_SUGGESTION = 4

/**
 * Kept out of the SUGGESTIONS (never out of the table): Navratri/vrat-only
 * dishes and imitation rice. With commonality at 0 on nearly every row, a
 * uniform draw suggested Kuttu Roti, Samak Khichdi and Shirataki Pulao for an
 * ordinary week as often as roti and dal — seen in the first real rotation
 * rendered for a North Indian client. The model can still choose them.
 */
const NOT_AN_EVERYDAY_SUGGESTION = /kuttu|buckwheat|samak|singhar|rajgira|navratri|vrat|sabudana|shirataki|sharataki/i

/**
 * The parts of a week that actually repeat. Picked by raw Category where the
 * bucket is too broad: "dal_curry" also holds khichdis and porridges, and
 * "bread" also holds sandwiches and wraps. Counts are sized to a 7-day week:
 * ~7 distinct dals gives lunch and dinner a different one most days.
 */
const ROTATION_GROUPS: RotationGroup[] = [
  {
    label: "Dals and curries for lunch/dinner",
    count: 8,
    // This slot IS the day's protein dish. Below 4 g/100g the "curry" is a
    // potato or kadhi-style gravy (Dum Aloo 2.7, Tofu Curry 3.2): suggesting
    // it as the protein anchor measurably cost protein on a real
    // high-protein vegetarian client. Still in the table, just not suggested.
    pick: (r) =>
      r.mainOrMid === "main" && ["dal", "curry"].includes(r.category.trim().toLowerCase()) && r.proteinPer100G >= MIN_PROTEIN_DAL_SUGGESTION,
  },
  {
    label: "Sabzis for lunch/dinner",
    count: 8,
    pick: (r, bucket) => r.mainOrMid === "main" && bucket === "sabzi",
  },
  {
    label: "Rotis to rotate between",
    count: 4,
    pick: (r) => r.category.trim().toLowerCase() === "roti",
  },
  {
    label: "Rice, pulao or khichdi options",
    count: 4,
    pick: (r, bucket) =>
      r.mainOrMid === "main" &&
      (bucket === "rice_pulao" || (r.category.trim().toLowerCase() === "khichdi" && !PORRIDGE.test(r.name))),
  },
  {
    label: "Breakfasts (a different one each day)",
    count: 7,
    pick: (r) =>
      r.mainOrMid === "main" &&
      (["paratha", "chila", "chilla", "upma", "dosa", "idli", "pancake", "porridge", "cereal", "thepla"].includes(r.category.trim().toLowerCase()) ||
        (r.category.trim().toLowerCase() === "khichdi" && PORRIDGE.test(r.name))),
  },
  {
    label: "Evening snacks",
    count: 7,
    pick: (r, bucket) => bucket === "snack" || ["tikka", "cutlet"].includes(r.category.trim().toLowerCase()),
  },
]

export interface WeekRotationGroup {
  label: string
  names: string[]
}

export interface WeekRotation {
  groups: WeekRotationGroup[]
}

export interface WeekRotationOptions {
  seed: string
  cuisine: string
  /** Dishes this client was served last week — still allowed, just less likely to be suggested again. */
  recentRecipeNames?: readonly string[]
}

/** How much less likely a dish from last week is to be suggested again. Soft, not an exclusion: a small pool must still fill. */
const RECENT_WEIGHT = 0.2
/** How much more likely a dish from the client's own cuisine is to be suggested. */
const OWN_CUISINE_WEIGHT = 3

export function buildWeekRotation(pool: readonly RecipeForPrompt[], options: WeekRotationOptions): WeekRotation {
  const random = seededRandom(options.seed)
  const recent = new Set(options.recentRecipeNames ?? [])
  const weight = (r: RecipeForPrompt) =>
    (1 + r.commonality) *
    (r.cuisine === options.cuisine && options.cuisine !== "General" ? OWN_CUISINE_WEIGHT : 1) *
    (recent.has(r.name) ? RECENT_WEIGHT : 1)

  const groups: WeekRotationGroup[] = []
  const alreadyPicked = new Set<string>()
  for (const group of ROTATION_GROUPS) {
    const members = pool.filter(
      (r) => !alreadyPicked.has(r.name) && !NOT_AN_EVERYDAY_SUGGESTION.test(r.name) && group.pick(r, recipeCategoryBucket(r.category, r.name))
    )
    // A group too small to rotate says nothing useful; leave it out.
    if (members.length < 2) continue
    const names = weightedSample(members, group.count, weight, random).map((r) => r.name)
    for (const name of names) alreadyPicked.add(name)
    groups.push({ label: group.label, names })
  }
  return { groups }
}

/** Last week's actual DISHES (not plain roti/rice, curd, salad) — what the prompt names as "had last week". */
export function recentDishNames(recent: readonly Pick<RecipeForPrompt, "name" | "category" | "mainOrMid">[]): string[] {
  return [...new Set(recent.filter((r) => !isEverydayStaple(r)).map((r) => r.name))]
}

export function formatRotationSection(rotation: WeekRotation, recentDishes: readonly string[] = []): string {
  if (rotation.groups.length === 0 && recentDishes.length === 0) return ""
  const lines = [
    "This week's rotation — picked for this client and this week so that their plan does not look like every other client's. Build the week mainly from these, and use other dishes from the table only when a target needs them:",
    ...rotation.groups.map((g) => `- ${g.label}: ${g.names.join(", ")}.`),
  ]
  if (recentDishes.length > 0) {
    lines.push(`- Last week this client already had: ${recentDishes.join(", ")}. Prefer different dishes this week.`)
  }
  return `\n${lines.join("\n")}\n`
}
