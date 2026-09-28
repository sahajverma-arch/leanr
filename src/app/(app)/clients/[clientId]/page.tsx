import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { WeightChart } from "@/components/followup/weight-chart"
import { startCounsellingSessionForClient } from "@/app/(app)/counselling/actions"
import type { Answers } from "@/lib/counselling/questions"
import { checkinWeightKg } from "@/lib/followup/checkin-questions"
import { formatWeightChange } from "@/lib/followup/client-weeks"
import { loadClientProgramme, type PlanSummary } from "@/lib/followup/load-client-programme"
import { formatGrams, formatKcal, formatWeight } from "@/lib/format"
import { cn } from "@/lib/utils"

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

function MacroLine({ plan }: { plan: PlanSummary }) {
  return (
    <div className="space-y-0.5 text-sm tabular-nums">
      {plan.target && (
        <p>
          <span className="text-muted-foreground">Target </span>
          {formatKcal(plan.target.kcal)} kcal · {formatGrams(plan.target.proteinG)} g protein
          {plan.targetEdited && (
            <Badge variant="secondary" className="ml-2 font-normal">
              edited
            </Badge>
          )}
        </p>
      )}
      {plan.achieved && (
        <p>
          <span className="text-muted-foreground">Plan gives </span>
          {formatKcal(plan.achieved.kcal)} kcal · {formatGrams(plan.achieved.proteinG)} g protein
          <span className="text-muted-foreground"> a day on average</span>
        </p>
      )}
      {plan.supplement && (
        <p className="text-muted-foreground">
          + {formatGrams(plan.supplement.proteinG)} g protein, {formatKcal(plan.supplement.kcal)} kcal from{" "}
          {plan.supplement.name}
        </p>
      )}
    </div>
  )
}

function PlanStatus({ plan }: { plan: PlanSummary }) {
  return plan.status === "approved" ? <Badge>Approved</Badge> : <Badge variant="secondary">Draft</Badge>
}

