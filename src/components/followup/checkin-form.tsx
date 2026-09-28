"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { QuestionField } from "@/components/counselling/question-field"
import { saveCheckin } from "@/app/(app)/clients/[clientId]/week/[week]/actions"
import type { Answers } from "@/lib/counselling/questions"
import { checkinQuestionsFor, visibleCheckinQuestions } from "@/lib/followup/checkin-questions"

export function CheckinForm({
  clientId,
  weekNumber,
  female,
  initialAnswers,
  submitted,
  onDone,
}: {
  clientId: string
  weekNumber: number
  female: boolean
  initialAnswers: Answers
  submitted: boolean
  /** Called after a successful submit (e.g. to leave edit mode). */
  onDone?: () => void
}) {
  const router = useRouter()
  const [answers, setAnswers] = useState<Answers>(initialAnswers)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isPending, startTransition] = useTransition()
  const questions = visibleCheckinQuestions(checkinQuestionsFor({ female }), answers)

  function save(submit: boolean) {
    startTransition(async () => {
      const result = await saveCheckin({ clientId, weekNumber, answers, submit })
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {})
        toast.error(result.message)
        return
      }
      setErrors({})
      toast.success(submit ? `Week ${weekNumber} check-in submitted.` : "Draft saved.")
      router.refresh()
      if (submit) onDone?.()
    })
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        {questions.map((q) => (
          <div key={q.id} className={q.type === "textarea" || q.type === "multi" ? "sm:col-span-2" : undefined}>
            <QuestionField
              question={q}
              value={answers[q.id]}
              required={q.required === true}
              error={errors[q.id]}
              onChange={(value) => setAnswers((prev) => ({ ...prev, [q.id]: value }))}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button onClick={() => save(true)} disabled={isPending}>
          {isPending ? "Saving…" : submitted ? "Save changes" : "Submit check-in"}
        </Button>
        {!submitted && (
          <Button variant="outline" onClick={() => save(false)} disabled={isPending}>
            Save draft
          </Button>
        )}
      </div>
    </div>
  )
}
