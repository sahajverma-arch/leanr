"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  getPlanItemIngredients,
  resetPlanItemIngredients,
  setPlanItemIngredientQuantity,
} from "@/app/(app)/plans/[id]/actions"
import { formatGrams, formatKcal } from "@/lib/format"
import type { PlanItemIngredientRow, PlanItemIngredientState } from "@/lib/plan/plan-item-ingredients"

/**
 * The ingredient breakdown of one plan item, with a stepper per ingredient.
 *
 * The tab is always offered; a recipe outside the ingredient trial reports
 * `available: false` and this panel says so rather than listing anything. That
 * covers 259 of the 1222 recipes, and saying nothing is better than showing a
 * breakdown that does not add up to the dish above it.
 *
 * Amounts are what is on THIS plate. A dish plated at three portions lists
 * three portions' worth of every ingredient, because that is what the client
 * is being asked to eat.
 *
 * A counted ingredient (egg, roti) steps in whole units, because "one more
 * egg" is the real instruction. Everything else steps in 5 g, the same coarse
 * nudge the gram stepper already uses for a curry.
 */
export function IngredientPanel({ itemId, editable }: { itemId: string; editable: boolean }) {
  const [state, setState] = useState<PlanItemIngredientState | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    getPlanItemIngredients(itemId)
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  function apply(row: PlanItemIngredientRow, next: number) {
    if (next < 0) return
    startTransition(async () => {
      try {
        await setPlanItemIngredientQuantity(itemId, row.ingredientId, next)
        setState(await getPlanItemIngredients(itemId))
        toast.success(`${row.name} updated — the day was re-balanced around it`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That change could not be saved")
      }
    })
  }

  function reset() {
    startTransition(async () => {
      try {
        await resetPlanItemIngredients(itemId)
        setState(await getPlanItemIngredients(itemId))
        toast.success("Ingredients returned to the dish as generated")
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That change could not be saved")
      }
    })
  }

  if (!state) return <p className="pt-3 text-sm text-muted-foreground">Loading ingredients…</p>
  if (!state.available) {
    return (
      <p className="pt-3 text-sm text-muted-foreground">
        This dish has no verified ingredient breakdown, so its ingredients cannot be edited.
      </p>
    )
  }

  const anyEdited = state.rows.some((r) => r.edited)

  return (
    <div className="space-y-3 pt-3">
      <p className="text-xs text-muted-foreground">
        As plated, {formatGrams(state.portionGrams)} g. Changing an ingredient changes only that
        ingredient — the rest of the dish stays as it is, and the whole day is re-balanced.
      </p>

      {state.gramsLocked && (
        <p className="text-xs text-amber-700">
          This dish&apos;s weight is pinned at {formatGrams(state.portionGrams)} g, so it stays put —
          an edit here changes what is in those grams, not how much is served.
        </p>
      )}

      <ul className="divide-y rounded-md border">
        {state.rows.map((row) => {
          const countable = row.kind !== "direct"
          const step = countable ? 1 : 5
          const shown = countable
            ? `${row.quantity.toFixed(row.quantity % 1 === 0 ? 0 : 2)} ${row.unit ?? ""}`.trim()
            : `${formatGrams(row.grams)} g`
          return (
            <li key={row.ingredientId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium capitalize">
                  {row.name}
                  {row.edited && (
                    <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] font-normal text-amber-800">
                      changed
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatGrams(row.grams)} g · {formatKcal(row.kcal)} kcal · P{" "}
                  {formatGrams(row.proteinG)}g · C {formatGrams(row.carbsG)}g · F{" "}
                  {formatGrams(row.fatG)}g
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!editable || isPending || row.quantity <= 0}
                  onClick={() => apply(row, Math.max(0, roundStep(row.quantity - step, step, countable)))}
                  aria-label={`Less ${row.name}`}
                >
                  −
                </Button>
                <span className="min-w-16 text-center text-sm tabular-nums">{shown}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!editable || isPending}
                  onClick={() => apply(row, roundStep(row.quantity + step, step, countable))}
                  aria-label={`More ${row.name}`}
                >
                  +
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      {anyEdited && (
        <Button variant="ghost" size="sm" disabled={!editable || isPending} onClick={reset}>
          Reset to the dish as generated
        </Button>
      )}
    </div>
  )
}

/**
 * Snaps to the step grid on the way.
 *
 * Generation leaves a counted ingredient on a fractional amount (1.33 eggs in
 * a dish that serves 1.5), so a bare +1 would give 2.33. Pressing "+" on 1.33
 * eggs means two eggs, so the first press lands on the grid — the same snap
 * the gram stepper already makes against its 5 g grid.
 */
function roundStep(value: number, step: number, countable: boolean): number {
  const snapped = countable ? Math.round(value) : Math.round(value / step) * step
  return Math.max(0, Number(snapped.toFixed(2)))
}
