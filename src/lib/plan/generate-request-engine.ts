import { REGIONS } from "@/lib/foods/vocab"
import { cuisineForTemplateRegion } from "@/lib/foods/recipe-cuisine-mapping"

/**
 * Decides which engine an incoming /api/plan/generate body asks for.
 *
 * Extracted from route.ts's request schema so it can be unit-tested: that
 * file imports the DB, env validation and both engines, so nothing in it is
 * reachable from a plain Vitest run. Same separation as
 * recipe-day-diagnosis.ts and recipe-week-score.ts.
 *
 * WHY THIS MATTERS ENOUGH TO EXTRACT. The rule used to be "no `engine` field
 * means exchange", written when the recipe engine was new and flagged off.
 * Both UI callers omit the field, so RECIPE_ENGINE_ENABLED could be true in
 * production while the exchange engine kept running — silently, with no
 * error and no log line saying so. It cost a day of debugging the wrong
 * engine. A behaviour that decides which of two pipelines runs should not
 * live untested inside a Zod preprocess.
 */
export function applyEngineDefault(body: unknown, recipeEngineEnabled: boolean): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const raw = body as Record<string, unknown>

  // An explicit engine always wins — a caller can still ask for either by name.
  if ("engine" in raw) return raw

  if (!recipeEngineEnabled) return { ...raw, engine: "exchange" }

  // The UI only sends `region`; the recipe engine speaks in cuisines.
  // Anything unrecognised falls back to "General", which is always eligible,
  // so a region can never resolve to an empty recipe pool.
  const region = REGIONS.find((r) => r === raw.region)
  return {
    ...raw,
    engine: "recipe",
    cuisine: region ? cuisineForTemplateRegion(region) : "General",
  }
}
