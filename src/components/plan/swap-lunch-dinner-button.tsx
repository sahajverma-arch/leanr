"use client"

import { useState, useTransition } from "react"
import { ArrowUpDown } from "lucide-react"
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
import { swapLunchAndDinner } from "@/app/(app)/plans/[id]/actions"

/**
 * "Swap lunch and dinner" for one day, or for the whole week. The two plates
 * move whole — dishes, quantities and notes — so the day's totals do not
 * change. Sits in the day's header bar; screen only.
 */
export function SwapLunchDinnerButton({ planId, dayId, dayLabel }: { planId: string; dayId: string; dayLabel: string }) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function swap(scope: "day" | "week") {
    startTransition(async () => {
      try {
        const result = await swapLunchAndDinner(planId, scope === "day" ? dayId : null)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        toast.success(
          result.daysSwapped > 1 ? `Lunch and dinner swapped on all ${result.daysSwapped} days.` : `Lunch and dinner swapped on ${dayLabel}.`
        )
        setOpen(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not swap lunch and dinner")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-normal text-white/80 hover:bg-white/10 hover:text-white print:hidden"
            title="Swap lunch and dinner"
          />
        }
      >
        <ArrowUpDown className="size-3.5" aria-hidden />
        Swap lunch &amp; dinner
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Swap lunch and dinner</DialogTitle>
          <DialogDescription>
            Lunch&apos;s dishes move to dinner and dinner&apos;s to lunch, with their quantities and notes. The day&apos;s
            calories and macros stay the same. If one of them is the protein-rich meal, it moves with its food.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => setOpen(false)} className="sm:mr-auto">
            Cancel
          </Button>
          <Button variant="outline" disabled={isPending} onClick={() => swap("week")}>
            Every day this week
          </Button>
          <Button disabled={isPending} onClick={() => swap("day")}>
            {isPending ? "Swapping…" : `Only ${dayLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
