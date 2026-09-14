"use client"

import { useMemo, useState } from "react"

import { Input } from "@/components/ui/input"
import type { SwapCandidate } from "@/app/(app)/plans/[id]/actions"
import { formatGrams, formatKcal } from "@/lib/format"
import { MACRO_PROFILE_FILTERS, matchesAnyTag, type MacroProfileTag } from "@/lib/plan/recipe-macro-profile"

/**
 * The dish picker, shared by "swap this dish" and "add a dish to this meal".
 *
 * One component for both because they are the same problem: a real eligible
 * pool is around a thousand dishes, so a bare alphabetical list is not a way
 * to find anything. Search by name, narrow by macro profile, and every row
 * shows what the dish actually costs at its own typical portion — the filter
 * and the number it filtered on are never more than a line apart.
 *
 * Filtering is purely presentational. It narrows what is OFFERED; it never
 * changes what is eligible, which is decided server-side and re-checked on
 * the write (recipe-plan-edit.ts).
 */
export function RecipeCandidateList({
  candidates,
  disabled,
  onPick,
  emptyMessage,
}: {
  /** Null while loading. */
  candidates: SwapCandidate[] | null
  disabled: boolean
  onPick: (recipeId: string) => void
  /** Shown when the server returned nothing at all, as opposed to the filters matching nothing. */
  emptyMessage: string
}) {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<MacroProfileTag[]>([])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (candidates ?? []).filter(
        (c) => c.nameEn.toLowerCase().includes(needle) && matchesAnyTag(c.macroTags ?? [], selected)
      ),
    [candidates, needle, selected]
  )

  function toggle(tag: MacroProfileTag) {
    setSelected((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  const loading = candidates === null

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search dishes…"
        disabled={loading}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {MACRO_PROFILE_FILTERS.map((f) => {
          const on = selected.includes(f.tag)
          // The count is of what is actually available to this client right
          // now, not of the whole catalogue — a chip promising 101 dishes and
          // then showing 6 would be worse than no count at all.
          const count = (candidates ?? []).filter((c) => (c.macroTags ?? []).includes(f.tag)).length
          return (
            <button
              key={f.tag}
              type="button"
              disabled={loading}
              onClick={() => toggle(f.tag)}
              title={f.description}
              aria-pressed={on}
              className={
                "rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 " +
                (on
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-muted")
              }
            >
              {f.label}
              {!loading && <span className="ml-1 opacity-70">{count}</span>}
            </button>
          )
        })}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected([])}
            className="px-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-2"
          >
            clear
          </button>
        )}
      </div>

      <div className="max-h-72 space-y-1 overflow-y-auto">
        {loading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading eligible dishes…</p>
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {candidates.length === 0 ? emptyMessage : "Nothing matches that search and filter."}
          </p>
        ) : (
          shown.slice(0, MAX_ROWS).map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(c.id)}
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

      {!loading && shown.length > MAX_ROWS && (
        <p className="text-xs text-muted-foreground">
          Showing the first {MAX_ROWS} of {shown.length} — search or filter to narrow it down.
        </p>
      )}
    </div>
  )
}

/** The list is scrolled, not paged; this only stops a thousand DOM nodes being built at once. */
const MAX_ROWS = 200
