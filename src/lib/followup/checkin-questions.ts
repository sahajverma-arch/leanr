/**
 * The weekly follow-up check-in: what the dietitian asks the client before
 * generating week 2, 3, ... Week 1 comes from the full counselling.
 *
 * Uses the counselling bank's own `Question` shape so the same
 * `QuestionField` renderer draws both forms. Mostly fixed choices rather
 * than free text, so answers read the same way from week to week; each
 * topic that needs detail has an optional note beside it.
 *
 * Nothing here feeds a calculation. The answers are recorded for the
 * dietitian, who sets the next week's numbers by hand (week-target-editor).
 * Current weight is the only required answer — it is the one figure the
 * client page tracks across weeks.
 */
import { z } from "zod"

import type { Answers, Question } from "@/lib/counselling/questions"

const SECTION = "followup"

const hasAny = (id: string, except: string) => (a: Answers) => {
  const v = a[id]
  if (Array.isArray(v)) return v.some((x) => x !== except)
  return typeof v === "string" && v !== "" && v !== except
}

export const WEIGHT_ID = "fu_weight"
export const MENSTRUAL_ID = "fu_menstrual"

export const CHECKIN_QUESTIONS: Question[] = [
  { id: WEIGHT_ID, label: "Current weight (kg)", type: "number", section: SECTION, required: true, placeholder: "e.g. 76.4" },
  {
    id: "fu_energy",
    label: "Energy levels",
    type: "single",
    section: SECTION,
    options: ["Very low", "Low", "Okay", "Good", "Very good"],
  },
  {
    id: "fu_sleep",
    label: "Sleep quality",
    type: "single",
    section: SECTION,
    options: ["Poor (under 5 h)", "Disturbed", "Okay", "Good (7 h+, restful)"],
  },
  {
    id: "fu_digestion",
    label: "Digestive issues",
    type: "multi",
    section: SECTION,
    options: ["None", "Bloating", "Acidity / heartburn", "Constipation", "Loose motions", "Gas", "Other"],
  },
  { id: "fu_digestion_note", label: "Digestive issues — details", type: "text", section: SECTION, showIf: hasAny("fu_digestion", "None") },
  {
    id: "fu_adherence",
    label: "Plan adherence",
    type: "single",
    section: SECTION,
    options: ["All 7 days", "5–6 days", "3–4 days", "1–2 days", "Not followed"],
  },
  { id: "fu_adherence_note", label: "What got in the way?", type: "text", section: SECTION, showIf: hasAny("fu_adherence", "All 7 days") },
  {
    id: "fu_cravings",
    label: "Cravings / cheat meals",
    type: "single",
    section: SECTION,
    options: ["None", "1–2 times", "3–4 times", "5+ times"],
  },
  { id: "fu_cravings_note", label: "What did they crave or eat?", type: "text", section: SECTION, showIf: hasAny("fu_cravings", "None") },
  {
    id: "fu_eating_out",
    label: "Eating out frequency",
    type: "single",
    section: SECTION,
    options: ["Not at all", "1–2 times", "3–4 times", "5+ times"],
  },
  {
    id: "fu_activity",
    label: "Physical activity",
    type: "single",
    section: SECTION,
    options: ["None", "Light (walks only)", "Moderate (3–4 workouts)", "Intense (5+ workouts)"],
  },
  { id: "fu_activity_note", label: "Physical activity — details", type: "text", section: SECTION, placeholder: "e.g. 8k steps daily, 3 gym sessions" },
  {
    id: "fu_water",
    label: "Water intake (per day)",
    type: "single",
    section: SECTION,
    options: ["Under 1.5 L", "1.5–2 L", "2–3 L", "Over 3 L"],
  },
  {
    id: "fu_smoking_alcohol",
    label: "Smoking / alcohol",
    type: "multi",
    section: SECTION,
    options: ["Neither", "Smoking", "Alcohol"],
  },
  { id: "fu_smoking_alcohol_note", label: "How much / how often?", type: "text", section: SECTION, showIf: hasAny("fu_smoking_alcohol", "Neither") },
  {
    id: "fu_stress",
    label: "Stress",
    type: "single",
    section: SECTION,
    options: ["Low", "Moderate", "High", "Very high"],
  },
  { id: "fu_stress_note", label: "Stress — details", type: "text", section: SECTION, showIf: hasAny("fu_stress", "Low") },
  {
    id: MENSTRUAL_ID,
    label: "Menstrual cycle",
    type: "single",
    section: SECTION,
    options: ["Regular — nothing expected", "Period expected next week", "On period now", "Irregular / missed", "Not applicable"],
  },
  {
    id: "fu_outing",
    label: "Any outing planned in the coming week?",
    type: "single",
    section: SECTION,
    options: ["No", "Yes"],
  },
  { id: "fu_outing_note", label: "When and what?", type: "text", section: SECTION, placeholder: "e.g. wedding on Saturday", showIf: hasAny("fu_outing", "No") },
  {
    id: "fu_medicine",
    label: "Medicine",
    type: "single",
    section: SECTION,
    options: ["No change", "New medicine", "Stopped a medicine", "Dose changed"],
  },
  { id: "fu_medicine_note", label: "Which medicine and dose?", type: "text", section: SECTION, showIf: hasAny("fu_medicine", "No change") },
  {
    id: "fu_next_target",
    label: "Next week's target",
    type: "textarea",
    section: SECTION,
    placeholder: "e.g. lose 0.5 kg, 8k steps daily, no sweets on weekdays",
  },
]

