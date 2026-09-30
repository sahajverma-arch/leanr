import { describe, expect, it } from "vitest"

import { buildInitialMessages } from "./recipe-prompt"
import type { RecipeForPrompt, RecipeSelectorInput } from "./recipe-types"
import { buildWeekRotation, formatRotationSection, recentDishNames, seededShuffle } from "./recipe-week-rotation"

function prompt(name: string, category: string, extra: Partial<RecipeForPrompt> = {}): RecipeForPrompt {
  return {
    id: name,
    name,
    category,
    consistency: "solid",
    mainOrMid: "main",
    cuisine: "General",
    macroCategory: null,
    commonality: 0,
    mustHaveCategories: [],
    goodToHaveCategories: [],
    mustHaveRecipeNames: [],
    goodToHaveRecipeNames: [],
    proteinPer100G: 5,
    carbsPer100G: 15,
    fatPer100G: 3,
    fiberPer100G: 2,
    kcalPer100G: 107,
    ...extra,
  }
}

const DALS = ["Arhar Dal", "Moong Dal", "Masoor Dal", "Urad Dal", "Chana Dal", "Dal Palak", "Mixed Dal", "High Protein Dal", "Palak Moong Dal"].map((n) => prompt(n, "Dal"))
const CURRIES = ["Rajma Curry", "White Chana Curry", "Kala Chana Curry", "Kadhi Without Pakoda", "Bajra Kadi"].map((n) => prompt(n, "Curry"))
const DUM_ALOO = prompt("Dum Aloo", "Curry", { proteinPer100G: 2.7 })
const ROTIS = ["Roti", "Missi Roti", "Bajra Roti", "Jowar Roti", "Jaun Roti", "Multigrain Roti"].map((n) => prompt(n, "Roti"))
const PORRIDGE = prompt("Mango Oats Porridge", "Khichdi")
const POOL = [...DALS, ...CURRIES, ...ROTIS, PORRIDGE, DUM_ALOO]

describe("buildWeekRotation", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    const a = buildWeekRotation(POOL, { seed: "client-1:1:a", cuisine: "North Indian" })
    expect(buildWeekRotation(POOL, { seed: "client-1:1:a", cuisine: "North Indian" })).toEqual(a)
    const others = ["b", "c", "d", "e"].map((s) => buildWeekRotation(POOL, { seed: `client-1:1:${s}`, cuisine: "North Indian" }))
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true)
  })

  it("draws the lunch/dinner protein dish from dals AND curries, never a porridge", () => {
    const rotation = buildWeekRotation(POOL, { seed: "s", cuisine: "North Indian" })
    const dals = rotation.groups.find((g) => g.label.startsWith("Dals"))!
    expect(dals.names).toHaveLength(8)
    expect(dals.names).not.toContain("Mango Oats Porridge")
    expect(dals.names).not.toContain("Dum Aloo")
    const allowed = new Set([...DALS, ...CURRIES].map((r) => r.name))
    expect(dals.names.every((n) => allowed.has(n))).toBe(true)
  })

  it("makes last week's dishes much less likely to be suggested again", () => {
    const recent = ["Arhar Dal", "Moong Dal", "Masoor Dal", "Urad Dal", "Rajma Curry"]
    let suggestedRecent = 0
    let suggestedFresh = 0
    for (let i = 0; i < 200; i++) {
      const dals = buildWeekRotation(POOL, { seed: `seed-${i}`, cuisine: "North Indian", recentRecipeNames: recent }).groups.find((g) => g.label.startsWith("Dals"))!
      suggestedRecent += dals.names.filter((n) => recent.includes(n)).length
      suggestedFresh += dals.names.filter((n) => !recent.includes(n)).length
    }
    // 5 recent vs 9 fresh dishes; 8 picks each time. Unweighted the recent
    // share would be ~36%; weighted it must be well under that.
    expect(suggestedRecent / (suggestedRecent + suggestedFresh)).toBeLessThan(0.3)
  })

  it("spreads suggestions across the whole dal/curry range over many clients", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      for (const n of buildWeekRotation(POOL, { seed: `client-${i}`, cuisine: "North Indian" }).groups.find((g) => g.label.startsWith("Dals"))!.names) seen.add(n)
    }
    expect(seen.size).toBe(DALS.length + CURRIES.length)
  })
})

describe("seededShuffle", () => {
  it("keeps every item and is repeatable", () => {
    const items = POOL.map((r) => r.name)
    const shuffled = seededShuffle(items, "x")
    expect([...shuffled].sort()).toEqual([...items].sort())
    expect(seededShuffle(items, "x")).toEqual(shuffled)
  })
})

describe("recentDishNames / formatRotationSection", () => {
  it("names last week's dishes but not its plain staples", () => {
    const names = recentDishNames([
      { name: "Rajma Curry", category: "Curry", mainOrMid: "main" },
      { name: "Roti", category: "Roti", mainOrMid: "main" },
      { name: "Curd", category: "Raita", mainOrMid: "mid" },
      { name: "Rajma Curry", category: "Curry", mainOrMid: "main" },
    ])
    expect(names).toEqual(["Rajma Curry"])
  })

  it("renders nothing when there is nothing to say", () => {
    expect(formatRotationSection({ groups: [] })).toBe("")
  })
})

describe("buildInitialMessages with a varietySeed", () => {
  const base: RecipeSelectorInput = {
    cuisine: "North Indian",
    dietType: "vegetarian",
    mealCount: 2,
    dailyTarget: { kcal: 2000, proteinG: 100, carbsG: 200, fatG: 60, fiberG: 30 },
    slots: [
      { slot: "lunch", slotOrder: 1, timeHint: null },
      { slot: "dinner", slotOrder: 2, timeHint: null },
    ],
    eligibleRecipesForPrompt: POOL,
    allRecipesById: new Map(),
    eligibleCuisines: ["North Indian", "General"],
    clientAllergenTags: [],
    aliasRows: [],
  }

  it("without a seed, has no rotation section and keeps the table in pool order", () => {
    const content = buildInitialMessages(base)[1].content
    expect(content).not.toContain("This week's rotation")
    expect(content.indexOf("Arhar Dal |")).toBeLessThan(content.indexOf("Rajma Curry |"))
  })

  it("gives each best-of-N attempt a different prompt, and the same attempt the same prompt", () => {
    const seeded = { ...base, varietySeed: "roadmap:1:nonce" }
    const one = buildInitialMessages(seeded, 1)[1].content
    expect(one).toContain("This week's rotation")
    expect(buildInitialMessages(seeded, 1)[1].content).toBe(one)
    expect(buildInitialMessages(seeded, 2)[1].content).not.toBe(one)
  })

  it("names last week's dishes in the prompt", () => {
    const content = buildInitialMessages({
      ...base,
      varietySeed: "s",
      previousWeekRecipes: [{ name: "Rajma Curry", category: "Curry", mainOrMid: "main" }],
    })[1].content
    expect(content).toContain("Last week this client already had: Rajma Curry.")
  })
})

describe("everyday suggestions", () => {
  it("never suggests a fasting-only dish or imitation rice, though they stay in the table", () => {
    const pool = [...POOL, prompt("Kuttu Roti", "Roti"), prompt("Samak Rice Khichdi", "Khichdi"), prompt("Tofu Shirataki Rice Pulao", "Pulao")]
    for (let i = 0; i < 50; i++) {
      const names = buildWeekRotation(pool, { seed: `s${i}`, cuisine: "North Indian" }).groups.flatMap((g) => g.names)
      expect(names.some((n) => /kuttu|samak|shirataki/i.test(n))).toBe(false)
    }
  })
})
