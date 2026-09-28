/**
 * How a client's saved plans read as a programme of weeks.
 *
 * Every "Generate" saves a new plan and nothing is ever deleted, so one week
 * can hold several versions (a real client had 7 for week 1). Exactly ONE of
 * them is the week's plan — the "current" one — and the rest are kept as
 * earlier versions. The same rule decides which plan week N+1 carries its
 * dishes on from, so the client page and the generator always agree.
 *
 * Pure: no DB, so it is unit-tested directly.
 */

export interface PlanVersion {
  id: string
  weekNumber: number
  status: "draft" | "approved"
  createdAt: Date
}

/**
 * The week's plan: the most recently created APPROVED version if there is
 * one (that is what went to the client), otherwise the most recent draft.
 * A newer draft never displaces an approved plan — regenerating after
 * approval is an experiment until it is approved itself.
 */
export function pickCurrentPlan<T extends PlanVersion>(versions: T[]): T | null {
  const newestFirst = [...versions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return newestFirst.find((p) => p.status === "approved") ?? newestFirst[0] ?? null
}

export interface PlanWeek<T extends PlanVersion> {
  weekNumber: number
  current: T
  /** Every other version, newest first. */
  earlier: T[]
}

/** Groups versions by week, ascending, each with its current plan picked out. */
export function groupPlansByWeek<T extends PlanVersion>(plans: T[]): PlanWeek<T>[] {
  const byWeek = new Map<number, T[]>()
  for (const p of plans) byWeek.set(p.weekNumber, [...(byWeek.get(p.weekNumber) ?? []), p])
  return [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([weekNumber, versions]) => {
      const current = pickCurrentPlan(versions)!
      const earlier = versions
        .filter((v) => v.id !== current.id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return { weekNumber, current, earlier }
    })
}

export type CheckinStatus = "draft" | "submitted"

/**
 * Why week N cannot be generated yet, or null if it can. Week 1 is built from
 * counselling alone; every later week needs its follow-up check-in SUBMITTED.
 * Enforced in /api/plan/generate itself, not only by hiding a button.
 */
export function checkinGateError(weekNumber: number, checkinStatus: CheckinStatus | null): string | null {
  if (weekNumber <= 1) return null
  if (checkinStatus === "submitted") return null
  return checkinStatus === "draft"
    ? `The week ${weekNumber} check-in is still a draft — submit it before generating week ${weekNumber}.`
    : `Fill in the week ${weekNumber} follow-up check-in before generating week ${weekNumber}.`
}

/** Signed weight change for display: "−1.6 kg", "+0.4 kg", "no change". */
export function formatWeightChange(fromKg: number, toKg: number): string {
  const delta = Math.round((toKg - fromKg) * 10) / 10
  if (delta === 0) return "no change"
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} kg`
}
