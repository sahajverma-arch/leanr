"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { addPlanItem, getAddItemCandidates, type SwapCandidate } from "@/app/(app)/plans/[id]/actions"
import { RecipeCandidateList } from "./recipe-candidate-list"

/**
 * Adding a dish to one meal of a generated plan.
 *
 * The picker offers the same pool generation drew from - diet type, cuisine,
 * season, the client's live allergens - minus whatever is already in this
 * meal. Search and the macro-profile chips live in RecipeCandidateList,
 * shared with the swap tab so the two cannot drift.
 *
 * The dish goes in at its own typical portion and the day is then
 * re-balanced, so adding something does not simply pile calories onto a day
 * already on target.
 */
export function AddItemButton({ mealId, slotLabel }: { mealId: string; slotLabel: string }) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && candidates === null) {
      startTransition(async () => {
        setCandidates(await getAddItemCandidates(mealId))
      })
    }
  }

  function handlePick(recipeId: string) {
    startTransition(async () => {
      try {
        await addPlanItem(mealId, recipeId)
        toast.success("Added — the day was re-balanced around it.")
        setOpen(false)
        setCandidates(null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not add that dish")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            title={`Add a dish to ${slotLabel}`}
          />
        }
      >
        + add
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a dish to {slotLabel}</DialogTitle>
        </DialogHeader>

        <RecipeCandidateList
          candidates={candidates}
          disabled={isPending}
          onPick={handlePick}
          emptyMessage="No eligible dishes left for this client at this meal."
        />

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
