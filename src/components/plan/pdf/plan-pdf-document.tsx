/**
 * Server-only @react-pdf/renderer tree — a parallel rendering of the SAME
 * PlanViewModel the web page renders (plan-view-model.ts), never a second
 * source of truth. react-pdf has no DOM/HTML primitives (no <table>, no
 * SVG charting lib), so this is hand-built with View/Text/Svg, not shared
 * JSX with the web page.
 */

import { Document, Page, Path, StyleSheet, Svg, Text, View } from "@react-pdf/renderer"

import { formatBmi, formatGrams, formatKcal, formatWeight } from "@/lib/format"
import { combineDishGroups } from "@/lib/plan/dish-combination"
import { composeMealDisplay, formatComposedGroupPlainText, type ComposedGroup } from "@/lib/plan/meal-composition"
import { applyVegetableDishNames } from "@/lib/plan/vegetable-dish-naming"
import { isMixedVegDay } from "@/lib/plan/mixed-veg-day"
import type { PlanViewModel } from "@/lib/plan/plan-view-model"
import { planDateRangeLabel } from "@/lib/plan/plan-view-model"

const COLORS = { protein: "#facc15", carbs: "#38bdf8", fat: "#f97316" }

const styles = StyleSheet.create({
  page: { padding: 28, fontSize: 9, fontFamily: "Helvetica", color: "#111827" },
  header: { backgroundColor: "#0a0a0a", color: "#ffffff", borderRadius: 8, padding: 14, marginBottom: 10 },
  supplementBox: { borderWidth: 1.5, borderColor: "#047857", backgroundColor: "#ecfdf5", borderRadius: 6, padding: 8, marginBottom: 10 },
  supplementTitle: { fontSize: 8, fontFamily: "Helvetica-Bold", color: "#047857" },
  supplementBody: { fontSize: 8.5, color: "#064e3b", marginTop: 2, lineHeight: 1.35 },
  headerRow: { flexDirection: "row", justifyContent: "space-between" },
  headerLeft: { flex: 1, paddingRight: 10 },
  h1: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  headerLine: { fontSize: 9, color: "#d4d4d4", marginTop: 2 },
  brand: { fontSize: 18, fontFamily: "Helvetica-BoldOblique", color: "#facc15" },
  brandSub: { fontSize: 7, color: "#a3a3a3" },
  tiles: { flexDirection: "row", gap: 8, marginBottom: 10 },
  tile: { flex: 1, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, padding: 8 },
  tileLabel: { fontSize: 7, color: "#6b7280", textTransform: "uppercase" },
  tileValue: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 2 },
  card: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, padding: 10, marginBottom: 10 },
  row: { flexDirection: "row", alignItems: "center" },
  legendDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
  narrative: { fontSize: 8.5, color: "#4b5563", marginBottom: 10, lineHeight: 1.4 },
  dayCard: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6, marginBottom: 8, overflow: "hidden" },
  dayHeader: { backgroundColor: "#0a0a0a", color: "#fff", padding: 6, flexDirection: "row", justifyContent: "space-between", fontSize: 8.5 },
  table: { display: "flex", width: "100%" },
  tHeadRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb", backgroundColor: "#f9fafb" },
  tRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#f3f4f6" },
  tFootRow: { flexDirection: "row", backgroundColor: "#f9fafb", borderTopWidth: 1, borderTopColor: "#e5e7eb" },
  cellTime: { width: "8%", padding: 4 },
  cellMeal: { width: "10%", padding: 4, fontFamily: "Helvetica-Bold" },
  cellFoods: { width: "38%", padding: 4 },
  cookingFatNote: { fontSize: 7, color: "#6b7280", fontStyle: "italic", marginTop: 2 },
  cellNum: { width: "8.8%", padding: 4, textAlign: "right" },
  th: { fontSize: 7, fontFamily: "Helvetica-Bold", color: "#6b7280", textTransform: "uppercase" },
  guidelineItem: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 8 },
  footer: { marginTop: 8, borderTopWidth: 1, borderTopColor: "#e5e7eb", paddingTop: 6, textAlign: "center", fontSize: 7, color: "#6b7280" },
})

/**
 * react-pdf's built-in Helvetica is a standard-14 PDF font (WinAnsi
 * encoding) — it silently mis-renders characters outside that set instead
 * of erroring, e.g. "→" (U+2192, used in the protein-ramp guideline line)
 * came out as a stray apostrophe. Guideline/narrative text is free-form and
 * shared with the web page (which renders it in a browser with full
 * Unicode support), so this swap happens only here, not at the source.
 */
