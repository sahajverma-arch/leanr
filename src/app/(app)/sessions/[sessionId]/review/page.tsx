import { desc, eq } from "drizzle-orm"
import { notFound } from "next/navigation"
import Link from "next/link"

import { db } from "@/db"
import { clients, counsellingSessions, mealTemplates, roadmapOverrides, roadmapSupplements, roadmaps } from "@/db/schema"
import { proteinPowderRestriction, regionFromAnswers } from "@/lib/plan/client-profile-from-answers"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { CalcCard } from "@/components/review/calc-card"
import { PhaseTable } from "@/components/review/phase-table"
import { ProteinRampTable } from "@/components/review/protein-ramp-table"
import { FlagsPanel } from "@/components/review/flags-panel"
import { ActionsBar } from "@/components/review/actions-bar"
import { OverrideDialog } from "@/components/review/override-dialog"
import { SupplementCard } from "@/components/review/supplement-card"
import type { Answers } from "@/lib/counselling/questions"
import type { RoadmapInput, RoadmapResult } from "@/lib/counselling/roadmap"
import { weekTargets } from "@/lib/counselling/roadmap"
import { describeSupplement, foodTargetsAfterSupplement, type PrescribedSupplement } from "@/lib/counselling/supplement-adjusted-targets"
import { formatBmi, formatDivisor, formatGrams, formatKcal, formatWeight } from "@/lib/format"

