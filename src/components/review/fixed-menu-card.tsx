"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { RecipeCandidateList } from "@/components/plan/recipe-candidate-list"
import { getFixedMenuCandidates, saveFixedMenu } from "@/app/(app)/sessions/[sessionId]/review/actions"
import { FIXED_MENU_SLOTS, fixedMenuProblems, type FixedMenuSlot } from "@/lib/plan/fixed-menu"
import type { SwapCandidate } from "@/lib/plan/recipe-candidate"
import { formatGrams, formatKcal } from "@/lib/format"

export interface FixedMenuCardItem {
  slot: FixedMenuSlot
  recipeId: string
  name: string
  /** The dietitian's exact quantity, or null for "the plan decides". */
  grams: number | null
}

export interface FixedMenuPreview {
  /** Planned grams per `${slot}:${recipeId}`, from the same balancer generation uses. */
  plannedGrams: Record<string, number>
  totals: { kcal: number; proteinG: number; carbsG: number; fatG: number }
  target: { kcal: number; proteinG: number; carbsG: number; fatG: number }
  warnings: string[]
}

/**
 * "Same food on all days" — the dietitian chooses exactly what the client eats
 * at each meal, and generation repeats that one day on all 7 days. See
 * src/lib/plan/fixed-menu.ts.
 *
 * The preview is computed server-side from the SAVED menu, so it only
 * appears once the menu is saved and matches what generation will produce.
 */
