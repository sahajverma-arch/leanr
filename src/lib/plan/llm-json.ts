/**
 * Pulls the JSON object out of a model reply. Tolerant on purpose: the
 * prompts ask for JSON only, but a model may still wrap it in a ```json
 * fence or a sentence, and that is not worth failing an attempt over. The
 * result is always Zod-validated by the caller, so nothing here is trusted.
 *
 * Its own file (not anthropic-client.ts) so it is unit-testable: that file
 * validates server env at module load.
 */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model response")
  return JSON.parse(raw.slice(start, end + 1))
}
