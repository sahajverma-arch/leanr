"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  deletePlanItem,
  getSwapCandidates,
  setPlanItemGrams,
  swapPlanItem,
  unlockPlanItemGrams,
  type SwapCandidate,
} from "@/app/(app)/plans/[id]/actions"
import { formatGrams, formatKcal } from "@/lib/format"
import { formatItemLabel } from "@/lib/plan/format-item"
import {
  describeQuantity,
  isCountable,
  macrosAtGrams,
  macroDelta,
  steppedGrams,
  type MacroImpact,
} from "@/lib/plan/recipe-quantity-step"
import type { PlanViewItem, RecipeItemEditing } from "@/lib/plan/plan-view-model"

import { IngredientPanel } from "./ingredient-panel"
import { RecipeCandidateList } from "./recipe-candidate-list"
import { SwapItemButton } from "./swap-item-button"

/**
 * One clickable item on a generated plan.
 *
 * Dispatches on `item.editing`, which only a recipe-engine item carries (see
 * recipe-view-adapter.ts): a recipe item opens the full edit dialog below -
 * change the quantity, swap the dish, or remove it - while an exchange-engine
 * item keeps the older swap-only dialog, whose "same exchange type, same
 * count" guarantee makes quantity editing meaningless there.
 */
export function PlanItemButton({ item, editable, label }: { item: PlanViewItem; editable: boolean; label?: string }) {
  if (!item.editing) return <SwapItemButton item={item} editable={editable} label={label} />
  return <RecipeItemEditDialog item={item} editing={item.editing} editable={editable} label={label} />
}

function MacroRow({ macros, className }: { macros: MacroImpact; className?: string }) {
  return (
    <span className={className}>
      {formatKcal(macros.kcal)} kcal · P {formatGrams(macros.proteinG)}g · C {formatGrams(macros.carbsG)}g · F{" "}
      {formatGrams(macros.fatG)}g · Fibre {formatGrams(macros.fiberG)}g
    </span>
  )
}

