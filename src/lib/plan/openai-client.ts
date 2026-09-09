import OpenAI from "openai"

import { env } from "@/lib/env"

/**
 * Per-request ceiling. The SDK's default is TEN MINUTES, which is
 * catastrophic behind a 60s serverless function: one slow call hangs until
 * the platform kills the whole invocation, and the caller gets a 504 with no
 * plan and no diagnosis. Observed in production — three concurrent calls
 * issued, function killed at 60.1s, nothing returned.
 *
 * 25s is chosen against the real budget: route.ts allows 60s total, DB reads
 * and the plan write need a few seconds either side, and a healthy call
 * measured 4-7s. A call still running at 25s is not going to produce a
 * usable week in time.
 */
const REQUEST_TIMEOUT_MS = 25_000

/**
 * NO SDK-level retries — deliberately, and this is the important half.
 *
 * The default is 2, which silently turns one slow request into three
 * sequential ones (with backoff) inside a budget that cannot afford even
 * two. It is also redundant here: best-of-N already issues N independent
 * attempts, and attemptWholeWeek() treats a failure as "this candidate did
 * not arrive" rather than an error. A dropped call costs one candidate, not
 * the request.
 *
 * So the LLM phase is now bounded at REQUEST_TIMEOUT_MS no matter what the
 * API does, instead of being unbounded.
 */
const MAX_RETRIES = 0

export function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  })
}

export const OPENAI_MODEL = env.OPENAI_MODEL
