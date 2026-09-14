"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { addPlanItem, getAddItemCandidates, type SwapCandidate } from "@/app/(app)/plans/[id]/actions"
import { formatGrams, formatKcal } from "@/lib/format"

/**
 * Adding a dish to one meal of a generated plan.
 *
 * The picker offers the same pool generation drew from - diet type, cuisine,
 * season, the client's live allergens - minus whatever is already in this
 * meal. It is a long list by design (a real cuisine pool is hundreds of
 * dishes), so it is filterable by name rather than paginated: a dietitian
 * adding a dish almost always has one in mind.
 *
 * Each row carries the dish's macros at its own typical portion, because that
 * is the only thing that makes one choice different from another here. The
 * dish goes in at exactly that portion and the day is then re-balanced, so
 * adding something does not simply pile calories onto a day already on
 * target.
 */
export function AddItemButton({ mealId, slotLabel }: { mealId: string; slotLabel: string }) {
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null)
  const [query, setQuery] = useState("")
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
        setQuery("")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not add that dish")
      }
    })
  }

  const needle = query.trim().toLowerCase()
  const shown = (candidates ?? []).filter((c) => c.nameEn.toLowerCase().includes(needle))

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

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search dishes…"
          disabled={candidates === null}
        />

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {candidates === null ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading eligible dishes…</p>
          ) : shown.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {candidates.length === 0
                ? "No eligible dishes left for this client at this meal."
                : `Nothing matching “${query.trim()}”.`}
            </p>
          ) : (
            shown.slice(0, 200).map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={isPending}
                onClick={() => handlePick(c.id)}
                className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <span className="block">{c.nameEn}</span>
                {c.preview && (
                  <span className="block text-xs text-muted-foreground">
                    {formatGrams(c.preview.grams)} g · {formatKcal(c.preview.kcal)} kcal · P{" "}
                    {formatGrams(c.preview.proteinG)}g · C {formatGrams(c.preview.carbsG)}g · F{" "}
                    {formatGrams(c.preview.fatG)}g
                  </span>
                )}
              </button>
            ))
          )}
        </div>
        {shown.length > 200 && (
          <p className="text-xs text-muted-foreground">
            Showing the first 200 of {shown.length} — type to narrow it down.
          </p>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
