"use client"

import Link from "next/link"
import { useTransition } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { approvePlan } from "@/app/(app)/plans/[id]/actions"
import { cn } from "@/lib/utils"

export function PlanActionsBar({
  planId,
  clientId,
  weekNumber,
  status,
  withinTolerance,
  hasForbiddenFood = false,
}: {
  planId: string
  clientId: string
  weekNumber: number
  status: "draft" | "approved"
  withinTolerance: boolean
  /** The red "must not have" banner is showing; approval is refused server-side too. */
  hasForbiddenFood?: boolean
}) {
  const [isPending, startTransition] = useTransition()

  function handleApprove() {
    startTransition(async () => {
      try {
        await approvePlan(planId)
        toast.success("Plan approved.")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not approve plan")
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4 print:hidden">
      {status === "approved" ? (
        <Badge>Approved</Badge>
      ) : (
        <Button
          onClick={handleApprove}
          disabled={isPending || !withinTolerance || hasForbiddenFood}
          title={hasForbiddenFood ? "Remove the food this client must not have (red banner at the top) first." : undefined}
        >
          {isPending ? "Approving…" : "Mark approved"}
        </Button>
      )}
      {/* Week 2 onward starts from the weekly follow-up check-in, where the
          dietitian also sets that week's numbers before generating. */}
      <Link href={`/clients/${clientId}/week/${weekNumber + 1}`} className={cn(buttonVariants({ variant: "outline" }))}>
        Week {weekNumber + 1} check-in
      </Link>
      <Link href={`/clients/${clientId}`} className={cn(buttonVariants({ variant: "ghost" }))}>
        All weeks
      </Link>
      <a href={`/api/plans/${planId}/pdf`} className={cn(buttonVariants({ variant: "outline" }))}>
        Export PDF
      </a>
    </div>
  )
}