export default async function ClientDetailPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  const programme = await loadClientProgramme(clientId)
  if (!programme) notFound()
  const { client, sessions, roadmap, latestAnswers, weeks, checkinsByWeek, nextWeek, weights, targetWeightKg } = programme

  async function startQuick() {
    "use server"
    await startCounsellingSessionForClient(clientId, "quick")
  }

  async function startFull() {
    "use server"
    await startCounsellingSessionForClient(clientId, "full")
  }

  const profile = [
    roadmap ? `${roadmap.input.ageYears}y` : null,
    typeof latestAnswers.gender === "string" ? latestAnswers.gender : null,
    typeof latestAnswers.q33 === "string" ? latestAnswers.q33 : null,
    Array.isArray(latestAnswers.q34) ? (latestAnswers.q34 as string[]).join(", ") : null,
  ].filter((v): v is string => v !== null)

  const start = weights[0]
  const latest = weights.at(-1)
  const nextCheckin = checkinsByWeek.get(nextWeek)
  const reviewSession = roadmap ? sessions.find((s) => s.id === roadmap.sessionId) : undefined

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">{client.name}</h1>
          {profile.length > 0 && <p className="text-sm">{profile.join(" · ")}</p>}
          <p className="text-sm text-muted-foreground">
            {client.phone ?? "No phone"} · {client.email ?? "No email"}
          </p>
        </div>
        <div className="flex gap-2">
          <form action={startQuick}>
            <Button type="submit" variant="outline" size="sm">
              New Quick
            </Button>
          </form>
          <form action={startFull}>
            <Button type="submit" size="sm">
              New Full
            </Button>
          </form>
        </div>
      </div>

      {/* Weight progress */}
      {start && (
        <Card>
          <CardHeader>
            <CardTitle>Weight</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm tabular-nums">
              Start {formatWeight(start.weightKg)} kg
              {latest && latest !== start && (
                <>
                  {" "}
                  → {latest.label.toLowerCase()} {formatWeight(latest.weightKg)} kg{" "}
                  <span className="text-muted-foreground">({formatWeightChange(start.weightKg, latest.weightKg)})</span>
                </>
              )}
              {targetWeightKg !== null && (
                <span className="text-muted-foreground"> · goal {formatWeight(targetWeightKg)} kg</span>
              )}
            </p>
            <WeightChart points={weights} targetWeightKg={targetWeightKg} />
            {weights.length < 2 && (
              <p className="text-xs text-muted-foreground">
                Each weekly check-in adds the client&apos;s weight here.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Weeks */}
      <Card>
        <CardHeader>
          <CardTitle>Weekly plans</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {weeks.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No plan yet. Week 1 is generated from the counselling review
              {reviewSession && reviewSession.status !== "draft" && (
                <>
                  {" — "}
                  <Link href={`/sessions/${reviewSession.id}/review`} className="underline">
                    open the review
                  </Link>
                </>
              )}
              .
            </p>
          )}

          {weeks.map(({ weekNumber, current, earlier }) => {
            const checkin = checkinsByWeek.get(weekNumber)
            const checkinWeight = checkin ? checkinWeightKg(checkin.answers as Answers) : null
            return (
              <div key={weekNumber} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">Week {weekNumber}</h3>
                    <span className="text-sm text-muted-foreground">
                      {shortDate(current.weekStart)} – {shortDate(current.weekEnd)}
                    </span>
                    <PlanStatus plan={current} />
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/plans/${current.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      Open
                    </Link>
                    <a href={`/api/plans/${current.id}/pdf`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      PDF
                    </a>
                  </div>
                </div>

                {weekNumber >= 2 && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">Check-in: </span>
                    {checkin ? (
                      <>
                        {checkinWeight !== null ? `${formatWeight(checkinWeight)} kg` : "no weight"}
                        {typeof (checkin.answers as Answers).fu_adherence === "string" &&
                          ` · followed ${(checkin.answers as Answers).fu_adherence as string}`}{" "}
                        <Link href={`/clients/${clientId}/week/${weekNumber}`} className="underline">
                          view
                        </Link>
                      </>
                    ) : (
                      <span className="text-muted-foreground">none recorded (generated before check-ins)</span>
                    )}
                  </p>
                )}

                <MacroLine plan={current} />
                {current.warningCount > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {current.warningCount} warning{current.warningCount === 1 ? "" : "s"} on this plan — open it to see them.
                  </p>
                )}

                {earlier.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {earlier.length} earlier version{earlier.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {earlier.map((p) => (
                        <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-2">
                          <div className="space-y-0.5">
                            <p className="flex items-center gap-2">
                              <span>
                                Generated{" "}
                                {p.createdAt.toLocaleString("en-IN", {
                                  day: "numeric",
                                  month: "short",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                              </span>
                              <PlanStatus plan={p} />
                            </p>
                            <p className="tabular-nums text-muted-foreground">
                              {p.target &&
                                `Target ${formatKcal(p.target.kcal)} kcal · ${formatGrams(p.target.proteinG)} g protein`}
                              {p.achieved &&
                                ` · gives ${formatKcal(p.achieved.kcal)} kcal · ${formatGrams(p.achieved.proteinG)} g`}
                            </p>
                          </div>
                          <Link href={`/plans/${p.id}`} className="underline">
                            Open
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )
          })}

          {weeks.length > 0 && roadmap && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-4">
              <div>
                <h3 className="font-medium">Week {nextWeek}</h3>
                <p className="text-sm text-muted-foreground">
                  {nextCheckin?.status === "submitted"
                    ? "Check-in done — set the targets and generate."
                    : nextCheckin
                      ? "Check-in started, not submitted yet."
                      : `Fill in the follow-up check-in before generating week ${nextWeek}.`}
                </p>
              </div>
              <Link href={`/clients/${clientId}/week/${nextWeek}`} className={cn(buttonVariants({ size: "sm" }))}>
                {nextCheckin?.status === "submitted"
                  ? `Generate week ${nextWeek}`
                  : nextCheckin
                    ? "Continue check-in"
                    : `Start week ${nextWeek} check-in`}
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Counselling sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Counselling sessions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {sessions.length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
          {sessions.map((session) => {
            const href = session.status === "draft" ? `/counselling/${session.id}` : `/sessions/${session.id}`
            return (
              <Link
                key={session.id}
                href={href}
                className="flex items-center justify-between rounded-md border p-3 text-sm hover:bg-muted"
              >
                <span>
                  {session.type === "quick" ? "Quick" : "Full"} — {session.createdAt.toLocaleDateString()}
                </span>
                <span className="flex items-center gap-2">
                  {session.status === "draft" && <span className="text-muted-foreground">Resume draft</span>}
                  <Badge variant={session.status === "submitted" ? "default" : "secondary"}>{session.status}</Badge>
                </span>
              </Link>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
