/**
 * The one place this codebase talks to Claude. Both selectors (recipe and
 * exchange) and the dev scripts go through callClaude(), so there is a
 * single definition of the request: model, effort, deadline, refusal
 * handling, and how the reply text is read.
 *
 * Replaced openai-client.ts on 2026-11-17. THE ONE RULE is unaffected by
 * the provider: the model still only names recipes / food IDs, and every
 * number is computed and validated in code afterward.
 */

import Anthropic from "@anthropic-ai/sdk"

import { env } from "@/lib/env"

/**
 * Hard wall-clock ceiling for ONE model call, retries included.
 *
 * Enforced with our own AbortController rather than the SDK's `timeout`
 * alone: on a streaming request the SDK's timer only covers the wait for
 * the response to START, so a stream that opens and then stalls would
 * otherwise be unbounded.
 *
 * 90s, up from the 25s the OpenAI client used. Claude thinks before it
 * answers (thinking cannot be switched off on the default model), so a
 * week of ~30k input tokens takes longer than the 4-10s measured on
 * gpt-5.4-mini. NOT YET MEASURED on a real run — tune this, and
 * ANTHROPIC_EFFORT, against real latency. The budget it has to fit:
 * route.ts allows 300s; best-of-N runs its calls concurrently (one
 * deadline, not N), and the exchange selector's 3 sequential attempts are
 * 270s worst case.
 */
const CALL_DEADLINE_MS = 90_000

/**
 * SDK retries are back ON (the OpenAI client had 0), because the reason for
 * 0 no longer applies: retries used to be unbounded in time, and they now
 * all happen inside CALL_DEADLINE_MS. What they buy is real — a 429 or a
 * 529 "overloaded" is retried after the server's own retry-after instead of
 * costing a best-of-N candidate, which matters when N concurrent ~30k-token
 * calls land on a low rate tier at once.
 */
const MAX_RETRIES = 2

/**
 * Room for thinking plus the reply — thinking tokens count toward this even
 * though their text is not returned. The reply itself (a week of dish
 * names) is ~2-3k tokens.
 */
const MAX_TOKENS = 32_000

/**
 * Refusal fallback: if a safety classifier declines the request on the
 * configured model, the API re-runs it on the model Anthropic recommends
 * instead of returning nothing. A diet plan should never trip one, but a
 * false positive would otherwise fail a generation for no visible reason.
 * callClaude() returns the model that ACTUALLY answered, so a plan row never
 * names a model that did not compose it.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01"

export const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL

export function createAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: CALL_DEADLINE_MS,
    maxRetries: MAX_RETRIES,
  })
}

/** Structurally the same as recipe-prompt.ts's PromptMessage; declared here so this file imports nothing from the prompt builders. */
export interface ClaudePromptMessage {
  role: "system" | "user"
  content: string
}

export interface ClaudeCallResult {
  /** The reply's text, or null if the model returned no text block. */
  rawResponse: string | null
  /** The model that produced the reply — differs from ANTHROPIC_MODEL only when a refusal fallback ran. */
  model: string
  latencyMs: number
}

/**
 * One request, one reply. Throws on anything that is not a complete answer
 * (deadline, refusal, truncation, API error); every caller already treats a
 * thrown error as "this attempt failed" and logs its message.
 *
 * No `temperature`: current Claude models reject it. Sample-to-sample
 * variety comes from the seeded rotation in the prompt itself
 * (recipe-week-rotation.ts), which was already the mechanism that made
 * best-of-N attempts differ.
 */
export async function callClaude(messages: readonly ClaudePromptMessage[]): Promise<ClaudeCallResult> {
  const client = createAnthropicClient()
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
  const userMessages = messages.filter((m) => m.role === "user").map((m) => ({ role: "user" as const, content: m.content }))

  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), CALL_DEADLINE_MS)
  const startedAt = Date.now()

  try {
    // Streamed, then collected: a long request held open with no bytes
    // flowing is what proxies and platforms drop.
    const message = await client.beta.messages
      .stream(
        {
          model: ANTHROPIC_MODEL,
          max_tokens: MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: userMessages,
          output_config: { effort: env.ANTHROPIC_EFFORT },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal: controller.signal }
      )
      .finalMessage()

    // Checked BEFORE reading content: a refusal arrives as a normal 200 with
    // empty or partial content, and a truncated reply is not a week.
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category
      throw new Error(`Claude declined the request${category ? ` (${category})` : ""}.`)
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error(`Claude's reply was cut off at max_tokens (${MAX_TOKENS}).`)
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")

    return { rawResponse: text.length > 0 ? text : null, model: message.model, latencyMs: Date.now() - startedAt }
  } catch (err) {
    // The SDK reports our own abort as a bare "Request was aborted." — say
    // what actually happened, since this message is what the generation log
    // and the dietitian-facing error carry.
    if (controller.signal.aborted) {
      throw new Error(`Claude call exceeded ${CALL_DEADLINE_MS / 1000}s and was cancelled.`)
    }
    throw err
  } finally {
    clearTimeout(deadline)
  }
}