function pdfSafeText(text: string): string {
  return text.replace(/→/g, "->")
}

/**
 * A dietitian asked for cooking oil/ghee to read as a light, secondary
 * note ("Cooking fat: Mustard oil (7.5 g)") rather than sitting in the same
 * comma-separated food list as the actual dish — it's the pan it's cooked
 * in, not a dish in its own right. Scoped to `cooking_fat`-tagged foods
 * specifically (Ghee, Mustard oil, ...), not nuts (untagged `fat` foods,
 * e.g. Almonds at mid_morning) — a nut IS the snack, not a seasoning for
 * one, so it stays in the main food list unchanged.
 */
function isCookingFatGroup(group: ComposedGroup): boolean {
  return group.kind === "plain" && group.items[0].exchangeType === "fat" && group.items[0].tags.includes("cooking_fat")
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function donutSlicePath(cx: number, cy: number, outerR: number, innerR: number, startAngle: number, endAngle: number): string {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0
  const p1 = polarToCartesian(cx, cy, outerR, endAngle)
  const p2 = polarToCartesian(cx, cy, outerR, startAngle)
  const p3 = polarToCartesian(cx, cy, innerR, startAngle)
  const p4 = polarToCartesian(cx, cy, innerR, endAngle)
  return `M ${p1.x} ${p1.y} A ${outerR} ${outerR} 0 ${largeArc} 0 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${innerR} ${innerR} 0 ${largeArc} 1 ${p4.x} ${p4.y} Z`
}

function MacroDonutPdf({ proteinG, carbsG, fatG }: { proteinG: number; carbsG: number; fatG: number }) {
  const slices = [
    { kcal: proteinG * 4, color: COLORS.protein },
    { kcal: carbsG * 4, color: COLORS.carbs },
    { kcal: fatG * 9, color: COLORS.fat },
  ]
  const total = slices.reduce((a, s) => a + s.kcal, 0) || 1
  let angle = 0
  const paths = slices.map((s) => {
    const sweep = (s.kcal / total) * 360
    const path = sweep > 0 ? donutSlicePath(30, 30, 28, 16, angle, angle + sweep) : null
    angle += sweep
    return path ? { d: path, color: s.color } : null
  })

  return (
    <Svg width={60} height={60} viewBox="0 0 60 60">
      {paths.map((p, i) => (p ? <Path key={i} d={p.d} fill={p.color} /> : null))}
    </Svg>
  )
}

export function PlanPdfDocument({ model }: { model: PlanViewModel }) {
  const { plan, client, roadmap, targets, deviationPct, days, weeklySummary, weeklyAvg, guidelines, foodsToAvoid, narrative, supplementLine } = model
  const worstDeviation = Math.max(
    Math.abs(deviationPct.kcal),
    Math.abs(deviationPct.proteinG),
    Math.abs(deviationPct.fatG),
    Math.abs(deviationPct.carbsG)
  )

  return (
    <Document title={`${client.name} — Week ${plan.weekNumber} Diet Plan`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.headerLeft}>
              <Text style={styles.h1}>{client.name} — Weekly Diet Plan</Text>
              <Text style={styles.headerLine}>
                Week {plan.weekNumber} · {planDateRangeLabel(plan)} · Prepared by {plan.preparedByName ?? "—"}
              </Text>
              <Text style={styles.headerLine}>
                Diet: {plan.dietType} | Region: {plan.region.replace(/_/g, " ")}
              </Text>
              <Text style={styles.headerLine}>
                Goal: {roadmap.categoryLabel} | {formatWeight(roadmap.weightKg)} kg · BMI {formatBmi(roadmap.bmiValue)} ·
                TDEE {formatKcal(roadmap.tdee)} kcal
              </Text>
            </View>
            <View>
              <Text style={styles.brand}>LEANR</Text>
              <Text style={styles.brandSub}>by Fitelo</Text>
            </View>
          </View>
        </View>

        {/* Prescribed supplement — printed above the week, because it is the
            one part of the day the plan does not cook. */}
        {supplementLine ? (
          <View style={styles.supplementBox}>
            <Text style={styles.supplementTitle}>SUPPLEMENT</Text>
            <Text style={styles.supplementBody}>{supplementLine}</Text>
            <Text style={styles.supplementBody}>
              The meals below supply the rest of the day&apos;s target. Take this in addition to the food.
            </Text>
          </View>
        ) : null}

        <View style={styles.tiles}>
          <StatTile label="Avg Daily Calories" value={`${formatKcal(weeklyAvg.kcal)} kcal`} />
          <StatTile label="Avg Protein" value={`${formatGrams(weeklyAvg.proteinG)} g`} />
          <StatTile label="Avg Carbohydrates" value={`${formatGrams(weeklyAvg.carbsG)} g`} />
          <StatTile label="Avg Fat" value={`${formatGrams(weeklyAvg.fatG)} g`} />
        </View>

        <View style={[styles.card, styles.row, { gap: 10 }]}>
          <MacroDonutPdf proteinG={weeklyAvg.proteinG} carbsG={weeklyAvg.carbsG} fatG={weeklyAvg.fatG} />
          <View style={{ flex: 1 }}>
            <View style={[styles.row, { gap: 8, marginBottom: 3 }]}>
              <Legend color={COLORS.protein} label="Protein" />
              <Legend color={COLORS.carbs} label="Carbohydrates" />
              <Legend color={COLORS.fat} label="Fat" />
            </View>
            <Text style={{ fontSize: 8.5 }}>
              Roadmap target {formatKcal(targets.kcal)} kcal · P {formatGrams(targets.proteinG)}g · C{" "}
              {formatGrams(targets.carbsG)}g · F {formatGrams(targets.fatG)}g — plan deviates by{" "}
              {worstDeviation.toFixed(2)}% on the worst macro.
            </Text>
            <Text style={{ fontSize: 7, color: "#6b7280", marginTop: 2 }}>
              All values computed from Table 4.1, Comprehensive Food Exchange List (Indian modified American
              exchange list).
            </Text>
          </View>
        </View>

        <Text style={styles.narrative}>{pdfSafeText(narrative)}</Text>

        {days.map((day) => (
          <View key={day.dayIndex} style={styles.dayCard} wrap={false}>
            <View style={styles.dayHeader}>
              <Text>{day.dateLabel}</Text>
              <Text>
                {formatKcal(day.totals.kcal)} kcal | P {formatGrams(day.totals.proteinG)}g | C{" "}
                {formatGrams(day.totals.carbsG)}g | F {formatGrams(day.totals.fatG)}g
              </Text>
            </View>
            <View style={styles.table}>
              <View style={styles.tHeadRow}>
                <Text style={[styles.cellTime, styles.th]}>Time</Text>
                <Text style={[styles.cellMeal, styles.th]}>Meal</Text>
                <Text style={[styles.cellFoods, styles.th]}>Foods</Text>
                <Text style={[styles.cellNum, styles.th]}>Cal</Text>
                <Text style={[styles.cellNum, styles.th]}>Pro</Text>
                <Text style={[styles.cellNum, styles.th]}>Carb</Text>
                <Text style={[styles.cellNum, styles.th]}>Fat</Text>
                <Text style={[styles.cellNum, styles.th]}>Cal%</Text>
              </View>
              {day.meals.map((meal) => {
                const groups = applyVegetableDishNames(
                  combineDishGroups(
                    composeMealDisplay(meal.items, model.plan.region),
                    meal.archetypeName,
                    meal.archetypeDishFamilyIdsByExchangeType,
                    model.dishCombinations,
                    model.plan.region
                  ),
                  model.vegetableDishCombinations,
                  model.vegetableDishCombinationMembers,
                  model.plan.region,
                  isMixedVegDay(day.dayIndex + (plan.weekNumber - 1) * 7)
                )
                const cookingFatGroups = groups.filter(isCookingFatGroup)
                const mainGroups = groups.filter((g) => !isCookingFatGroup(g))

                return (
                  <View key={meal.slot} style={styles.tRow}>
                    <Text style={styles.cellTime}>{meal.timeLabel}</Text>
                    <Text style={styles.cellMeal}>{meal.slotLabel}</Text>
                    <View style={styles.cellFoods}>
                      <Text>{mainGroups.map(formatComposedGroupPlainText).join(", ")}</Text>
                      {cookingFatGroups.length > 0 ? (
                        <Text style={styles.cookingFatNote}>
                          Cooking fat: {cookingFatGroups.map(formatComposedGroupPlainText).join(", ")}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.cellNum}>{formatKcal(meal.totals.kcal)}</Text>
                    <Text style={styles.cellNum}>{formatGrams(meal.totals.proteinG)}g</Text>
                    <Text style={styles.cellNum}>{formatGrams(meal.totals.carbsG)}g</Text>
                    <Text style={styles.cellNum}>{formatGrams(meal.totals.fatG)}g</Text>
                    <Text style={styles.cellNum}>{Math.round(meal.calPercent)}%</Text>
                  </View>
                )
              })}
              <View style={styles.tFootRow}>
                <Text style={[styles.cellTime, { fontFamily: "Helvetica-Bold" }]} />
                <Text style={[styles.cellMeal, { fontFamily: "Helvetica-Bold" }]}>Total</Text>
                <Text style={styles.cellFoods} />
                <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatKcal(day.totals.kcal)}</Text>
                <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(day.totals.proteinG)}g</Text>
                <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(day.totals.carbsG)}g</Text>
                <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(day.totals.fatG)}g</Text>
                <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>100%</Text>
              </View>
            </View>
          </View>
        ))}

        <View style={styles.dayCard} wrap={false}>
          <View style={styles.dayHeader}>
            <Text>Weekly Summary</Text>
          </View>
          <View style={styles.table}>
            <View style={styles.tHeadRow}>
              <Text style={[styles.cellMeal, styles.th, { width: "22%" }]}>Day</Text>
              <Text style={[styles.cellNum, styles.th]}>Cal</Text>
              <Text style={[styles.cellNum, styles.th]}>Pro</Text>
              <Text style={[styles.cellNum, styles.th]}>Carb</Text>
              <Text style={[styles.cellNum, styles.th]}>Fat</Text>
              <Text style={[styles.cellNum, styles.th]}>P%</Text>
              <Text style={[styles.cellNum, styles.th]}>C%</Text>
              <Text style={[styles.cellNum, styles.th]}>F%</Text>
            </View>
            {weeklySummary.map((r) => (
              <View key={r.label} style={styles.tRow}>
                <Text style={{ width: "22%", padding: 4 }}>{r.label}</Text>
                <Text style={styles.cellNum}>{formatKcal(r.kcal)}</Text>
                <Text style={styles.cellNum}>{formatGrams(r.proteinG)}</Text>
                <Text style={styles.cellNum}>{formatGrams(r.carbsG)}</Text>
                <Text style={styles.cellNum}>{formatGrams(r.fatG)}</Text>
                <Text style={styles.cellNum}>{Math.round(r.proteinPct)}%</Text>
                <Text style={styles.cellNum}>{Math.round(r.carbsPct)}%</Text>
                <Text style={styles.cellNum}>{Math.round(r.fatPct)}%</Text>
              </View>
            ))}
            <View style={styles.tFootRow}>
              <Text style={{ width: "22%", padding: 4, fontFamily: "Helvetica-Bold" }}>{weeklyAvg.label}</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatKcal(weeklyAvg.kcal)}</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(weeklyAvg.proteinG)}</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(weeklyAvg.carbsG)}</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{formatGrams(weeklyAvg.fatG)}</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{Math.round(weeklyAvg.proteinPct)}%</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{Math.round(weeklyAvg.carbsPct)}%</Text>
              <Text style={[styles.cellNum, { fontFamily: "Helvetica-Bold" }]}>{Math.round(weeklyAvg.fatPct)}%</Text>
            </View>
          </View>
        </View>

        <View style={styles.card} wrap={false}>
          <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 6 }}>GUIDELINES</Text>
          {guidelines.map((g, i) => (
            <View key={i} style={styles.guidelineItem}>
              <Text style={styles.bullet}>•</Text>
              <Text style={{ flex: 1 }}>
                {g.lead ? <Text style={{ fontFamily: "Helvetica-Bold" }}>{pdfSafeText(g.lead)} </Text> : null}
                {pdfSafeText(g.text)}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.card} wrap={false}>
          <Text style={{ fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 6 }}>FOODS TO AVOID</Text>
          {foodsToAvoid.map((f, i) => (
            <View key={i} style={styles.guidelineItem}>
              <Text style={styles.bullet}>•</Text>
              <Text style={{ flex: 1 }}>{pdfSafeText(f)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          <Text>
            Generated by LEANR Diet Platform | Diet Preference: {plan.dietType} | Goal: {roadmap.categoryLabel} |
            Prepared by {plan.preparedByName ?? "—"}
          </Text>
          <Text>
            Created with AI assistance and reviewed by your dietitian. Not a substitute for medical advice — consult
            your doctor before major dietary changes.
          </Text>
        </View>
      </Page>
    </Document>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={{ fontSize: 7.5 }}>{label}</Text>
    </View>
  )
}

