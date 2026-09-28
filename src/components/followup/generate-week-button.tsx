"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

/**
 * Generates week N from the weekly check-in page. The route itself refuses
 * week 2+ without a submitted check-in, so `disabled` here is a courtesy,
 * not the gate.
 */
export function GenerateWeekButton({
  roadmapId,
  weekNumber,
  region,
  disabled,
  label,
}: {
  roadmapId: string
  weekNumber: number
  /** Template region, or — for a recipe plan — the previous week's cuisine. */
  region: string
  disabled: boolean
  label?: string
}) {
  const router = useRouter()
  const [isGenerating, setIsGenerating] = useState(false)

  async function handleGenerate() {
    setIsGenerating(true)
    try {
      const res = await fetch("/api/plan/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roadmapId, weekNumber, region }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? `Could not generate week ${weekNumber}`)
        return
      }
      toast.success(`Week ${weekNumber} plan generated.`)
      router.push(`/plans/${data.dietPlanId}`)
    } catch {
      toast.error(`Could not generate week ${weekNumber} — network or server error`)
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <Button onClick={handleGenerate} disabled={disabled || isGenerating}>
      {isGenerating ? "Generating…" : (label ?? `Generate week ${weekNumber}`)}
    </Button>
  )
}