export function FixedMenuCard({
  sessionId,
  enabled: savedEnabled,
  items: savedItems,
  preview,
}: {
  sessionId: string
  enabled: boolean
  items: FixedMenuCardItem[]
  preview: FixedMenuPreview | null
}) {
  const [enabled, setEnabled] = useState(savedEnabled)
  const [items, setItems] = useState<FixedMenuCardItem[]>(savedItems)
  const [gramsText, setGramsText] = useState<Record<string, string>>(() =>
    Object.fromEntries(savedItems.map((i) => [key(i), i.grams === null ? "" : String(i.grams)]))
  )
  const [addingSlot, setAddingSlot] = useState<FixedMenuSlot | null>(null)
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null)
  const [isPending, startTransition] = useTransition()

  const withGrams = items.map((i) => ({ ...i, grams: parseGrams(gramsText[key(i)]) }))
  const dirty =
    enabled !== savedEnabled ||
    JSON.stringify(withGrams.map(strip)) !== JSON.stringify(savedItems.map(strip))
  const problems = enabled ? fixedMenuProblems(withGrams) : []

  function openAdd(slot: FixedMenuSlot) {
    setAddingSlot(slot)
    if (candidates === null) {
      startTransition(async () => {
        try {
          setCandidates(await getFixedMenuCandidates(sessionId))
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not load dishes")
          setAddingSlot(null)
        }
      })
    }
  }

  function handlePick(recipeId: string) {
    if (!addingSlot) return
    const candidate = candidates?.find((c) => c.id === recipeId)
    if (!candidate) return
    if (items.some((i) => i.slot === addingSlot && i.recipeId === recipeId)) {
      toast.error(`${candidate.nameEn} is already in this meal.`)
      return
    }
    setItems((prev) => [...prev, { slot: addingSlot, recipeId, name: candidate.nameEn, grams: null }])
    setAddingSlot(null)
  }

  function remove(item: FixedMenuCardItem) {
    setItems((prev) => prev.filter((i) => key(i) !== key(item)))
  }

  function handleSave() {
    startTransition(async () => {
      const result = await saveFixedMenu({
        sessionId,
        enabled,
        items: withGrams.map(({ slot, recipeId, grams }) => ({ slot, recipeId, grams })),
      })
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      toast.success(
        enabled
          ? "Fixed menu saved — generating a plan will repeat this day on all 7 days."
          : "Saved — this client gets a varied plan. The dishes below are kept if you switch back."
      )
    })
  }

  const addingLabel = FIXED_MENU_SLOTS.find((s) => s.slot === addingSlot)?.label

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <fieldset className="space-y-2">
          <legend className="sr-only">Meal routine</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="meal-routine" className="mt-1" checked={!enabled} onChange={() => setEnabled(false)} />
            <span>
              <span className="font-medium">Regular client</span>
              <span className="block text-muted-foreground">The plan varies from day to day.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="meal-routine" className="mt-1" checked={enabled} onChange={() => setEnabled(true)} />
            <span>
              <span className="font-medium">Same food on all days</span>
              <span className="block text-muted-foreground">
                You choose exactly what the client eats at each meal. The same day is repeated on all 7 days.
              </span>
            </span>
          </label>
        </fieldset>

        {enabled && (
          <div className="space-y-3">
            {FIXED_MENU_SLOTS.map(({ slot, label, required }) => {
              const inSlot = items.filter((i) => i.slot === slot)
              return (
                <div key={slot} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">
                      {label}
                      {required ? <span className="text-destructive"> *</span> : <span className="font-normal text-muted-foreground"> (optional)</span>}
                    </h3>
                    <Button type="button" variant="outline" size="sm" onClick={() => openAdd(slot)} disabled={isPending}>
                      + Add dish
                    </Button>
                  </div>
                  {inSlot.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{required ? "Add at least one dish." : "Nothing — this meal is left out."}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {inSlot.map((item) => {
                        const k = key(item)
                        const planned = !dirty ? preview?.plannedGrams[k] : undefined
                        return (
                          <li key={k} className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="min-w-0 flex-1">{item.name}</span>
                            <Input
                              type="number"
                              min="5"
                              max="1000"
                              step="5"
                              inputMode="numeric"
                              className="h-8 w-24"
                              placeholder="auto"
                              aria-label={`Exact grams of ${item.name} (leave empty to let the plan decide)`}
                              value={gramsText[k] ?? ""}
                              onChange={(e) => setGramsText((prev) => ({ ...prev, [k]: e.target.value }))}
                            />
                            <span className="w-24 text-xs text-muted-foreground tabular-nums">
                              {planned !== undefined ? `${formatGrams(planned)} g ${parseGrams(gramsText[k]) === null ? "planned" : "fixed"}` : "g"}
                            </span>
                            <button
                              type="button"
                              onClick={() => remove(item)}
                              className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-destructive"
                            >
                              remove
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}

            <p className="text-xs text-muted-foreground">
              Leave a quantity empty and the plan sets it to meet the client&apos;s target. A quantity you type is kept
              exactly, and everything else is adjusted around it.
            </p>

            {preview && !dirty && <PreviewSummary preview={preview} />}
            {dirty && items.length > 0 && (
              <p className="text-xs text-muted-foreground">Save to see the planned quantities and the day&apos;s macros.</p>
            )}
          </div>
        )}

        {problems.length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            {problems.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={handleSave} disabled={isPending || !dirty || problems.length > 0}>
            {isPending ? "Saving…" : "Save meal routine"}
          </Button>
          {!dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
        </div>

        <Dialog open={addingSlot !== null} onOpenChange={(open) => !open && setAddingSlot(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add a dish to {addingLabel}</DialogTitle>
            </DialogHeader>
            <RecipeCandidateList
              candidates={candidates}
              disabled={isPending}
              onPick={handlePick}
              emptyMessage="No dishes are eligible for this client."
            />
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

function PreviewSummary({ preview }: { preview: FixedMenuPreview }) {
  const rows = [
    { label: "kcal", got: preview.totals.kcal, want: preview.target.kcal, unit: "" },
    { label: "Protein", got: preview.totals.proteinG, want: preview.target.proteinG, unit: " g" },
    { label: "Carbs", got: preview.totals.carbsG, want: preview.target.carbsG, unit: " g" },
    { label: "Fat", got: preview.totals.fatG, want: preview.target.fatG, unit: " g" },
  ]
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Each day gives (week 1 target)</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
        {rows.map((r) => {
          const pct = r.want > 0 ? ((r.got - r.want) / r.want) * 100 : 0
          return (
            <div key={r.label}>
              <span className="text-muted-foreground">{r.label} </span>
              {r.label === "kcal" ? formatKcal(r.got) : formatGrams(r.got)}
              {r.unit}
              <span className="text-muted-foreground">
                {" "}
                of {r.label === "kcal" ? formatKcal(r.want) : formatGrams(r.want)}
                {r.unit}
              </span>
              <span className={Math.abs(pct) > 8 ? " text-amber-700 dark:text-amber-400" : " text-muted-foreground"}>
                {" "}
                ({pct >= 0 ? "+" : ""}
                {pct.toFixed(0)}%)
              </span>
            </div>
          )
        })}
      </div>
      {preview.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
          {preview.warnings.map((w) => (
            <li key={w}>• {w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function key(i: { slot: string; recipeId: string }): string {
  return `${i.slot}:${i.recipeId}`
}

function strip(i: { slot: string; recipeId: string; grams: number | null }) {
  return { slot: i.slot, recipeId: i.recipeId, grams: i.grams }
}

/** Empty or unparseable = "the plan decides". */
function parseGrams(text: string | undefined): number | null {
  if (!text || text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}
