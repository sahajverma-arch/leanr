"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { removePrescribedSupplement, savePrescribedSupplement } from "@/app/(app)/sessions/[sessionId]/review/actions"

export interface SupplementCardProps {
  roadmapId: string
  sessionId: string
  /** Currently prescribed, or null. */
  current: {
    name: string
    servingLabel: string
    servingsPerDay: number
    proteinGPerServing: number
    kcalPerServing: number
  } | null
  /** From the client's own counselling answers — an intolerance warns, an allergy blocks server-side. */
  restriction: "allergy" | "intolerance" | null
}

/**
 * Prescribing the protein supplement, at review time, before generation.
 *
 * The dietitian types what is on the tub. Saving reduces the protein and
 * calories the FOOD has to supply, and the targets table above updates on the
 * next render — so the split is visible before a plan is ever generated.
 */
export function SupplementCard({ roadmapId, sessionId, current, restriction }: SupplementCardProps) {
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState(current?.name ?? "Whey protein")
  const [servingLabel, setServingLabel] = useState(current?.servingLabel ?? "1 scoop")
  const [servingsPerDay, setServingsPerDay] = useState(String(current?.servingsPerDay ?? 1))
  const [proteinG, setProteinG] = useState(current ? String(current.proteinGPerServing) : "")
  const [kcal, setKcal] = useState(current ? String(current.kcalPerServing) : "")

  const blocked = restriction === "allergy"

  function handleSave() {
    startTransition(async () => {
      try {
        await savePrescribedSupplement({
          roadmapId,
          sessionId,
          name,
          servingLabel,
          servingsPerDay: Number(servingsPerDay),
          proteinGPerServing: Number(proteinG),
          kcalPerServing: Number(kcal),
        })
        toast.success("Supplement saved — the food targets below now exclude it.")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save the supplement")
      }
    })
  }

  function handleRemove() {
    startTransition(async () => {
      try {
        await removePrescribedSupplement(roadmapId, sessionId)
        toast.success("Supplement removed — the food targets are back to the full prescription.")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not remove the supplement")
      }
    })
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {blocked && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            This client is recorded as <strong>allergic to protein powder — never serve</strong>. A supplement cannot
            be prescribed. Correct the counselling answers if that is wrong.
          </p>
        )}
        {restriction === "intolerance" && (
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            This client reports an <strong>intolerance</strong> to protein powder. Prescribing one is your call — the
            plan will not refuse it.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="supp-name">Supplement</Label>
            <Input id="supp-name" value={name} onChange={(e) => setName(e.target.value)} disabled={blocked} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supp-serving">One serving is</Label>
            <Input
              id="supp-serving"
              value={servingLabel}
              onChange={(e) => setServingLabel(e.target.value)}
              placeholder="1 scoop"
              disabled={blocked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supp-per-day">Servings per day</Label>
            <Input
              id="supp-per-day"
              type="number"
              min="0.5"
              step="0.5"
              value={servingsPerDay}
              onChange={(e) => setServingsPerDay(e.target.value)}
              disabled={blocked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supp-protein">Protein per serving (g)</Label>
            <Input
              id="supp-protein"
              type="number"
              min="0"
              step="0.1"
              value={proteinG}
              onChange={(e) => setProteinG(e.target.value)}
              placeholder="24"
              disabled={blocked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="supp-kcal">Calories per serving (kcal)</Label>
            <Input
              id="supp-kcal"
              type="number"
              min="0"
              step="1"
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
              placeholder="120"
              disabled={blocked}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Take these from the tub&apos;s own label. Both figures are subtracted from what the food plan has to supply,
          so the client is not given a full day of food protein on top of the scoop.
        </p>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={isPending || blocked}>
            {isPending ? "Saving…" : current ? "Update supplement" : "Add supplement"}
          </Button>
          {current && (
            <Button variant="outline" onClick={handleRemove} disabled={isPending}>
              Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
