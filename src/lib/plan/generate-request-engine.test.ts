import { describe, expect, it } from "vitest"

import { applyEngineDefault } from "./generate-request-engine"

/** Exactly what actions-bar.tsx and plan-actions-bar.tsx send — no `engine`, no `cuisine`. */
const UI_BODY = { roadmapId: "8f2b1e2e-0000-4000-8000-000000000000", weekNumber: 1, region: "north_indian" }

describe("applyEngineDefault", () => {
  it("routes a UI request to the RECIPE engine when the flag is on", () => {
    // The regression this whole function exists for: the UI omits `engine`,
    // so with a hardcoded "exchange" default the flag did nothing.
    const out = applyEngineDefault(UI_BODY, true) as Record<string, unknown>
    expect(out.engine).toBe("recipe")
    expect(out.cuisine).toBe("North Indian")
  })

  it("routes the same request to the EXCHANGE engine when the flag is off", () => {
    const out = applyEngineDefault(UI_BODY, false) as Record<string, unknown>
    expect(out.engine).toBe("exchange")
    expect(out.cuisine).toBeUndefined()
  })

  it("derives cuisine from whichever region the UI sent", () => {
    for (const [region, cuisine] of [
      ["punjabi", "Punjabi"],
      ["bengali", "Bengali"],
      ["gujarati", "Gujarati"],
      ["hyderabadi", "Hyderabadi"],
      ["south_indian", "South Indian"],
    ] as const) {
      const out = applyEngineDefault({ ...UI_BODY, region }, true) as Record<string, unknown>
      expect(out.cuisine).toBe(cuisine)
    }
  })

  it("falls back to General for an unrecognised region rather than throwing", () => {
    const out = applyEngineDefault({ ...UI_BODY, region: "atlantis" }, true) as Record<string, unknown>
    expect(out.engine).toBe("recipe")
    expect(out.cuisine).toBe("General")
  })

  it("never overrides an explicit engine, in either direction", () => {
    const exchange = applyEngineDefault({ ...UI_BODY, engine: "exchange" }, true) as Record<string, unknown>
    expect(exchange.engine).toBe("exchange")
    expect(exchange.cuisine).toBeUndefined()

    const recipe = applyEngineDefault({ roadmapId: UI_BODY.roadmapId, weekNumber: 1, engine: "recipe", cuisine: "Bengali" }, false) as Record<string, unknown>
    expect(recipe.engine).toBe("recipe")
    expect(recipe.cuisine).toBe("Bengali")
  })

  it("preserves every other field the caller sent", () => {
    const out = applyEngineDefault({ ...UI_BODY, mealCount: 4, season: "winter" }, true) as Record<string, unknown>
    expect(out.roadmapId).toBe(UI_BODY.roadmapId)
    expect(out.weekNumber).toBe(1)
    expect(out.mealCount).toBe(4)
    expect(out.season).toBe("winter")
  })

  it("passes non-object bodies through untouched for Zod to reject", () => {
    expect(applyEngineDefault(null, true)).toBeNull()
    expect(applyEngineDefault("nonsense", true)).toBe("nonsense")
    expect(applyEngineDefault([1, 2], true)).toEqual([1, 2])
  })
})
