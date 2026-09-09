"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { getSwapCandidates, swapPlanItem, type SwapCandidate } from "@/app/(app)/plans/[id]/actions"
import { formatItemLabel } from "@/lib/plan/format-item"
import type { PlanViewItem } from "@/lib/plan/plan-view-model"

export function SwapItemButton({
  item,
  editable,
  label,
}: {
  item: PlanViewItem
  editable: boolean
  /** Presentation-layer override (e.g. "Rajma Curry (15 g)" instead of "Rajma (15 g)") — see meal-composition.ts. Defaults to the plain per-item label; swap behaviour and the underlying item are always unaffected. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null)
  const [isPending, startTransition] = useTransition()
  const displayLabel = label ?? formatItemLabel(item)

  if (!editable) {
    return <span>{displayLabel}</span>
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && candidates === null) {
      startTransition(async () => {
        setCandidates(await getSwapCandidates(item.id))
      })
    }
  }

  function handlePick(foodId: string) {
    startTransition(async () => {
      try {
        await swapPlanItem(item.id, foodId)
        // Deliberately not "macros unchanged": that holds for an exchange
        // swap (same exchange type and count) but NOT for a recipe swap,
        // where the new dish has different per-100g macros and the whole day
        // is re-balanced around it. Promising something untrue about a
        // clinical number is worse than a vaguer message.
        toast.success("Swapped — quantities recomputed. Check the macros above.")
        setOpen(false)
        setCandidates(null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Swap failed")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
            title="Click to swap this food"
          />
        }
      >
        {displayLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Swap {item.nameEn}</DialogTitle>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {candidates === null ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading eligible foods…</p>
          ) : candidates.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No other eligible {item.exchangeType} foods for this client at this slot.
            </p>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={isPending}
                onClick={() => handlePick(c.id)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <span>{c.nameEn}</span>
                {c.householdMeasure && <span className="text-xs text-muted-foreground">{c.householdMeasure}</span>}
              </button>
            ))
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
