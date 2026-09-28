"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { CheckinForm } from "@/components/followup/checkin-form"
import type { Answers } from "@/lib/counselling/questions"

/** A submitted check-in reads as a summary; "Edit answers" reopens the form. */
export function CheckinPanel({
  clientId,
  weekNumber,
  female,
  answers,
  submitted,
  summary,
}: {
  clientId: string
  weekNumber: number
  female: boolean
  answers: Answers
  submitted: boolean
  summary: Array<{ label: string; value: string }>
}) {
  const [editing, setEditing] = useState(!submitted)

  if (editing) {
    return (
      <CheckinForm
        clientId={clientId}
        weekNumber={weekNumber}
        female={female}
        initialAnswers={answers}
        submitted={submitted}
        onDone={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {summary.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
        Edit answers
      </Button>
    </div>
  )
}
