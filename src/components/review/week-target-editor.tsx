"use client"

import { useState, useTransition } from "react"
import { PencilIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { clearWeekTargetOverride, saveWeekTargetOverride } from "@/app/(app)/sessions/[sessionId]/review/actions"
import { impliedFatG, weekTargetOverrideWarnings } from "@/lib/counselling/week-target-override"

export interface WeekTargetEditorProps {
  roadmapId: string
  sessionId: string
  weekNumber: number
  /** The roadmap's own computed target for this week, before any override. */
  computed: { kcal: number; proteinG: number; carbsG: number; fatG: number }
  /** The dietitian's saved override for this week, or null. */
  current: { kcal: number; proteinG: number; carbsG: number } | null
}

/**
 * Pencil on a week row of the review page's targets table. Opens a side
 * panel where the dietitian sets the week's kcal, protein and carbs to what
 * the client prefers. Fat is shown live as the residual — it is never typed,
 * so the target always adds up. See week-target-override.ts.
 */
export function WeekTargetEditor({ roadmapId, sessionId, weekNumber, computed, current }: WeekTargetEditorProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const start = current ?? computed
  const [kcal, setKcal] = useState(String(Math.round(start.kcal)))
  const [proteinG, setProteinG] = useState(String(Math.round(start.proteinG)))
  const [carbsG, setCarbsG] = useState(String(Math.round(start.carbsG)))

  const draft = { kcal: Number(kcal), proteinG: Number(proteinG), carbsG: Number(carbsG) }
  const draftValid = [draft.kcal, draft.proteinG, draft.carbsG].every((n) => Number.isFinite(n) && n >= 0)
  const fatG = draftValid ? impliedFatG(draft) : null
  const warnings = draftValid && fatG !== null && fatG >= 0 ? weekTargetOverrideWarnings(draft) : []

  function handleOpenChange(next: boolean) {
    // Re-seed from the saved figures every time the panel opens, so an
    // abandoned edit never reappears as if it had been saved.
    if (next) {
      const seed = current ?? computed
      setKcal(String(Math.round(seed.kcal)))
      setProteinG(String(Math.round(seed.proteinG)))
      setCarbsG(String(Math.round(seed.carbsG)))
    }
    setOpen(next)
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await saveWeekTargetOverride({ roadmapId, sessionId, weekNumber, ...draft })
        toast.success(`Week ${weekNumber} targets saved — the plan will be generated against them.`)
        setOpen(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save the week's targets")
      }
    })
  }

  function handleReset() {
    startTransition(async () => {
      try {
        await clearWeekTargetOverride(roadmapId, sessionId, weekNumber)
        toast.success(`Week ${weekNumber} is back to the calculated targets.`)
        setOpen(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not reset the week's targets")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={`Edit week ${weekNumber} targets`} />}
      >
        <PencilIcon />
      </DialogTrigger>
      {/* Rendered as a right-hand side panel rather than a centred dialog. */}
      <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-full translate-x-0 translate-y-0 flex-col rounded-none p-4 sm:max-w-md data-open:zoom-in-100 data-open:slide-in-from-right data-closed:zoom-out-100 data-closed:slide-out-to-right">
        <DialogHeader>
          <DialogTitle>Week {weekNumber} targets</DialogTitle>
          <DialogDescription>
            Change the protein, carbs and calories to what the client prefers. Fat is worked out from the other
            three so the day always adds up.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`wk${weekNumber}-kcal`}>Calories (kcal)</Label>
            <Input
              id={`wk${weekNumber}-kcal`}
              type="number"
              min="0"
              step="10"
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Calculated: {Math.round(computed.kcal)} kcal</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wk${weekNumber}-protein`}>Protein (g)</Label>
            <Input
              id={`wk${weekNumber}-protein`}
              type="number"
              min="0"
              step="1"
              value={proteinG}
              onChange={(e) => setProteinG(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Calculated: {Math.round(computed.proteinG)} g</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wk${weekNumber}-carbs`}>Carbs (g)</Label>
            <Input
              id={`wk${weekNumber}-carbs`}
              type="number"
              min="0"
              step="1"
              value={carbsG}
              onChange={(e) => setCarbsG(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Calculated: {Math.round(computed.carbsG)} g</p>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm tabular-nums">
            <span className="text-muted-foreground">Fat (worked out): </span>
            {fatG === null ? "—" : fatG < 0 ? (
              <span className="text-destructive">
                no room left — protein and carbs already exceed the calories
              </span>
            ) : (
              <span>{Math.round(fatG)} g</span>
            )}
            <span className="text-muted-foreground"> · calculated {Math.round(computed.fatG)} g</span>
          </div>

          {warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              {warnings.map((w, n) => (
                <li key={n}>• {w}</li>
              ))}
            </ul>
          )}

          <p className="text-xs text-muted-foreground">
            These are the full daily targets. A prescribed protein supplement is still subtracted from them before
            the food plan is built. An already-generated plan is not changed — regenerate it to use new numbers.
          </p>
        </div>

        <DialogFooter className="mt-auto">
          {current && (
            <Button variant="outline" onClick={handleReset} disabled={isPending}>
              Reset to calculated
            </Button>
          )}
          <Button onClick={handleSave} disabled={isPending || !draftValid || fatG === null || fatG < 0}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
