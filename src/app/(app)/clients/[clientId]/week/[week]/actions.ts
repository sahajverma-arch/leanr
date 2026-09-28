"use server"

import { and, desc, eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { counsellingSessions, dietPlans, weeklyCheckins } from "@/db/schema"
import type { Answers } from "@/lib/counselling/questions"
import { requireStaffUser } from "@/lib/counselling/require-staff-user"
import { checkinQuestionsFor, checkinSubmitErrors, sanitizeCheckinAnswers } from "@/lib/followup/checkin-questions"

const inputSchema = z.object({
  clientId: z.string().uuid(),
  weekNumber: z.number().int().min(2).max(104),
  answers: z.unknown(),
  submit: z.boolean(),
})

export type SaveCheckinResult =
  | { ok: true; status: "draft" | "submitted" }
  | { ok: false; message: string; fieldErrors?: Record<string, string> }

/**
 * Saves the week's follow-up check-in as a draft, or submits it.
 *
 * Validation problems are RETURNED rather than thrown: Next.js replaces a
 * thrown Server Action message with a generic one in production, and the
 * dietitian needs to see which field is wrong (same reason as setMealNote).
 */
export async function saveCheckin(input: z.input<typeof inputSchema>): Promise<SaveCheckinResult> {
  const user = await requireStaffUser()
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "That check-in could not be read — reload the page and try again." }
  const { clientId, weekNumber, submit } = parsed.data

  // A check-in prepares the NEXT week, so the week before it must exist.
  const [previous] = await db
    .select({ id: dietPlans.id })
    .from(dietPlans)
    .where(and(eq(dietPlans.clientId, clientId), eq(dietPlans.weekNumber, weekNumber - 1)))
    .limit(1)
  if (!previous) {
    return { ok: false, message: `Week ${weekNumber - 1} has no plan yet — generate it before the week ${weekNumber} check-in.` }
  }

  // Same profile session the client page reads: newest non-draft, else newest.
  const sessionRows = await db
    .select({ answers: counsellingSessions.answers, status: counsellingSessions.status })
    .from(counsellingSessions)
    .where(eq(counsellingSessions.clientId, clientId))
    .orderBy(desc(counsellingSessions.createdAt))
  const profile = sessionRows.find((s) => s.status !== "draft") ?? sessionRows[0]
  const female = (profile?.answers as Answers | undefined)?.gender === "Female"

  let answers: Answers
  try {
    answers = sanitizeCheckinAnswers(parsed.data.answers, checkinQuestionsFor({ female }))
  } catch {
    return { ok: false, message: "Some answers were not in a form that can be saved." }
  }

  if (submit) {
    const fieldErrors = checkinSubmitErrors(answers)
    if (Object.keys(fieldErrors).length > 0) {
      return { ok: false, message: "Fix the highlighted answers before submitting.", fieldErrors }
    }
  }

  const now = new Date()
  const [saved] = await db
    .insert(weeklyCheckins)
    .values({ clientId, weekNumber, answers, status: submit ? "submitted" : "draft", createdBy: user.id, submittedAt: submit ? now : null })
    .onConflictDoUpdate({
      target: [weeklyCheckins.clientId, weeklyCheckins.weekNumber],
      // Saving a draft over a submitted check-in keeps it submitted: once
      // week N may be generated, a later edit to a note must not re-lock it.
      set: submit
        ? { answers, status: "submitted", submittedAt: now, updatedAt: now }
        : { answers, updatedAt: now },
    })
    .returning({ status: weeklyCheckins.status })

  revalidatePath(`/clients/${clientId}`, "layout")
  return { ok: true, status: saved.status }
}