const CATEGORY_LABEL: Record<string, string> = {
  first_timer: "First-timer",
  plateaued: "Plateaued",
  re_starter: "Re-starter",
  maintenance: "Maintenance",
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params

  const [row] = await db
    .select({ session: counsellingSessions, client: clients })
    .from(counsellingSessions)
    .innerJoin(clients, eq(counsellingSessions.clientId, clients.id))
    .where(eq(counsellingSessions.id, sessionId))
    .limit(1)
  if (!row) notFound()
  const { session, client } = row

  const [roadmapRow] = await db
    .select()
    .from(roadmaps)
    .where(eq(roadmaps.sessionId, sessionId))
    .orderBy(desc(roadmaps.createdAt))
    .limit(1)

  if (!roadmapRow) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          No roadmap snapshot exists for this session yet.{" "}
          <Link href={`/sessions/${sessionId}`} className="underline">
            Back to session status
          </Link>
        </div>
      </div>
    )
  }

  const input = roadmapRow.input as RoadmapInput
  const output = roadmapRow.output as RoadmapResult
  const answers = session.answers as Answers

  const overrides = await db
    .select()
    .from(roadmapOverrides)
    .where(eq(roadmapOverrides.roadmapId, roadmapRow.id))
  const overriddenCodes = new Set(overrides.map((o) => o.flagCode))

  const [supplementRow] = await db
    .select()
    .from(roadmapSupplements)
    .where(eq(roadmapSupplements.roadmapId, roadmapRow.id))
    .limit(1)
  const supplement: PrescribedSupplement | null = supplementRow
    ? {
        name: supplementRow.name,
        servingLabel: supplementRow.servingLabel,
        servingsPerDay: supplementRow.servingsPerDay,
        proteinGPerServing: supplementRow.proteinGPerServing,
        kcalPerServing: supplementRow.kcalPerServing,
      }
    : null

  // Which regions can actually be generated for is a runtime DB fact (which
  // meal_templates rows exist), not a hardcoded list — so this can never
  // drift out of sync with what's actually been seeded (see the actions-bar
  // region dropdown, which used to hardcode this and silently miss regions
  // added after it was last edited).
  const availableRegionRows = await db.selectDistinct({ region: mealTemplates.region }).from(mealTemplates)
  // north_indian first (the common default when there's no counselling
  // signal to suggest otherwise), then alphabetical — not just whatever
  // order Postgres happens to return.
  const availableRegions = availableRegionRows
    .map((r) => r.region)
    .sort((a, b) => (a === "north_indian" ? -1 : b === "north_indian" ? 1 : a.localeCompare(b)))
  const suggestedRegion = regionFromAnswers(answers)

  const blockFlags = output.flags.filter((f) => f.level === "block" || f.level === "stop")
  const hasUnresolvedBlock = blockFlags.some((f) => !overriddenCodes.has(f.code))

  const heightM = input.heightCm / 100
  const WEEKS_AHEAD = 4
  // weekTargets() already resolves any week against output.phases/proteinRamp
  // — no engine change needed, this was a pure review-page gap.
  // Both figures, deliberately: the prescribed target is the clinical number,
  // and `food` is what the recipes will actually be solved against once the
  // supplement is subtracted. Showing only one of them would hide either the
  // prescription or what the plan is really being built to.
  const upcomingWeeks = Array.from({ length: WEEKS_AHEAD }, (_, i) => {
    const prescribed = weekTargets(output, i + 1)
    return { week: i + 1, prescribed, ...foodTargetsAfterSupplement(prescribed, supplement) }
  })
  const supplementWarnings = upcomingWeeks[0]?.warnings ?? []

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-16 print:max-w-full">
      {/* 1. Client header */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <div>
            <h1 className="font-serif text-2xl font-semibold">{client.name}</h1>
            <p className="text-sm text-muted-foreground">
              {input.ageYears}y · {input.sex} · {input.heightCm} cm · {formatWeight(input.weightKg)} kg ·{" "}
              {CATEGORY_LABEL[input.category] ?? input.category}
              {typeof answers.q33 === "string" ? ` · ${answers.q33}` : ""}
              {Array.isArray(answers.q34) ? ` · ${answers.q34.join(", ")}` : ""}
            </p>
          </div>
          <Badge variant={session.type === "full" ? "default" : "secondary"}>
            {session.type === "full" ? "Full" : "Quick"} counselling
          </Badge>
        </CardContent>
      </Card>

      {/* 2. Energy */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">Energy</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CalcCard
            title="BMR"
            given={`weight ${formatWeight(input.weightKg)} kg · height ${input.heightCm} cm · age ${input.ageYears} · sex ${input.sex}`}
            formula="BMR = 10×weight + 6.25×height − 5×age + (male ? +5 : −161)"
            calc={`= 10×${input.weightKg} + 6.25×${input.heightCm} − 5×${input.ageYears} ${
              input.sex === "male" ? "+ 5" : "− 161"
            } = ${formatKcal(output.energy.bmr)} kcal`}
          />
          <CalcCard
            title="kcal / session"
            given={`intensity "${input.sessionIntensity}" = MET ${output.energy.met} · duration "${input.sessionDuration}" = ${output.energy.hours} h · weight ${formatWeight(input.weightKg)} kg`}
            formula="kcal/session = (MET − 1) × weight × hours"
            calc={`= (${output.energy.met} − 1) × ${input.weightKg} × ${output.energy.hours} = ${formatKcal(output.energy.kcalPerSession)} kcal/session`}
          />
          <CalcCard
            title="Activity + training"
            given={`BMR ${formatKcal(output.energy.bmr)} kcal · activity "${input.activityLevel}" = ×${output.energy.neat} (NEAT-only) · training ${input.trainingDaysPerWeek} d/wk × ${formatKcal(output.energy.kcalPerSession)} kcal/session`}
            formula="activity + training = BMR × NEAT + (training days × kcal/session) ÷ 7"
            calc={`= ${formatKcal(output.energy.bmr)} × ${output.energy.neat} + (${input.trainingDaysPerWeek} × ${formatKcal(output.energy.kcalPerSession)}) ÷ 7 = ${formatKcal(output.energy.activityAndTraining)} kcal`}
          />
          <CalcCard
            title="TDEE"
            given={`activity + training ${formatKcal(output.energy.activityAndTraining)} kcal · TEF share 0.1`}
            formula="TDEE = (activity + training) × (1 + TEF share)"
            calc={`= ${formatKcal(output.energy.activityAndTraining)} × (1 + 0.1) = ${formatKcal(output.energy.tdee)} kcal`}
            footnote="NEAT multipliers here are NEAT-only, deliberately lower than classic activity factors (which bundle TEF in). TEF is charged once, as ×1.10 — the two steps do not double-count."
          />
        </div>
      </section>

      {/* 3. BMI / target weight / timeline */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">BMI, target weight & timeline</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CalcCard
            title="BMI"
            given={`weight ${formatWeight(input.weightKg)} kg · height ${heightM.toFixed(2)} m`}
            formula="BMI = weight ÷ height² · classified per Indian consensus guidelines (overweight ≥ 23, obese ≥ 25)"
            calc={`= ${input.weightKg} ÷ ${heightM.toFixed(2)}² = ${formatBmi(output.anthro.bmiValue)}`}
            chip={<Badge variant="secondary">{output.anthro.classification} (Indian criteria)</Badge>}
          />
          <CalcCard
            title="Target weight"
            given={`height ${heightM.toFixed(2)} m`}
            formula="target weight = 21 × height² (the middle of the healthy range, not its top)"
            calc={`= 21 × ${heightM.toFixed(2)}² = ${formatWeight(output.anthro.targetWeightKg)} kg (healthy ${formatWeight(output.anthro.healthyRangeKg[0])}–${formatWeight(output.anthro.healthyRangeKg[1])} kg)`}
          />
          <CalcCard
            title="To lose & first milestone"
            given={`weight ${formatWeight(input.weightKg)} kg · target ${formatWeight(output.anthro.targetWeightKg)} kg`}
            formula="to lose = max(0, weight − target) · first milestone = 5% × weight"
            calc={`= ${formatWeight(input.weightKg)} − ${formatWeight(output.anthro.targetWeightKg)} = ${formatWeight(output.anthro.toLoseKg)} kg · 0.05×${formatWeight(input.weightKg)} = ${formatWeight(output.anthro.firstMilestoneKg)} kg`}
          />
          <CalcCard
            title="Timeline"
            given={`to lose ${formatWeight(output.anthro.toLoseKg)} kg · 1%/wk = ${formatDivisor(output.anthro.fastestDivisor)} kg · 0.5%/wk = ${formatDivisor(output.anthro.slowestDivisor)} kg`}
            formula="fastest = ceil(to lose ÷ (weight × 0.01)) · slowest = ceil(to lose ÷ (weight × 0.005))"
            calc={`= ceil(${formatWeight(output.anthro.toLoseKg)} ÷ ${formatDivisor(output.anthro.fastestDivisor)}) – ceil(${formatWeight(output.anthro.toLoseKg)} ÷ ${formatDivisor(output.anthro.slowestDivisor)}) = ${output.anthro.fastestWeeks}–${output.anthro.slowestWeeks} weeks`}
          />
        </div>
      </section>

      {/* 4. Calorie strategy */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">Calorie strategy</h2>
        <Card>
          <CardContent className="pt-6">
            <PhaseTable phases={output.phases} />
          </CardContent>
        </Card>
      </section>

      {/* 5. Macros at target */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">
          Macros at target ({formatKcal(output.macrosAtTarget.kcal)} kcal)
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <CalcCard
            title="Dosing weight"
            given={
              output.anthro.bmiValue >= 25
                ? `target weight ${formatWeight(output.anthro.targetWeightKg)} kg · actual weight ${formatWeight(input.weightKg)} kg (BMI ≥ 25)`
                : `actual weight ${formatWeight(input.weightKg)} kg (BMI < 25)`
            }
            formula={
              output.anthro.bmiValue >= 25
                ? "dosing weight = target + 0.25 × (actual − target)"
                : "dosing weight = actual weight — no adjustment below BMI 25"
            }
            calc={
              output.anthro.bmiValue >= 25
                ? `= ${formatWeight(output.anthro.targetWeightKg)} + 0.25×(${formatWeight(input.weightKg)} − ${formatWeight(output.anthro.targetWeightKg)}) = ${formatWeight(output.macrosAtTarget.dosingWeightKg)} kg`
                : `= ${formatWeight(output.macrosAtTarget.dosingWeightKg)} kg`
            }
          />
          <CalcCard
            title="Protein"
            given={
              output.macrosAtTarget.proteinHeld
                ? `protein held — recorded cap ${formatGrams(output.macrosAtTarget.proteinG)} g`
                : `band ${output.macrosAtTarget.proteinBandGPerKg} g/kg (${CATEGORY_LABEL[input.category]}) · dosing weight ${formatWeight(output.macrosAtTarget.dosingWeightKg)} kg`
            }
            formula={
              output.macrosAtTarget.proteinHeld
                ? "PROTEIN = held at the recorded cap; band ignored, ramp disabled"
                : "PROTEIN = band × dosing weight"
            }
            calc={
              output.macrosAtTarget.proteinHeld
                ? `= ${formatGrams(output.macrosAtTarget.proteinG)} g`
                : `= ${output.macrosAtTarget.proteinBandGPerKg} × ${formatWeight(output.macrosAtTarget.dosingWeightKg)} = ${formatGrams(output.macrosAtTarget.proteinG)} g`
            }
          />
          <CalcCard
            title="Fat"
            given={`target kcal ${formatKcal(output.macrosAtTarget.kcal)} · actual weight ${formatWeight(input.weightKg)} kg`}
            formula="FAT = max(25% of kcal ÷ 9, 0.7 g/kg × actual weight)"
            calc={`= max(${formatGrams(output.macrosAtTarget.fatFromPercentG)}, ${formatGrams(output.macrosAtTarget.fatFromFloorG)}) = ${formatGrams(output.macrosAtTarget.fatG)} g`}
          />
          <CalcCard
            title="Carbs"
            given={`kcal ${formatKcal(output.macrosAtTarget.kcal)} · protein ${formatGrams(output.macrosAtTarget.proteinG)} g · fat ${formatGrams(output.macrosAtTarget.fatG)} g`}
            formula="CARBS = (kcal − protein×4 − fat×9) ÷ 4 · the residual"
            calc={`= (${formatKcal(output.macrosAtTarget.kcal)} − ${formatGrams(output.macrosAtTarget.proteinG)}×4 − ${formatGrams(output.macrosAtTarget.fatG)}×9) ÷ 4 = ${formatGrams(output.macrosAtTarget.carbsG)} g`}
          />
          <CalcCard
            title="Fibre"
            given={`target kcal ${formatKcal(output.macrosAtTarget.kcal)}`}
            formula="FIBRE = clamp(kcal ÷ 1000 × 15, 30, 45)"
            calc={`= clamp(${formatKcal(output.macrosAtTarget.kcal)}÷1000×15, 30, 45) = ${formatGrams(output.macrosAtTarget.fibreG)} g`}
          />
        </div>
      </section>

      {/* 6. Protein ramp */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">Protein ramp</h2>
        <Card>
          <CardContent className="pt-6">
            <ProteinRampTable rows={output.proteinRamp} proteinHeld={output.macrosAtTarget.proteinHeld} />
          </CardContent>
        </Card>
      </section>

      {/* 7. Next 4 weeks vs projection */}
      {/* Protein supplement — prescribed here, BEFORE generation, because it
          changes what the food has to supply. The targets table directly
          below shows the result. */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">Protein supplement</h2>
        <SupplementCard
          roadmapId={roadmapRow.id}
          sessionId={session.id}
          current={supplement}
          restriction={proteinPowderRestriction(answers)}
        />
        {supplement && (
          <p className="mt-2 text-sm text-muted-foreground">{describeSupplement(supplement)}</p>
        )}
        {supplementWarnings.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            {supplementWarnings.map((w, n) => (
              <li key={n}>• {w}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">
          Next {WEEKS_AHEAD} weeks vs. {output.projection.label.toLowerCase()}
          {supplement ? " — kcal and protein show what the FOOD must supply, of the full prescribed target" : ""}
        </h2>
        <Card>
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 font-normal">&nbsp;</th>
                  <th className="py-1.5 font-normal">kcal</th>
                  <th className="py-1.5 font-normal">Protein</th>
                  <th className="py-1.5 font-normal">Fat</th>
                  <th className="py-1.5 font-normal">Carbs</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {upcomingWeeks.map(({ week, prescribed, food }) => (
                  <tr key={week} className="border-b">
                    <td className="py-1.5 font-medium">Week {week}</td>
                    <td>
                      {formatKcal(food.kcal)}
                      {supplement && (
                        <span className="text-muted-foreground"> of {formatKcal(prescribed.kcal)}</span>
                      )}
                    </td>
                    <td>
                      {formatGrams(food.proteinG)} g
                      {supplement && (
                        <span className="text-muted-foreground"> of {formatGrams(prescribed.proteinG)} g</span>
                      )}
                    </td>
                    <td>{formatGrams(food.fatG)} g</td>
                    <td>{formatGrams(food.carbsG)} g</td>
                  </tr>
                ))}
                <tr>
                  <td className="py-1.5 font-medium">{output.projection.label}</td>
                  <td>{formatKcal(output.projection.kcal)}</td>
                  <td>{formatGrams(output.projection.proteinG)} g</td>
                  <td>{formatGrams(output.projection.fatG)} g</td>
                  <td>{formatGrams(output.projection.carbsG)} g</td>
                </tr>
              </tbody>
            </table>
            {output.proteinRamp.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                No protein ramp is active for this roadmap — either protein is already at target, or current
                intake (q29b, Section 6) wasn&apos;t recorded, so week-over-week protein stays flat at target
                above rather than stepping up gradually.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* 8. Flags */}
      <section>
        <h2 className="mb-3 font-serif text-lg font-semibold">Flags</h2>
        <FlagsPanel flags={output.flags} overriddenCodes={overriddenCodes} />
        {blockFlags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {blockFlags
              .filter((f) => !overriddenCodes.has(f.code))
              .map((f) => (
                <OverrideDialog key={f.code} roadmapId={roadmapRow.id} sessionId={sessionId} flagCode={f.code} />
              ))}
          </div>
        )}
      </section>

      {/* 9. Actions */}
      <ActionsBar
        sessionId={sessionId}
        roadmapId={roadmapRow.id}
        hasUnresolvedBlock={hasUnresolvedBlock}
        availableRegions={availableRegions}
        suggestedRegion={suggestedRegion}
      />
    </div>
  )
}
