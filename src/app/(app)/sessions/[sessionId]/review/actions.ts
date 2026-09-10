"use server"

import { eq } from "drizzle-orm"
import { z } from "zod"
import { revalidatePath } from "next/cache"

import { db } from "@/db"
import { counsellingSessions, roadmapOverrides, roadmaps, roadmapSupplements } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { ENGINE_VERSION, roadmapFor } from "@/lib/counselling/roadmap"
import { roadmapInputFromAnswers } from "@/lib/counselling/roadmap-input"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { proteinPowderRestriction } from "@/lib/plan/client-profile-from-answers"
import { SupplementValidationError } from "@/lib/counselling/supplement-adjusted-targets"

/** Snapshots are immutable — this always inserts a new row, never updates the existing one. */
export async function recomputeRoadmap(sessionId: string) {
  await requireStaffUser()

  const [session] = await db
    .select()
    .from(counsellingSessions)
    .where(eq(counsellingSessions.id, sessionId))
    .limit(1)
  if (!session) throw new Error("Session not found")

  const roadmapInput = roadmapInputFromAnswers(session.answers as Answers)
  const output = roadmapFor(roadmapInput)

  await db.insert(roadmaps).values({
    sessionId,
    engineVersion: ENGINE_VERSION,
    input: roadmapInput,
    output,
  })

  revalidatePath(`/sessions/${sessionId}/review`)
}

export async function recordOverride(input: {
  roadmapId: string
  flagCode: string
  reason: string
  dietitianName: string
  sessionId: string
}) {
  const user = await requireStaffUser()

  await db.insert(roadmapOverrides).values({
    roadmapId: input.roadmapId,
    flagCode: input.flagCode,
    reason: input.reason,
    dietitianName: input.dietitianName,
    createdBy: user.id,
  })

  revalidatePath(`/sessions/${input.sessionId}/review`)
}

/**
 * Prescribing the client's protein supplement, from the review page.
 *
 * Stored against the roadmap and never mutating it — the same shape as
 * recordOverride above. The numbers are typed off the tub's label by a
 * dietitian; nothing here is inferred, and no model ever sees them.
 *
 * The effect is entirely upstream of generation: whatever is saved here
 * reduces the target the recipes are solved against, via
 * supplement-adjusted-targets.ts. Saving one does NOT regenerate an existing
 * plan — an already-generated plan keeps its own snapshot, and the dietitian
 * regenerates if they want the change reflected.
 */
const supplementInputSchema = z.object({
  roadmapId: z.string().uuid(),
  sessionId: z.string().uuid(),
  name: z.string().trim().min(1, "Name the supplement.").max(120),
  servingLabel: z.string().trim().min(1, "Describe one serving, e.g. \"1 scoop\".").max(60),
  // A prescription of zero servings is a removal, not a prescription — the
  // dietitian should delete it instead, so this is a real lower bound.
  servingsPerDay: z.number().positive("Servings per day must be more than zero.").max(20),
  // Bounds are deliberately wide but finite: they catch a slipped decimal
  // point (240 instead of 24) without second-guessing a real product.
  proteinGPerServing: z.number().min(0).max(200, "That is more protein than any real serving — check the label."),
  kcalPerServing: z.number().min(0).max(2000, "That is more energy than any real serving — check the label."),
})

export type SupplementInput = z.input<typeof supplementInputSchema>

export async function savePrescribedSupplement(input: SupplementInput) {
  const user = await requireStaffUser()
  const parsed = supplementInputSchema.parse(input)

  // A client who cannot tolerate protein powder must not be prescribed one.
  // The intolerance list is re-read live from the session's current answers,
  // not snapshotted — a correction made after counselling has to count.
  const [row] = await db
    .select({ answers: counsellingSessions.answers })
    .from(roadmaps)
    .innerJoin(counsellingSessions, eq(roadmaps.sessionId, counsellingSessions.id))
    .where(eq(roadmaps.id, parsed.roadmapId))
    .limit(1)
  if (row && proteinPowderRestriction(row.answers as Answers) === "allergy") {
    // Blocks on an allergy only. q27's own note draws the line: an allergen
    // "never appears in any meal, in any form", while a trigger food is
    // "reduced, timed differently or retested smaller" — a judgement the
    // dietitian owns. An intolerance therefore warns on the review page
    // instead of refusing here.
    throw new SupplementValidationError(
      "This client is recorded as ALLERGIC to protein powder — never serve. Correct the counselling answers first if that is wrong."
    )
  }

  // One per roadmap: update in place rather than accumulating rows, matching
  // the unique constraint on roadmap_id.
  await db
    .insert(roadmapSupplements)
    .values({
      roadmapId: parsed.roadmapId,
      name: parsed.name,
      servingLabel: parsed.servingLabel,
      servingsPerDay: parsed.servingsPerDay,
      proteinGPerServing: parsed.proteinGPerServing,
      kcalPerServing: parsed.kcalPerServing,
      createdBy: user.id,
    })
    .onConflictDoUpdate({
      target: roadmapSupplements.roadmapId,
      set: {
        name: parsed.name,
        servingLabel: parsed.servingLabel,
        servingsPerDay: parsed.servingsPerDay,
        proteinGPerServing: parsed.proteinGPerServing,
        kcalPerServing: parsed.kcalPerServing,
        updatedAt: new Date(),
      },
    })

  revalidatePath(`/sessions/${parsed.sessionId}/review`)
}

export async function removePrescribedSupplement(roadmapId: string, sessionId: string) {
  await requireStaffUser()
  await db.delete(roadmapSupplements).where(eq(roadmapSupplements.roadmapId, z.string().uuid().parse(roadmapId)))
  revalidatePath(`/sessions/${z.string().uuid().parse(sessionId)}/review`)
}
