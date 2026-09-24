"use client"

import { useId, useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { setMealNote } from "@/app/(app)/plans/[id]/actions"
import { MEAL_NOTE_MAX_LENGTH, MealNoteValidationError, normalizeMealNote } from "@/lib/plan/meal-note"

/**
 * The dietitian's note on one meal, shown under its foods, plus the dialog
 * that edits it. The note prints in the downloaded PDF in the same place, so
 * what is shown here is what the client gets.
 *
 * Validation runs here as you type (same normalizeMealNote the server uses)
 * so a character the PDF can't print is caught before Save, and again on
 * the server, which is the real gate.
 */
export function MealNote({
  mealId,
  slotLabel,
  dayLabel,
  note,
  editable,
}: {
  mealId: string
  /** "Breakfast", "Lunch" … */
  slotLabel: string
  /** "Mon, 22 Sep" — only for the dialog title. */
  dayLabel: string
  note: string | null
  editable: boolean
}) {
  const checkboxId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note ?? "")
  const [applyAll, setApplyAll] = useState(false)
  const [isPending, startTransition] = useTransition()

  let validationError: string | null = null
  try {
    normalizeMealNote(draft)
  } catch (err) {
    if (err instanceof MealNoteValidationError) validationError = err.message
    else throw err
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setDraft(note ?? "")
      setApplyAll(false)
    }
  }

  function save(value: string) {
    startTransition(async () => {
      try {
        const result = await setMealNote(mealId, value, applyAll)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        const cleared = value.trim() === ""
        toast.success(
          result.mealsUpdated > 1
            ? `${cleared ? "Note removed from" : "Note saved to"} ${slotLabel.toLowerCase()} on all ${result.mealsUpdated} days.`
            : cleared
              ? "Note removed."
              : "Note saved."
        )
        setOpen(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save the note")
      }
    })
  }

  if (!note && !editable) return null

  return (
    <div className="mt-1.5">
      {note && (
        <p className="border-l-2 border-sky-500 pl-2 text-xs leading-snug whitespace-pre-line text-muted-foreground">
          <span className="font-medium text-foreground">Note: </span>
          {note}
        </p>
      )}

      {editable && (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger
            render={
              <button
                type="button"
                className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground print:hidden"
                title={`${note ? "Edit" : "Add"} a note for ${slotLabel}`}
              />
            }
          >
            {note ? "edit note" : "+ note"}
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Note for {slotLabel} · {dayLabel}
              </DialogTitle>
              <DialogDescription>
                What else the client needs for this meal — preparation, a side, a drink, timing. It prints under this
                meal in the PDF. A note does not change the meal&apos;s calories or macros.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. Soak the rajma overnight. Add a jeera-hing tadka. Have with a glass of chaas."
                rows={4}
                disabled={isPending}
                aria-invalid={validationError !== null}
                autoFocus
              />
              <div className="flex justify-between gap-3 text-xs">
                <span className={validationError ? "text-destructive" : "text-muted-foreground"}>
                  {validationError ?? "English letters only — the PDF can't print Hindi or emoji."}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {draft.trim().length}/{MEAL_NOTE_MAX_LENGTH}
                </span>
              </div>
              <label htmlFor={checkboxId} className="flex items-center gap-2 pt-1 text-sm">
                <Checkbox
                  id={checkboxId}
                  checked={applyAll}
                  onCheckedChange={(c) => setApplyAll(c === true)}
                  disabled={isPending}
                />
                Use this note for {slotLabel.toLowerCase()} on every day of this week
              </label>
            </div>

            <DialogFooter>
              {note && (
                <Button variant="outline" disabled={isPending} onClick={() => save("")} className="sm:mr-auto">
                  {applyAll ? "Remove from every day" : "Remove note"}
                </Button>
              )}
              <Button variant="outline" disabled={isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={isPending || validationError !== null} onClick={() => save(draft)}>
                {isPending ? "Saving…" : "Save note"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
