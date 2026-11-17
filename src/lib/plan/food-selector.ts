/**
 * The only place in the codebase that calls an LLM. It picks which food IDs
 * fill each exchange slot — nothing else. See CLAUDE.md "THE ONE RULE THAT
 * MATTERS": the model never sees a calorie or macro target and never
 * computes anything; every number here comes from the skeleton it was
 * handed, and every food it names is re-checked against the eligible set
 * after the fact. 3 attempts, exponential backoff, then a deterministic
 * fallback so plan generation always succeeds.
 */

import { ANTHROPIC_MODEL, callClaude } from "./anthropic-client"
import { extractJson } from "./llm-json"
import { SYSTEM_PROMPT, buildUserPrompt } from "./food-selector-prompt"
import { llmSelectionSchema } from "./food-selector-schema"
import { toSelection, validateSelection } from "./food-selector-validate"
import { fallbackSelection } from "./food-selector-fallback"
import type { FoodSelectorInput, FoodSelectionResult } from "./food-selector-types"

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 500

export interface AttemptLog {
  attemptNumber: number
  model: string
  promptHash: string
  rawResponse: string | null
  validationResult: { ok: boolean; errors: string[] }
  latencyMs: number
}

export interface SelectFoodsOptions {
  onAttempt?: (log: AttemptLog) => void
  maxAttempts?: number
}

function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function selectFoods(
  input: FoodSelectorInput,
  options: SelectFoodsOptions = {}
): Promise<FoodSelectionResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const userPrompt = buildUserPrompt(input)
  const promptHash = hashString(userPrompt)

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    const startedAt = Date.now()
    let rawResponse: string | null = null
    // The model that actually answered — the configured one unless a refusal
    // fallback ran (see anthropic-client.ts).
    let model = ANTHROPIC_MODEL
    let validationResult: { ok: boolean; errors: string[] } = { ok: false, errors: [] }

    try {
      const result = await callClaude([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ])
      rawResponse = result.rawResponse
      model = result.model

      if (!rawResponse) {
        validationResult = { ok: false, errors: ["Model returned an empty response."] }
      } else {
        const parsed = extractJson(rawResponse)
        const llmSelection = llmSelectionSchema.parse(parsed)
        const selection = toSelection(llmSelection)
        const errors = validateSelection(selection, input)
        validationResult = { ok: errors.length === 0, errors }

        if (errors.length === 0) {
          options.onAttempt?.({
            attemptNumber,
            model,
            promptHash,
            rawResponse,
            validationResult,
            latencyMs: Date.now() - startedAt,
          })
          return { selection, generationMode: "ai", modelUsed: model, attempts: attemptNumber }
        }
      }
    } catch (err) {
      validationResult = { ok: false, errors: [err instanceof Error ? err.message : String(err)] }
    }

    options.onAttempt?.({
      attemptNumber,
      model,
      promptHash,
      rawResponse,
      validationResult,
      latencyMs: Date.now() - startedAt,
    })

    if (attemptNumber < maxAttempts) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attemptNumber - 1))
    }
  }

  const selection = fallbackSelection(input)
  return { selection, generationMode: "fallback", modelUsed: null, attempts: maxAttempts }
}
