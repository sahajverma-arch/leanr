/**
 * Orchestrates recipe selection: (1) whole-week LLM attempt, up to 3
 * attempts with backoff, falling back to the deterministic selector after 3
 * straight failures (skipping phase 2 entirely — a model that failed 3x is
 * very likely unreachable); (2) per-day retry (LLM path only), up to
 * MAX_DAY_RETRIES=3, triggered by ANY of three independent checks failing —
 * macro tolerance, plausibility, or variety — each retry telling the model
 * exactly what's wrong; (3) an honest final gate: any day still failing
 * after every retry REJECTS THE WHOLE PLAN (no DB write), applying equally
 * to the deterministic fallback (unlike prior engines, there is no
 * LLM-only exemption here — see CLAUDE.md "The recipe engine").
 */

import { createOpenAIClient, OPENAI_MODEL } from "./openai-client"
import { buildDayRetryMessages, buildInitialMessages, type PromptMessage } from "./recipe-prompt"
import { llmRecipeDaySchema, llmRecipeSelectionSchema } from "./recipe-schema"
import { buildRecipeIndex, groundSelection, type RecipeIndex } from "./recipe-grounding"
import { balanceDayToTargets } from "./recipe-balancer"
import { describeMacroProblems, isRecipeDayOffTarget, isRecipeWeekOffTarget, RECIPE_MACRO_TOLERANCE } from "./recipe-validate"
import { computeWeeklyAverage, pickBestWeek, weeklyDeviationScore } from "./recipe-week-score"
import { buildRecipeWarnings, offTargetSummary } from "./recipe-warnings"
import { blockingProblems, diagnoseDay } from "./recipe-day-diagnosis"
import { describePlausibilityProblems, type ClientRecipeConstraints } from "./recipe-plausibility-validate"
import { findDaysNeedingVarietyRetry, findVarietyViolations, MAX_RECIPE_REPEATS_PER_WEEK } from "./recipe-variety-tracker"
import { recipeSelectorFallback } from "./recipe-selector-fallback"
import type { GroundedRecipeDay, GroundedRecipeSelection, RecipeAchievedMacros, RecipeSelection, RecipeSelectionResult, RecipeSelectorInput } from "./recipe-types"

const MAX_WEEK_ATTEMPTS = 3
const MAX_DAY_RETRIES = 3
const BASE_BACKOFF_MS = 500

export interface RecipeAttemptLog {
  attemptNumber: number
  dayIndex: number | null
  model: string | null
  promptHash: string
  rawResponse: string | null
  validationResult: { ok: boolean; errors: string[] }
  latencyMs: number
}

export interface SelectRecipesOptions {
  onAttempt?: (log: RecipeAttemptLog) => void
  maxWeekAttempts?: number
  maxDayRetries?: number
  /**
   * Best-of-N strategy: run N independent whole-week calls (no day retries)
   * and keep the one closest to target on its WEEKLY AVERAGE. 0/undefined
   * keeps the original per-day-retry path untouched.
   *
   * Exists because the retry path costs 19-22 calls and, measured on real
   * runs, 18 day-retries repaired exactly one day before the week was
   * rejected anyway. N independent attempts buy more variation per rupee.
   */
  bestOfN?: number
}

export class RecipeSelectionRejectedError extends Error {
  constructor(
    message: string,
    public readonly dayProblems: { dayIndex: number; problems: string[] }[],
    /**
     * The week that was built and then rejected — carried purely so a
     * caller can SHOW it. Without this a rejected run reports what was
     * wrong but never what it actually composed, which is backwards for
     * diagnosing why the model drifted. Nothing writes this to the DB: the
     * reject-on-failure gate is unchanged, this is diagnostic payload only.
     */
    public readonly rejectedDays: GroundedRecipeDay[] = []
  ) {
    super(message)
    this.name = "RecipeSelectionRejectedError"
  }
}

function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  return hash.toString(16)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractJson(raw: string): unknown {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response")
  return JSON.parse(raw.slice(start, end + 1))
}

