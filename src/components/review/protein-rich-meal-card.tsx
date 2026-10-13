"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { saveProteinRichMeal } from "@/app/(app)/sessions/[sessionId]/review/actions"
import { MAIN_MEAL_SLOTS, mainMealLabel, PROTEIN_RICH_SHARE, type MainMealSlot } from "@/lib/plan/recipe-meal-balance"

/**
 * The dietitian picks which main meal is protein-rich, or none. Generation
 * then puts the day's most protein-dense dish there and gives that meal the
 * most protein of breakfast, lunch and dinner (recipe-meal-balance.ts).
 * Takes effect on the next Generate; an existing plan is not changed.
 */
export function ProteinRichMealCard({ sessionId, current }: { sessionId: string; current: MainMealSlot | null }) {
  const [selected, setSelected] = useState<MainMealSlot | null>(current)
  const [isPending, startTransition] = useTransition()

  function choose(slot: MainMealSlot | null) {
    if (slot === selected) return
    const previous = selected
    setSelected(slot)
    startTransition(async () => {
      try {
        const result = await saveProteinRichMeal({ sessionId, slot })
        if ("error" in result) {
          setSelected(previous)
          toast.error(result.error)
          return
        }
        toast.success(slot ? `${mainMealLabel(slot)} will be the protein-rich meal from the next Generate.` : "No meal is protein-rich now.")
      } catch (err) {
        setSelected(previous)
        toast.error(err instanceof Error ? err.message : "Could not save the protein-rich meal")
      }
    })
  }

  const options: { slot: MainMealSlot | null; label: string }[] = [
    { slot: null, label: "No preference" },
    ...MAIN_MEAL_SLOTS.map((slot) => ({ slot, label: mainMealLabel(slot) })),
  ]

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm text-muted-foreground">
          Breakfast, lunch and dinner are planned with equal calories. Pick one of them to carry the most protein — the
          plan puts the day&apos;s most protein-dense dish there (paneer, soya, egg, chicken, rajma, sprouts…), aiming for
          at least {Math.round(PROTEIN_RICH_SHARE * 100)}% of the day&apos;s protein.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Protein-rich meal">
          {options.map(({ slot, label }) => (
            <Button
              key={label}
              type="button"
              role="radio"
              aria-checked={selected === slot}
              variant={selected === slot ? "default" : "outline"}
              size="sm"
              disabled={isPending}
              onClick={() => choose(slot)}
            >
              {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Applies from the next Generate, and to every later week until changed.</p>
      </CardContent>
    </Card>
  )
}