/**
 * The questions to show for this client. The menstrual-cycle question is
 * asked only of female clients — the counselling's own `gender` answer.
 */
export function checkinQuestionsFor(client: { female: boolean }): Question[] {
  return CHECKIN_QUESTIONS.filter((q) => client.female || q.id !== MENSTRUAL_ID)
}

/** Questions to actually show for the answers so far (conditional notes appear once relevant). */
export function visibleCheckinQuestions(questions: Question[], answers: Answers): Question[] {
  return questions.filter((q) => !q.showIf || q.showIf(answers))
}

const KNOWN_IDS = new Set(CHECKIN_QUESTIONS.map((q) => q.id))

const answerValue = z.union([z.string().max(1000), z.number().finite(), z.array(z.string().max(200)).max(20)])

/**
 * Boundary schema for a save: only known question ids, only plain values.
 * Hidden conditional notes are dropped, so an answer the dietitian later
 * made irrelevant ("Yes" → "No" outing) is not kept against the client.
 */
export function sanitizeCheckinAnswers(raw: unknown, questions: Question[]): Answers {
  const parsed = z.record(z.string(), answerValue.nullish()).parse(raw)
  const cleaned: Answers = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (!KNOWN_IDS.has(id) || value === undefined || value === null) continue
    if (typeof value === "string" && value.trim() === "") continue
    if (Array.isArray(value) && value.length === 0) continue
    cleaned[id] = typeof value === "string" ? value.trim() : value
  }
  const visible = new Set(visibleCheckinQuestions(questions, cleaned).map((q) => q.id))
  for (const id of Object.keys(cleaned)) if (!visible.has(id)) delete cleaned[id]
  return cleaned
}

export const MIN_WEIGHT_KG = 25
export const MAX_WEIGHT_KG = 300

/** Problems that block SUBMITTING (a draft may be saved with any of these). */
export function checkinSubmitErrors(answers: Answers): Record<string, string> {
  const errors: Record<string, string> = {}
  const weight = answers[WEIGHT_ID]
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    errors[WEIGHT_ID] = "Enter the client's current weight."
  } else if (weight < MIN_WEIGHT_KG || weight > MAX_WEIGHT_KG) {
    errors[WEIGHT_ID] = `Weight must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG} kg — check for a slipped digit.`
  }
  return errors
}

/** The recorded weight, or null if the check-in has none yet. */
export function checkinWeightKg(answers: Answers): number | null {
  const w = answers[WEIGHT_ID]
  return typeof w === "number" && Number.isFinite(w) ? w : null
}

/** One display string per answered question, in question order — for read-only summaries. */
export function describeCheckinAnswers(answers: Answers): Array<{ label: string; value: string }> {
  return CHECKIN_QUESTIONS.flatMap((q) => {
    const v = answers[q.id]
    if (v === undefined || v === null || v === "") return []
    const value = Array.isArray(v) ? v.join(", ") : q.id === WEIGHT_ID ? `${v} kg` : String(v)
    return [{ label: q.label, value }]
  })
}