function signed(value: number): string {
  const rounded = Math.round(value)
  if (rounded === 0) return "0"
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`
}

/** The change itself, spelled out per macro — the thing a dietitian is actually deciding on. */
function DeltaRow({ delta }: { delta: MacroImpact }) {
  const nothing =
    Math.round(delta.kcal) === 0 && Math.round(delta.proteinG) === 0 && Math.round(delta.carbsG) === 0 && Math.round(delta.fatG) === 0
  if (nothing) return <span className="text-muted-foreground">No change</span>
  const tone = delta.kcal > 0 ? "text-amber-700" : "text-sky-700"
  return (
    <span className={tone}>
      {signed(delta.kcal)} kcal · P {signed(delta.proteinG)}g · C {signed(delta.carbsG)}g · F {signed(delta.fatG)}g ·
      Fibre {signed(delta.fiberG)}g
    </span>
  )
}

function RecipeItemEditDialog({
  item,
  editing,
  editable,
  label,
}: {
  item: PlanViewItem
  editing: RecipeItemEditing
  editable: boolean
  label?: string
}) {
  const currentGrams = item.servingRawG ?? 0
  const [open, setOpen] = useState(false)
  const [draftGrams, setDraftGrams] = useState(currentGrams)
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null)
  const [isPending, startTransition] = useTransition()

  const displayLabel = label ?? formatItemLabel(item)

  const currentMacros = useMemo(() => macrosAtGrams(editing.per100G, currentGrams), [editing.per100G, currentGrams])
  const draftMacros = useMemo(() => macrosAtGrams(editing.per100G, draftGrams), [editing.per100G, draftGrams])
  const draftDescription = useMemo(() => describeQuantity(editing, draftGrams), [editing, draftGrams])
  const countable = isCountable(editing)

  if (!editable) {
    return <span>{displayLabel}</span>
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) setDraftGrams(currentGrams)
  }

  /** Loaded lazily and only once: the eligible pool is a real query, and most dialog opens are quantity edits. */
  function loadCandidates() {
    if (candidates !== null) return
    startTransition(async () => {
      setCandidates(await getSwapCandidates(item.id))
    })
  }

  function run(action: () => Promise<void>, success: string) {
    startTransition(async () => {
      try {
        await action()
        toast.success(success)
        setOpen(false)
        setCandidates(null)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "That change could not be saved")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
            title={`${item.nameEn} — ${formatKcal(item.kcal)} kcal, P ${formatGrams(item.proteinG)}g, C ${formatGrams(item.carbsG)}g, F ${formatGrams(item.fatG)}g. Click to edit.`}
          />
        }
      >
        {displayLabel}
        {editing.gramsLocked && <span className="ml-0.5 text-[10px] align-super">set</span>}
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item.nameEn}</DialogTitle>
        </DialogHeader>

        {/* What this item is right now, in macros. The plan table only ever
            totalled a whole meal, so per-item figures were invisible — which
            is exactly what made deciding on a swap or a portion guesswork. */}
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{describeQuantity(editing, currentGrams).label}</p>
          <MacroRow macros={currentMacros} className="text-xs text-muted-foreground" />
          {editing.gramsLocked && (
            <p className="mt-2 text-xs text-emerald-700">
              This quantity was set by hand, so the day is balanced <em>around</em> it rather than changing it.
            </p>
          )}
        </div>

        <Tabs defaultValue="quantity">
          <TabsList>
            <TabsTrigger value="quantity">Quantity</TabsTrigger>
            <TabsTrigger value="ingredients">Ingredients</TabsTrigger>
            <TabsTrigger value="swap" onClick={loadCandidates}>
              Swap
            </TabsTrigger>
            <TabsTrigger value="remove">Remove</TabsTrigger>
          </TabsList>

          <TabsContent value="ingredients">
            <IngredientPanel itemId={item.id} editable={editable} />
          </TabsContent>

          <TabsContent value="quantity" className="space-y-3 pt-3">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => setDraftGrams(steppedGrams(editing, draftGrams, -1))}
                aria-label="Decrease quantity"
              >
                −
              </Button>
              <div className="min-w-40 text-center">
                <p className="text-lg font-semibold">{draftDescription.label}</p>
                <p className="text-xs text-muted-foreground">
                  {countable
                    ? `One ${editing.unitLabel} is ${Math.round(editing.perUnitGrams ?? 0)} g`
                    : "Steps of 25 g"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() => setDraftGrams(steppedGrams(editing, draftGrams, 1))}
                aria-label="Increase quantity"
              >
                +
              </Button>
            </div>

            <div className="space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Becomes: </span>
                <MacroRow macros={draftMacros} />
              </p>
              <p>
                <span className="text-muted-foreground">Change: </span>
                <DeltaRow delta={macroDelta(currentMacros, draftMacros)} />
              </p>
            </div>

            {draftDescription.outsideRangeNote && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
                {draftDescription.outsideRangeNote} Allowed — it is your call, not the data&apos;s.
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              Saving pins this quantity. The rest of the day is re-optimised around it, so the other dishes move
              instead of this one.
            </p>

            <div className="flex gap-2">
              <Button
                disabled={isPending || Math.round(draftGrams) === Math.round(currentGrams)}
                onClick={() => run(() => setPlanItemGrams(item.id, draftGrams), "Quantity set — the rest of the day was re-balanced around it.")}
              >
                {isPending ? "Saving…" : "Set quantity"}
              </Button>
              {editing.gramsLocked && (
                <Button
                  variant="outline"
                  disabled={isPending}
                  onClick={() => run(() => unlockPlanItemGrams(item.id), "Handed back to the solver — this item can move again.")}
                >
                  Let the plan decide
                </Button>
              )}
            </div>
          </TabsContent>

          <TabsContent value="swap" className="pt-3">
            <RecipeCandidateList
              candidates={candidates}
              disabled={isPending}
              onPick={(recipeId) =>
                run(() => swapPlanItem(item.id, recipeId), "Swapped — quantities recomputed. Check the macros above.")
              }
              emptyMessage="No other eligible dishes for this client."
            />
          </TabsContent>

          <TabsContent value="remove" className="space-y-3 pt-3">
            <p className="text-sm">
              Removing this takes <MacroRow macros={currentMacros} /> out of the day. The remaining dishes are
              re-optimised to cover as much of it as their serving ranges allow.
            </p>
            <p className="text-xs text-muted-foreground">
              If it was the only thing in the meal, the slot is left empty and the plan will say so at the top of the
              page.
            </p>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() => run(() => deletePlanItem(item.id), "Removed — the day was re-balanced.")}
            >
              {isPending ? "Removing…" : `Remove ${item.nameEn}`}
            </Button>
          </TabsContent>
        </Tabs>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}
