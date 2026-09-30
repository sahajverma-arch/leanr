"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { recomputeRoadmap } from "@/app/(app)/sessions/[sessionId]/review/actions"
import { REGION_LABELS } from "@/lib/foods/vocab"

function regionLabel(region: string): string {
  return REGION_LABELS[region as keyof typeof REGION_LABELS] ?? region.replace(/_/g, " ")
}

export function ActionsBar({
  sessionId,
  roadmapId,
  hasUnresolvedBlock,
  availableRegions,
  suggestedRegion,
}: {
  sessionId: string
  roadmapId: string
  hasUnresolvedBlock: boolean
  /** Regions with real meal_templates rows — the only ones generation can succeed for. Computed from the DB, not hardcoded. */
  availableRegions: string[]
  /** Best-effort match from the client's counselling cuisine answer (q34) — a starting point the dietitian can override, never a hard requirement. */
  suggestedRegion?: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isGenerating, setIsGenerating] = useState(false)
  const initialRegion = suggestedRegion && availableRegions.includes(suggestedRegion) ? suggestedRegion : availableRegions[0]
  const [region, setRegion] = useState(initialRegion)
  const isUsingSuggestion = suggestedRegion !== undefined && region === suggestedRegion

  function handleRecompute() {
    startTransition(async () => {
      try {
        await recomputeRoadmap(sessionId)
        toast.success("Recomputed — new snapshot created")
      } catch (err) {
        // Caught here, not left to bubble to error.tsx — a Server Action
        // error caught client-side keeps its real message; one that
        // reaches the error boundary gets Next's generic production
        // message instead. A blocked clinical calculation (e.g. a missing
        // required answer) must show the actual RoadmapInputError text.
        toast.error(err instanceof Error ? err.message : "Recompute failed")
      }
    })
  }

  async function handleGenerate() {
    setIsGenerating(true)
    try {
      const res = await fetch("/api/plan/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roadmapId, weekNumber: 1, region }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? "Plan generation failed")
        return
      }
      toast.success(
        data.generationMode === "fixed_menu"
          ? "Week 1 plan generated from the fixed menu — the same food on all 7 days."
          : `Week 1 plan generated (${data.generationMode === "ai" ? "AI-selected" : "fallback rotation"}, ${data.attempts} attempt${data.attempts === 1 ? "" : "s"}).`
      )
      router.push(`/plans/${data.dietPlanId}`)
    } catch {
      toast.error("Plan generation failed — network or server error")
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4 print:hidden">
      <div className="flex flex-col gap-1">
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          disabled={hasUnresolvedBlock || isGenerating}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {availableRegions.map((r) => (
            <option key={r} value={r}>
              {regionLabel(r)}
            </option>
          ))}
        </select>
        {isUsingSuggestion && (
          <span className="text-xs text-muted-foreground">From counselling cuisine answer</span>
        )}
      </div>
      <Button onClick={handleGenerate} disabled={hasUnresolvedBlock || isGenerating}>
        {isGenerating ? "Generating…" : "Generate week 1 plan"}
      </Button>
      <Button variant="outline" onClick={handleRecompute} disabled={isPending}>
        {isPending ? "Recomputing…" : "Recompute"}
      </Button>
    </div>
  )
}