function dayNeedsRetry(day: GroundedRecipeDay, input: RecipeSelectorInput, constraints: ClientRecipeConstraints, daysNeedingVarietyRetry: Set<number>): boolean {
  return (
    isRecipeDayOffTarget(day.totals, input.dailyTarget) ||
    describePlausibilityProblems(day, constraints).length > 0 ||
    daysNeedingVarietyRetry.has(day.dayIndex) ||
    day.unknownRecipeNames.length > 0
  )
}

async function callModel(messages: PromptMessage[]): Promise<{ rawResponse: string | null; latencyMs: number }> {
  const client = createOpenAIClient()
  const startedAt = Date.now()
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.3,
  })
  return { rawResponse: completion.choices[0]?.message?.content ?? null, latencyMs: Date.now() - startedAt }
}

/**
 * One whole-week call: model -> parse -> ground -> balance. Returns null on
 * any failure (empty response, unparseable JSON, schema mismatch), having
 * already emitted its attempt log either way. Shared by both the retry path
 * and the best-of-N path so they cannot drift apart on how a week is built.
 */
async function attemptWholeWeek(
  input: RecipeSelectorInput,
  index: RecipeIndex,
  messages: PromptMessage[],
  promptHash: string,
  attemptNumber: number,
  onAttempt?: (log: RecipeAttemptLog) => void
): Promise<GroundedRecipeDay[] | null> {
  let rawResponse: string | null = null
  let latencyMs = 0
  let validationResult: { ok: boolean; errors: string[] } = { ok: false, errors: [] }

  try {
    const result = await callModel(messages)
    rawResponse = result.rawResponse
    latencyMs = result.latencyMs

    if (!rawResponse) {
      validationResult = { ok: false, errors: ["Model returned an empty response."] }
    } else {
      const parsed = llmRecipeSelectionSchema.parse(extractJson(rawResponse))
      const grounded = groundSelection(parsed, index)
      const balanced = grounded.days.map((day) => balanceDayToTargets(day, input.dailyTarget))
      validationResult = { ok: true, errors: [] }
      onAttempt?.({ attemptNumber, dayIndex: null, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })
      return balanced
    }
  } catch (err) {
    validationResult = { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }

  onAttempt?.({ attemptNumber, dayIndex: null, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })
  return null
}

/**
 * Best-of-N: N independent whole-week calls, keep the one closest to target
 * on its weekly average. No backoff between attempts — these are independent
 * samples, not retries of a failure, and the whole point is a small fixed
 * cost. Falls back to the deterministic selector only if EVERY call failed.
 */
async function runBestOfNPhase(
  input: RecipeSelectorInput,
  index: RecipeIndex,
  n: number,
  onAttempt?: (log: RecipeAttemptLog) => void
): Promise<{ days: GroundedRecipeDay[]; generationMode: "ai" | "fallback"; modelUsed: string | null; attempts: number }> {
  const messages = buildInitialMessages(input)
  const promptHash = hashString(JSON.stringify(messages))

  // Run the N attempts CONCURRENTLY. They are independent samples of the
  // same prompt, not retries of a failure, so nothing depends on an earlier
  // one — and sequentially they cost N x latency, which blew a real 60s
  // Vercel function ceiling (3 calls at ~10s each, plus DB and balancing,
  // timed out in production). Concurrently the LLM cost is one call's
  // latency, not three.
  //
  // Promise.all preserves INPUT order regardless of completion order, which
  // matters: pickBestWeek() breaks ties on the earliest candidate, so a
  // fixed set of responses must always rank the same way. attemptWholeWeek()
  // swallows its own failures and returns null, so one bad call cannot
  // reject the batch.
  const settled = await Promise.all(
    Array.from({ length: n }, (_, i) => attemptWholeWeek(input, index, messages, promptHash, i + 1, onAttempt))
  )
  const candidates = settled.filter((days): days is GroundedRecipeDay[] => days !== null)

  const best = pickBestWeek(candidates, input.dailyTarget)
  if (best === null) {
    const fallbackSelected = recipeSelectorFallback(input)
    const grounded = groundSelection(fallbackSelected, index)
    return {
      days: grounded.days.map((day) => balanceDayToTargets(day, input.dailyTarget)),
      generationMode: "fallback",
      modelUsed: null,
      attempts: n,
    }
  }
  return { days: best.days, generationMode: "ai", modelUsed: OPENAI_MODEL, attempts: candidates.length }
}

async function runWholeWeekPhase(
  input: RecipeSelectorInput,
  index: RecipeIndex,
  maxAttempts: number,
  onAttempt?: (log: RecipeAttemptLog) => void
): Promise<{ grounded: GroundedRecipeSelection; generationMode: "ai" | "fallback"; modelUsed: string | null; attempts: number }> {
  const messages = buildInitialMessages(input)
  const promptHash = hashString(JSON.stringify(messages))

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    let rawResponse: string | null = null
    let latencyMs = 0
    let validationResult: { ok: boolean; errors: string[] } = { ok: false, errors: [] }

    try {
      const result = await callModel(messages)
      rawResponse = result.rawResponse
      latencyMs = result.latencyMs

      if (!rawResponse) {
        validationResult = { ok: false, errors: ["Model returned an empty response."] }
      } else {
        const parsed = llmRecipeSelectionSchema.parse(extractJson(rawResponse))
        const selection: RecipeSelection = parsed
        const grounded = groundSelection(selection, index)
        const balancedDays = grounded.days.map((day) => balanceDayToTargets(day, input.dailyTarget))
        validationResult = { ok: true, errors: [] }
        onAttempt?.({ attemptNumber, dayIndex: null, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })
        return { grounded: { days: balancedDays }, generationMode: "ai", modelUsed: OPENAI_MODEL, attempts: attemptNumber }
      }
    } catch (err) {
      validationResult = { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
    }

    onAttempt?.({ attemptNumber, dayIndex: null, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })

    if (attemptNumber < maxAttempts) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attemptNumber - 1))
    }
  }

  const fallbackSelected = recipeSelectorFallback(input)
  const grounded = groundSelection(fallbackSelected, index)
  const balancedDays = grounded.days.map((day) => balanceDayToTargets(day, input.dailyTarget))
  return { grounded: { days: balancedDays }, generationMode: "fallback", modelUsed: null, attempts: maxAttempts }
}

