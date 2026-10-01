import { describe, expect, it } from "vitest"

import { extraMealSlotInfos, extraMealSlotsSchema, isExtraMealSlot } from "./extra-meal-slots"

describe("extra meal slots", () => {
  it("orders wake-up before every template meal and bedtime after", () => {
    const infos = extraMealSlotInfos(["bedtime", "wake_up"])
    expect(infos.map((s) => s.slot)).toEqual(["wake_up", "bedtime"])
    expect(infos[0].slotOrder).toBeLessThan(1)
    expect(infos[1].slotOrder).toBeGreaterThan(5)
  })

  it("ignores anything that is not an optional meal", () => {
    expect(extraMealSlotInfos(["lunch"])).toEqual([])
    expect(isExtraMealSlot("lunch")).toBe(false)
    expect(isExtraMealSlot("wake_up")).toBe(true)
  })

  it("rejects an unknown slot on input", () => {
    expect(extraMealSlotsSchema.safeParse(["brunch"]).success).toBe(false)
    expect(extraMealSlotsSchema.safeParse(["wake_up", "bedtime"]).success).toBe(true)
  })
})
