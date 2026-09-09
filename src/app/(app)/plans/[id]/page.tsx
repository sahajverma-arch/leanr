import { notFound } from "next/navigation"

import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ComposedMealCell } from "@/components/plan/composed-meal-cell"
import { MacroDonut } from "@/components/plan/macro-donut"
import { PlanActionsBar } from "@/components/plan/plan-actions-bar"
import { formatBmi, formatGrams, formatKcal, formatWeight } from "@/lib/format"
import { ACCEPTANCE_FRACTION } from "@/lib/plan/exchange-solver"
import { PlanNotFoundError, planDateRangeLabel, loadPlanViewModel } from "@/lib/plan/plan-view-model"

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  let model
  try {
    model = await loadPlanViewModel(id)
  } catch (err) {
    if (err instanceof PlanNotFoundError) notFound()
    throw err
  }

  const {
    plan,
    client,
    roadmap,
    targets,
    deviationPct,
    warnings,
    days,
    weeklySummary,
    weeklyAvg,
    guidelines,
    foodsToAvoid,
    narrative,
    dishCombinations,
    vegetableDishCombinations,
    vegetableDishCombinationMembers,
  } = model

  const withinTolerance =
    Math.abs(deviationPct.kcal) < ACCEPTANCE_FRACTION * 100 &&
    Math.abs(deviationPct.proteinG) < ACCEPTANCE_FRACTION * 100 &&
    Math.abs(deviationPct.fatG) < ACCEPTANCE_FRACTION * 100 &&
    Math.abs(deviationPct.carbsG) < ACCEPTANCE_FRACTION * 100

  const editable = plan.status === "draft"
  const avgDay = weeklyAvg

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16 print:max-w-full">
      {/* Generation warnings. The recipe engine's best-of-N path saves its
          nearest week rather than rejecting it, so the dietitian is the one
          who decides whether it is usable — which only works if they can see
          what is off. Rendered before anything else, and kept in print. */}
      {warnings.length > 0 && (
        <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Needs your review before approving</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {warnings.map((w, i) => (
              <li key={i} className="leading-snug">
                • {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Header */}
      <div className="rounded-xl bg-neutral-950 p-6 text-white">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{client.name} — Weekly Diet Plan</h1>
            <p className="mt-1 text-sm text-neutral-300">
              Week {plan.weekNumber} · {planDateRangeLabel(plan)} · Prepared by {plan.preparedByName ?? "—"}
            </p>
            <p className="mt-1 text-sm text-neutral-300">
              Diet: {plan.dietType} | Region: {plan.region.replace(/_/g, " ")}
            </p>
            <p className="mt-1 text-sm text-neutral-300">
              Goal: {roadmap.categoryLabel} | {formatWeight(roadmap.weightKg)} kg · BMI {formatBmi(roadmap.bmiValue)} ·
              TDEE {formatKcal(roadmap.tdee)} kcal
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="font-serif text-2xl font-black italic tracking-tight text-yellow-400">LEANR</p>
            <p className="-mt-1 text-xs text-neutral-400">by Fitelo</p>
          </div>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Avg Daily Calories" value={`${formatKcal(avgDay.kcal)} kcal`} />
        <StatTile label="Avg Protein" value={`${formatGrams(avgDay.proteinG)} g`} />
        <StatTile label="Avg Carbohydrates" value={`${formatGrams(avgDay.carbsG)} g`} />
        <StatTile label="Avg Fat" value={`${formatGrams(avgDay.fatG)} g`} />
      </div>

      {/* Donut + deviation line */}
      <Card>
        <CardContent className="flex flex-col items-center gap-4 pt-6 sm:flex-row">
          <MacroDonut proteinG={avgDay.proteinG} carbsG={avgDay.carbsG} fatG={avgDay.fatG} />
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-3">
              <LegendDot color="#facc15" label="Protein" />
              <LegendDot color="#38bdf8" label="Carbohydrates" />
              <LegendDot color="#f97316" label="Fat" />
            </div>
            <p className={withinTolerance ? "text-muted-foreground" : "font-medium text-destructive"}>
              Roadmap target {formatKcal(targets.kcal)} kcal · P {formatGrams(targets.proteinG)}g · C{" "}
              {formatGrams(targets.carbsG)}g · F {formatGrams(targets.fatG)}g — plan deviates by{" "}
              {Math.max(Math.abs(deviationPct.kcal), Math.abs(deviationPct.proteinG), Math.abs(deviationPct.fatG), Math.abs(deviationPct.carbsG)).toFixed(2)}
              % on the worst macro.
            </p>
            <p className="text-xs text-muted-foreground">
              All values computed from Table 4.1, Comprehensive Food Exchange List (Indian modified American exchange
              list).
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Narrative */}
      <p className="text-sm text-muted-foreground">{narrative}</p>

      {/* Per-day tables */}
      {days.map((day) => (
        <Card key={day.dayIndex} className="overflow-hidden py-0">
          <div className="flex items-center justify-between bg-neutral-950 px-4 py-2 text-sm font-medium text-white">
            <span>{day.dateLabel}</span>
            <span>
              {formatKcal(day.totals.kcal)} kcal | P {formatGrams(day.totals.proteinG)}g | C{" "}
              {formatGrams(day.totals.carbsG)}g | F {formatGrams(day.totals.fatG)}g
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Meal</TableHead>
                <TableHead className="whitespace-normal">Foods</TableHead>
                <TableHead className="text-right">Calories</TableHead>
                <TableHead className="text-right">Protein</TableHead>
                <TableHead className="text-right">Carbs</TableHead>
                <TableHead className="text-right">Fat</TableHead>
                <TableHead className="text-right">Cal%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {day.meals.map((meal) => (
                <TableRow key={meal.slot}>
                  <TableCell className="align-top">{meal.timeLabel}</TableCell>
                  <TableCell className="align-top font-medium">{meal.slotLabel}</TableCell>
                  <TableCell className="whitespace-normal align-top">
                    <ComposedMealCell
                      items={meal.items}
                      region={plan.region}
                      editable={editable}
                      archetypeName={meal.archetypeName}
                      archetypeDishFamilyIdsByExchangeType={meal.archetypeDishFamilyIdsByExchangeType}
                      dishCombinations={dishCombinations}
                      vegetableDishCombinations={vegetableDishCombinations}
                      vegetableDishCombinationMembers={vegetableDishCombinationMembers}
                      rotationDay={day.dayIndex + (plan.weekNumber - 1) * 7}
                    />
                  </TableCell>
                  <TableCell className="text-right align-top">{formatKcal(meal.totals.kcal)}</TableCell>
                  <TableCell className="text-right align-top">{formatGrams(meal.totals.proteinG)}g</TableCell>
                  <TableCell className="text-right align-top">{formatGrams(meal.totals.carbsG)}g</TableCell>
                  <TableCell className="text-right align-top">{formatGrams(meal.totals.fatG)}g</TableCell>
                  <TableCell className="text-right align-top">{Math.round(meal.calPercent)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3} className="font-medium">
                  Daily Total
                </TableCell>
                <TableCell className="text-right font-medium">{formatKcal(day.totals.kcal)}</TableCell>
                <TableCell className="text-right font-medium">{formatGrams(day.totals.proteinG)}g</TableCell>
                <TableCell className="text-right font-medium">{formatGrams(day.totals.carbsG)}g</TableCell>
                <TableCell className="text-right font-medium">{formatGrams(day.totals.fatG)}g</TableCell>
                <TableCell className="text-right font-medium">100%</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </Card>
      ))}

      {/* Weekly summary */}
      <Card className="overflow-hidden py-0">
        <div className="bg-neutral-950 px-4 py-2 text-sm font-medium text-white">Weekly Summary</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Calories</TableHead>
              <TableHead className="text-right">Protein (g)</TableHead>
              <TableHead className="text-right">Carbs (g)</TableHead>
              <TableHead className="text-right">Fat (g)</TableHead>
              <TableHead className="text-right">P%</TableHead>
              <TableHead className="text-right">C%</TableHead>
              <TableHead className="text-right">F%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {weeklySummary.map((row) => (
              <TableRow key={row.label}>
                <TableCell>{row.label}</TableCell>
                <TableCell className="text-right">{formatKcal(row.kcal)}</TableCell>
                <TableCell className="text-right">{formatGrams(row.proteinG)}</TableCell>
                <TableCell className="text-right">{formatGrams(row.carbsG)}</TableCell>
                <TableCell className="text-right">{formatGrams(row.fatG)}</TableCell>
                <TableCell className="text-right">{Math.round(row.proteinPct)}%</TableCell>
                <TableCell className="text-right">{Math.round(row.carbsPct)}%</TableCell>
                <TableCell className="text-right">{Math.round(row.fatPct)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">{weeklyAvg.label}</TableCell>
              <TableCell className="text-right font-medium">{formatKcal(weeklyAvg.kcal)}</TableCell>
              <TableCell className="text-right font-medium">{formatGrams(weeklyAvg.proteinG)}</TableCell>
              <TableCell className="text-right font-medium">{formatGrams(weeklyAvg.carbsG)}</TableCell>
              <TableCell className="text-right font-medium">{formatGrams(weeklyAvg.fatG)}</TableCell>
              <TableCell className="text-right font-medium">{Math.round(weeklyAvg.proteinPct)}%</TableCell>
              <TableCell className="text-right font-medium">{Math.round(weeklyAvg.carbsPct)}%</TableCell>
              <TableCell className="text-right font-medium">{Math.round(weeklyAvg.fatPct)}%</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Card>

      {/* Guidelines */}
      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="font-serif text-lg font-semibold">Guidelines</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            {guidelines.map((g, i) => (
              <li key={i}>
                {g.lead && <span className="font-medium">{g.lead} </span>}
                {g.text}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Foods to avoid */}
      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="font-serif text-lg font-semibold">Foods to Avoid</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {foodsToAvoid.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <PlanActionsBar
        planId={plan.id}
        roadmapId={roadmap.id}
        weekNumber={plan.weekNumber}
        region={plan.region}
        status={plan.status}
        withinTolerance={withinTolerance}
      />

      {/* Footer */}
      <div className="space-y-1 border-t pt-4 text-center text-xs text-muted-foreground">
        <p>
          Generated by LEANR Diet Platform | Diet Preference: {plan.dietType} | Goal: {roadmap.categoryLabel} |
          Prepared by {plan.preparedByName ?? "—"}
        </p>
        <p>
          Created with AI assistance and reviewed by your dietitian. Not a substitute for medical advice — consult
          your doctor before major dietary changes.
        </p>
      </div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
