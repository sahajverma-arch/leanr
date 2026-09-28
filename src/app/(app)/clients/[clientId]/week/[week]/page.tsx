import Link from "next/link"
import { eq, and } from "drizzle-orm"
import { notFound } from "next/navigation"

import { db } from "@/db"
import { roadmapSupplements, roadmapWeekTargets } from "@/db/schema"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckinPanel } from "@/components/followup/checkin-panel"
import { GenerateWeekButton } from "@/components/followup/generate-week-button"
import { WeekTargetEditor } from "@/components/review/week-target-editor"
import type { Answers } from "@/lib/counselling/questions"
import { weekTargets } from "@/lib/counselling/roadmap"
import { foodTargetsAfterSupplement, type PrescribedSupplement } from "@/lib/counselling/supplement-adjusted-targets"
import { applyWeekTargetOverride, WeekTargetValidationError } from "@/lib/counselling/week-target-override"
import { checkinWeightKg, describeCheckinAnswers } from "@/lib/followup/checkin-questions"
import { checkinGateError, formatWeightChange } from "@/lib/followup/client-weeks"
import { loadClientProgramme } from "@/lib/followup/load-client-programme"
import { formatGrams, formatKcal, formatWeight } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The weekly follow-up: record how the client's week went, set next week's
 * numbers, then generate. Week 1 comes from counselling, so this page exists
 * for week 2 onward only.
 */
