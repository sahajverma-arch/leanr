import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/db"
import { clients, counsellingSessions, dietPlans, roadmaps, weeklyCheckins, type WeeklyCheckin } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import type { RoadmapInput, RoadmapResult } from "@/lib/counselling/roadmap"
import { regionFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { checkinWeightKg } from "./checkin-questions"
import { groupPlansByWeek, type PlanWeek } from "./client-weeks"

const macroSchema = z.object({ kcal: z.number(), proteinG: z.number() }).passthrough()
const supplementSchema = z
  .object({ name: z.string(), servingsPerDay: z.number(), proteinGPerServing: z.number(), kcalPerServing: z.number() })
  .passthrough()

export interface PlanSummary {
  id: string
  weekNumber: number
  status: "draft" | "approved"
  createdAt: Date
  weekStart: string
  weekEnd: string
  region: string
  engine: "exchange" | "recipe"
  /** What the FOOD was built to supply (after any supplement), per day. */
  target: { kcal: number; proteinG: number } | null
  /** Weekly average the saved plan actually reaches — kept current by every edit. */
  achieved: { kcal: number; proteinG: number } | null
  supplement: { name: string; proteinG: number; kcal: number } | null
  targetEdited: boolean
  warningCount: number
}

export interface WeightPoint {
  label: string
  weightKg: number
}

export interface ClientProgramme {
  client: typeof clients.$inferSelect
  sessions: Array<typeof counsellingSessions.$inferSelect>
  /** The client's newest roadmap — what the next week is generated from. */
  roadmap: { id: string; sessionId: string; input: RoadmapInput; output: RoadmapResult } | null
  latestAnswers: Answers
  female: boolean
  weeks: PlanWeek<PlanSummary>[]
  checkinsByWeek: Map<number, WeeklyCheckin>
  /** The week after the last week that has a plan (1 when there is none). */
  nextWeek: number
  /** Region/cuisine to send when generating the next week. */
  nextRegion: string
  weights: WeightPoint[]
  targetWeightKg: number | null
}

function summarize(p: typeof dietPlans.$inferSelect): PlanSummary {
  const target = macroSchema.safeParse(p.targets)
  const achieved = macroSchema.safeParse(p.achieved)
  const supp = supplementSchema.safeParse(p.supplement)
  return {
    id: p.id,
    weekNumber: p.weekNumber,
    status: p.status,
    createdAt: p.createdAt,
    weekStart: p.weekStart,
    weekEnd: p.weekEnd,
    region: p.region,
    engine: p.engine,
    target: target.success ? { kcal: target.data.kcal, proteinG: target.data.proteinG } : null,
    achieved: achieved.success ? { kcal: achieved.data.kcal, proteinG: achieved.data.proteinG } : null,
    supplement: supp.success
      ? {
          name: supp.data.name,
          proteinG: supp.data.proteinGPerServing * supp.data.servingsPerDay,
          kcal: supp.data.kcalPerServing * supp.data.servingsPerDay,
        }
      : null,
    targetEdited: p.targetOverride !== null,
    warningCount: p.warnings?.length ?? 0,
  }
}

/** Everything the client page and the weekly check-in page show, in one place. */
export async function loadClientProgramme(clientId: string): Promise<ClientProgramme | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1)
  if (!client) return null

  const [sessions, roadmapRows, planRows, checkinRows] = await Promise.all([
    db.select().from(counsellingSessions).where(eq(counsellingSessions.clientId, clientId)).orderBy(desc(counsellingSessions.createdAt)),
    db
      .select({ roadmap: roadmaps })
      .from(roadmaps)
      .innerJoin(counsellingSessions, eq(roadmaps.sessionId, counsellingSessions.id))
      .where(eq(counsellingSessions.clientId, clientId))
      .orderBy(desc(roadmaps.createdAt))
      .limit(1),
    db.select().from(dietPlans).where(eq(dietPlans.clientId, clientId)),
    db.select().from(weeklyCheckins).where(eq(weeklyCheckins.clientId, clientId)),
  ])

  const roadmapRow = roadmapRows[0]?.roadmap
  const roadmap = roadmapRow
    ? {
        id: roadmapRow.id,
        sessionId: roadmapRow.sessionId,
        input: roadmapRow.input as RoadmapInput,
        output: roadmapRow.output as RoadmapResult,
      }
    : null

  // The newest submitted session's answers describe the client today; fall
  // back to any session so a client mid-way through a draft still shows.
  const profileSession = sessions.find((s) => s.status !== "draft") ?? sessions[0]
  const latestAnswers = (profileSession?.answers ?? {}) as Answers

  const weeks = groupPlansByWeek(planRows.map(summarize))
  const checkinsByWeek = new Map(checkinRows.map((c) => [c.weekNumber, c]))
  const lastWeek = weeks.at(-1)
  const nextWeek = lastWeek ? lastWeek.weekNumber + 1 : 1
  const nextRegion = lastWeek?.current.region ?? regionFromAnswers(latestAnswers) ?? "north_indian"

  const weights: WeightPoint[] = []
  if (roadmap) weights.push({ label: "Start", weightKg: roadmap.input.weightKg })
  for (const c of [...checkinRows].sort((a, b) => a.weekNumber - b.weekNumber)) {
    const w = checkinWeightKg(c.answers as Answers)
    if (w !== null) weights.push({ label: `Week ${c.weekNumber}`, weightKg: w })
  }

  return {
    client,
    sessions,
    roadmap,
    latestAnswers,
    female: latestAnswers.gender === "Female",
    weeks,
    checkinsByWeek,
    nextWeek,
    nextRegion,
    weights,
    targetWeightKg: roadmap?.output.anthro.targetWeightKg ?? null,
  }
}

/** One check-in row, or null. */
export async function loadCheckin(clientId: string, weekNumber: number): Promise<WeeklyCheckin | null> {
  const [row] = await db
    .select()
    .from(weeklyCheckins)
    .where(and(eq(weeklyCheckins.clientId, clientId), eq(weeklyCheckins.weekNumber, weekNumber)))
    .limit(1)
  return row ?? null
}
