import { describe, expect, it } from "vitest"

import { checkinGateError, formatWeightChange, groupPlansByWeek, pickCurrentPlan, type PlanVersion } from "./client-weeks"

const at = (day: number) => new Date(Date.UTC(2026, 8, day))
const plan = (id: string, weekNumber: number, status: PlanVersion["status"], day: number): PlanVersion => ({
  id,
  weekNumber,
  status,
  createdAt: at(day),
})

describe("pickCurrentPlan", () => {
  it("picks the newest draft when nothing is approved", () => {
    expect(pickCurrentPlan([plan("a", 1, "draft", 1), plan("b", 1, "draft", 3), plan("c", 1, "draft", 2)])?.id).toBe("b")
  })

  it("keeps the approved plan even when a newer draft exists", () => {
    // Regenerating after approval must not silently replace what went to the client.
    expect(pickCurrentPlan([plan("approved", 1, "approved", 1), plan("newer", 1, "draft", 5)])?.id).toBe("approved")
  })

  it("picks the newest of several approved versions", () => {
    expect(pickCurrentPlan([plan("old", 1, "approved", 1), plan("new", 1, "approved", 4)])?.id).toBe("new")
  })

  it("returns null for no versions", () => {
    expect(pickCurrentPlan([])).toBeNull()
  })
})

describe("groupPlansByWeek", () => {
  it("groups by week ascending, one current plan each, the rest newest first", () => {
    const weeks = groupPlansByWeek([
      plan("w2", 2, "draft", 9),
      plan("w1-a", 1, "draft", 1),
      plan("w1-b", 1, "approved", 2),
      plan("w1-c", 1, "draft", 3),
    ])
    expect(weeks.map((w) => w.weekNumber)).toEqual([1, 2])
    expect(weeks[0].current.id).toBe("w1-b")
    expect(weeks[0].earlier.map((p) => p.id)).toEqual(["w1-c", "w1-a"])
    expect(weeks[1].earlier).toEqual([])
  })
})

describe("checkinGateError", () => {
  it("never gates week 1 — it comes from counselling", () => {
    expect(checkinGateError(1, null)).toBeNull()
  })

  it("blocks week 2+ with no check-in, and with a draft one", () => {
    expect(checkinGateError(2, null)).toMatch(/check-in/)
    expect(checkinGateError(3, "draft")).toMatch(/still a draft/)
  })

  it("allows week 2+ once the check-in is submitted", () => {
    expect(checkinGateError(2, "submitted")).toBeNull()
  })
})

describe("formatWeightChange", () => {
  it("signs and rounds to one decimal", () => {
    expect(formatWeightChange(78, 76.4)).toBe("−1.6 kg")
    expect(formatWeightChange(76.4, 76.8)).toBe("+0.4 kg")
    expect(formatWeightChange(70, 70.02)).toBe("no change")
  })
})