export default async function WeeklyCheckinPage({ params }: { params: Promise<{ clientId: string; week: string }> }) {
  const { clientId, week } = await params
  const weekNumber = Number(week)
  if (!Number.isInteger(weekNumber) || weekNumber < 2 || weekNumber > 104) notFound()

  const programme = await loadClientProgramme(clientId)
  if (!programme) notFound()
  const { client, roadmap, weeks, checkinsByWeek, female, weights } = programme

  const backLink = (
    <Link href={`/clients/${clientId}`} className="text-sm text-muted-foreground underline">
      ← {client.name}
    </Link>
  )

  const previousWeek = weeks.find((w) => w.weekNumber === weekNumber - 1)
  if (!previousWeek || !roadmap) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {backLink}
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Week {weekNumber - 1} has no plan yet — generate it before the week {weekNumber} check-in.
        </div>
      </div>
    )
  }

  const thisWeek = weeks.find((w) => w.weekNumber === weekNumber)
  const checkin = checkinsByWeek.get(weekNumber) ?? null
  const answers = (checkin?.answers ?? {}) as Answers
  const submitted = checkin?.status === "submitted"
  const gateError = checkinGateError(weekNumber, checkin?.status ?? null)

  // Weight change since the previous reading (the week before's check-in, or counselling).
  const weight = checkinWeightKg(answers)
  const earlierReadings = weights.filter((p) => p.label !== `Week ${weekNumber}`)
  const previousReading = earlierReadings.at(-1)

  // This week's targets, exactly as generation will compute them: computed →
  // dietitian override → minus supplement. Same order as route.ts.
  const [[overrideRow], [supplementRow]] = await Promise.all([
    db
      .select()
      .from(roadmapWeekTargets)
      .where(and(eq(roadmapWeekTargets.roadmapId, roadmap.id), eq(roadmapWeekTargets.weekNumber, weekNumber)))
      .limit(1),
    db.select().from(roadmapSupplements).where(eq(roadmapSupplements.roadmapId, roadmap.id)).limit(1),
  ])
  const override = overrideRow ? { kcal: overrideRow.kcal, proteinG: overrideRow.proteinG, carbsG: overrideRow.carbsG } : null
  const supplement: PrescribedSupplement | null = supplementRow
    ? {
        name: supplementRow.name,
        servingLabel: supplementRow.servingLabel,
        servingsPerDay: supplementRow.servingsPerDay,
        proteinGPerServing: supplementRow.proteinGPerServing,
        kcalPerServing: supplementRow.kcalPerServing,
      }
    : null
  const computed = weekTargets(roadmap.output, weekNumber)
  let targetError: string | null = null
  let prescribed = computed
  try {
    prescribed = applyWeekTargetOverride(computed, override)
  } catch (err) {
    if (!(err instanceof WeekTargetValidationError)) throw err
    targetError = err.message
  }
  const { food } = foodTargetsAfterSupplement(prescribed, supplement)
  const previous = previousWeek.current

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <div className="space-y-1">
        {backLink}
        <h1 className="font-serif text-2xl font-semibold">Week {weekNumber} check-in</h1>
        <p className="text-sm text-muted-foreground">
          How week {weekNumber - 1} went. Record it, set the week {weekNumber} numbers, then generate.
        </p>
      </div>

      {/* Last week, for reference while asking */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Week {weekNumber - 1} plan
            {previous.status === "approved" ? <Badge>Approved</Badge> : <Badge variant="secondary">Draft</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm tabular-nums">
          <div>
            {previous.target && (
              <p>
                <span className="text-muted-foreground">Target </span>
                {formatKcal(previous.target.kcal)} kcal · {formatGrams(previous.target.proteinG)} g protein
              </p>
            )}
            {previous.achieved && (
              <p>
                <span className="text-muted-foreground">Plan gave </span>
                {formatKcal(previous.achieved.kcal)} kcal · {formatGrams(previous.achieved.proteinG)} g protein
              </p>
            )}
          </div>
          <Link href={`/plans/${previous.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            Open week {weekNumber - 1}
          </Link>
        </CardContent>
      </Card>

      {/* The check-in */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Follow-up questions
            {submitted ? <Badge>Submitted</Badge> : checkin ? <Badge variant="secondary">Draft</Badge> : null}
          </CardTitle>
          {weight !== null && previousReading && (
            <p className="text-sm tabular-nums">
              {formatWeight(weight)} kg —{" "}
              <span className="text-muted-foreground">
                {formatWeightChange(previousReading.weightKg, weight)} since {previousReading.label.toLowerCase()}
              </span>
            </p>
          )}
        </CardHeader>
        <CardContent>
          <CheckinPanel
            clientId={clientId}
            weekNumber={weekNumber}
            female={female}
            answers={answers}
            submitted={submitted}
            summary={describeCheckinAnswers(answers)}
          />
        </CardContent>
      </Card>

      {/* Next week's numbers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1">
            Week {weekNumber} targets
            <WeekTargetEditor
              roadmapId={roadmap.id}
              sessionId={roadmap.sessionId}
              weekNumber={weekNumber}
              computed={computed}
              current={override}
            />
            {override && (
              <Badge variant="secondary" className="font-normal">
                edited
              </Badge>
            )}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            The check-in never changes these by itself. Use the pencil to set what the client should get this week.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 text-sm tabular-nums">
          {targetError ? (
            <p className="text-destructive">{targetError}</p>
          ) : (
            <>
              <p>
                {formatKcal(food.kcal)} kcal · {formatGrams(food.proteinG)} g protein · {formatGrams(food.carbsG)} g carbs ·{" "}
                {formatGrams(food.fatG)} g fat
                {supplement && <span className="text-muted-foreground"> from food</span>}
              </p>
              {supplement && (
                <p className="text-muted-foreground">
                  of {formatKcal(prescribed.kcal)} kcal · {formatGrams(prescribed.proteinG)} g protein prescribed — the rest
                  comes from {supplement.name}.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Generate */}
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        {thisWeek && (
          <Link href={`/plans/${thisWeek.current.id}`} className={cn(buttonVariants({ variant: "outline" }))}>
            Open week {weekNumber} plan
          </Link>
        )}
        <GenerateWeekButton
          roadmapId={roadmap.id}
          weekNumber={weekNumber}
          region={previous.region}
          disabled={gateError !== null || targetError !== null}
          label={thisWeek ? `Generate week ${weekNumber} again` : undefined}
        />
        {gateError && <p className="text-sm text-muted-foreground">{gateError}</p>}
        {thisWeek && (
          <p className="w-full text-xs text-muted-foreground">
            Generating again saves a new version. The earlier one stays on the client page.
          </p>
        )}
      </div>
    </div>
  )
}