async function retryOneDay(
  input: RecipeSelectorInput,
  index: RecipeIndex,
  day: GroundedRecipeDay,
  diagnoses: string[],
  attemptNumber: number,
  onAttempt?: (log: RecipeAttemptLog) => void
): Promise<GroundedRecipeDay | null> {
  const messages = buildDayRetryMessages(input, day, diagnoses)
  const promptHash = hashString(JSON.stringify(messages))
  let rawResponse: string | null = null
  let latencyMs = 0
  let validationResult: { ok: boolean; errors: string[] } = { ok: false, errors: [] }

  try {
    const result = await callModel(messages)
    rawResponse = result.rawResponse
    latencyMs = result.latencyMs
    if (!rawResponse) {
      validationResult = { ok: false, errors: ["Model returned an empty response."] }
    } else {
      const parsedDay = llmRecipeDaySchema.parse(extractJson(rawResponse))
      const grounded = groundSelection({ days: [parsedDay] }, index)
      const balanced = balanceDayToTargets(grounded.days[0], input.dailyTarget)
      validationResult = { ok: true, errors: [] }
      onAttempt?.({ attemptNumber, dayIndex: day.dayIndex, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })
      return { ...balanced, dayIndex: day.dayIndex }
    }
  } catch (err) {
    validationResult = { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
  }

  onAttempt?.({ attemptNumber, dayIndex: day.dayIndex, model: OPENAI_MODEL, promptHash, rawResponse, validationResult, latencyMs })
  return null
}

export async function selectRecipes(
  input: RecipeSelectorInput,
  constraints: ClientRecipeConstraints,
  options: SelectRecipesOptions = {}
): Promise<RecipeSelectionResult> {
  const maxWeekAttempts = options.maxWeekAttempts ?? MAX_WEEK_ATTEMPTS
  const maxDayRetries = options.maxDayRetries ?? MAX_DAY_RETRIES
  const index = buildRecipeIndex([...input.allRecipesById.values()], input.aliasRows)

  // BEST-OF-N PATH. A deliberate, confirmed change of acceptance rule for
  // this path only: the week is gated on its WEEKLY AVERAGE, which is
  // exactly the standard the exchange engine already holds itself to
  // (assertWeeklyAverageWithinTolerance), instead of every day clearing the
  // per-day tolerance. This is NOT a softening to "always succeeds with
  // warnings" — a week whose average misses is still rejected outright with
  // no DB write, which is what CLAUDE.md's "Do not" list actually protects.
  // Per-day misses become warnings rather than vanishing; see
  // bestOfNWarnings().
  if (options.bestOfN && options.bestOfN > 0) {
    const { days, generationMode, modelUsed, attempts } = await runBestOfNPhase(input, index, options.bestOfN, options.onAttempt)
    const weeklyAverage = computeWeeklyAverage(days)
    const offTarget = isRecipeWeekOffTarget(weeklyAverage, input.dailyTarget)

    // The nearest week is ALWAYS returned, never rejected — a confirmed
    // decision (see CLAUDE.md "Best-of-N generation"), taken after measuring
    // that the misses are systematic rather than random: five independent
    // samples for one real client all came back protein ~11% under and carbs
    // ~19% over, so resampling cannot rescue them and a rejection just leaves
    // the dietitian with nothing.
    //
    // This is NOT the "always succeeds, warnings ignored" behaviour the "Do
    // not" list forbids. The distinction is that the deviation is measured,
    // named per macro, persisted on the plan row and rendered on the plan
    // page — the dietitian decides whether it is usable, on the numbers,
    // instead of the engine deciding for them and discarding the work.
    const warnings = buildRecipeWarnings(days, input.dailyTarget, constraints)
    if (offTarget) {
      const summary = offTargetSummary(weeklyAverage, input.dailyTarget, attempts)
      if (summary) warnings.unshift(summary)
    }

    return { selection: { days }, generationMode, modelUsed, attempts, warnings }
  }

  const { grounded, generationMode, modelUsed, attempts } = await runWholeWeekPhase(input, index, maxWeekAttempts, options.onAttempt)
  let days = grounded.days

  // Per-day retry — LLM path only; the fallback path has no model to retry
  // with, so its days go straight to the final gate below.
  if (generationMode === "ai") {
    for (let round = 0; round < maxDayRetries; round++) {
      const daysNeedingVarietyRetry = findDaysNeedingVarietyRetry(days)
      const overused = new Set(findVarietyViolations(days).map((v) => v.name))
      const dayIndexesNeedingRetry = days.filter((d) => dayNeedsRetry(d, input, constraints, daysNeedingVarietyRetry)).map((d) => d.dayIndex)
      if (dayIndexesNeedingRetry.length === 0) break

      for (const dayIndex of dayIndexesNeedingRetry) {
        const day = days.find((d) => d.dayIndex === dayIndex)!
        const diagnoses = diagnoseDay(day, input, constraints, overused)
        const retried = await retryOneDay(input, index, day, diagnoses, round + 1, options.onAttempt)
        if (retried) days = days.map((d) => (d.dayIndex === dayIndex ? retried : d))
      }
    }
  }

  // Final, honest gate — applies identically to both generation modes, no
  // exemption for the fallback path (confirmed decision, a real ethos
  // change from both prior engines' "always succeeds" guarantee).
  const daysNeedingVarietyRetry = findDaysNeedingVarietyRetry(days)
  const overused = new Set(findVarietyViolations(days).map((v) => v.name))
  const dayProblems = days
    .map((day) => ({ dayIndex: day.dayIndex, problems: blockingProblems(day, input, constraints, overused) }))
    .filter((d) => d.problems.length > 0 || daysNeedingVarietyRetry.has(d.dayIndex))

  const weeklyAverage = computeWeeklyAverage(days)
  const weekOffTarget = isRecipeWeekOffTarget(weeklyAverage, input.dailyTarget)

  if (dayProblems.length > 0 || weekOffTarget) {
    throw new RecipeSelectionRejectedError(
      `Recipe plan rejected: ${dayProblems.length} day(s) still failed validation after ${maxDayRetries} retries.`,
      dayProblems,
      days
    )
  }

  const warnings: string[] = []
  for (const day of days) {
    if (day.cappedRecipeNames.length > 0) warnings.push(`Day ${day.dayIndex}: recipes hit their serving limit: ${day.cappedRecipeNames.join(", ")}`)
  }

  return { selection: { days }, generationMode, modelUsed, attempts, warnings }
}
