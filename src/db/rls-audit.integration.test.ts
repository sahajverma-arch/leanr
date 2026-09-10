/**
 * Prompt 9 hardening #1: an anon-key client must read zero rows from every
 * staff-only table. This is a live network test against the real Supabase
 * project (not the hermetic unit suite everything else in src/lib is), so
 * it self-loads .env.local when the vars aren't already in the
 * environment and skips cleanly rather than failing when neither is
 * available (e.g. a contributor's machine before `.env.local` exists, or a
 * CI job that never got secrets) — `npm test` must stay runnable without
 * credentials, but this file should run for real whenever they exist.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { describe, expect, it } from "vitest"

function loadEnvLocalIfMissing() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) return
  const path = join(process.cwd(), ".env.local")
  if (!existsSync(path)) return
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
}
loadEnvLocalIfMissing()

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

/**
 * These are live cross-region HTTPS round trips (a Vercel build runs in
 * iad1 while this project's Supabase is in ap-northeast-1), not hermetic
 * unit tests, so vitest's 5s default is far too tight: a real Vercel build
 * failed with exactly two of the twenty tables timing out while the other
 * eighteen passed. The assertions are unchanged — only the patience is.
 */
const NETWORK_TEST_TIMEOUT_MS = 30_000

// Every table in src/db/schema.ts that carries staff/client data or
// reference data — CLAUDE.md: "Staff-only. " Nothing here should ever be
// readable by an unauthenticated key, including the food/exchange
// reference tables.
const TABLES = [
  "profiles",
  "clients",
  "counselling_sessions",
  "roadmaps",
  "roadmap_overrides",
  "roadmap_supplements",
  "exchange_types",
  "foods",
  "meal_templates",
  "diet_plans",
  "diet_plan_days",
  "diet_plan_meals",
  "diet_plan_items",
  "plan_generation_runs",
  "plan_generation_requests",
  "dish_families",
  "meal_archetypes",
  "archetype_components",
  "dish_combinations",
  "vegetable_dish_combinations",
  "vegetable_dish_combination_members",
]

describe.skipIf(!url || !anonKey)("RLS audit — anon key reads zero rows on every table", () => {
  const anon = createClient(url ?? "", anonKey ?? "")

  for (const table of TABLES) {
    it(
      `${table}`,
      async () => {
        const { data, error } = await anon.from(table).select("*").limit(1)
        // RLS denial can surface as either an empty result set or an explicit
        // permission error, depending on the policy shape — both mean "zero
        // rows readable", which is the only thing this test asserts.
        if (error) {
          expect(error).toBeTruthy()
        } else {
          expect(data).toEqual([])
        }
      },
      NETWORK_TEST_TIMEOUT_MS
    )
  }
})

const databaseUrl = process.env.DATABASE_URL

/**
 * The anon-key test above proves the CURRENT deployed behaviour; this
 * proves the policy DEFINITIONS are actually what CLAUDE.md's auth model
 * claims — reading pg_policies directly (read-only, no live behavioural
 * dependency) so a future migration that adds a table, or a policy that's
 * broader than intended, fails this test even before the anon-key check
 * would ever see live data. Cannot test an authenticated-but-non-@fitelo.co
 * *user* directly: the Postgres trigger in
 * 20260807120000_init_auth_profiles.sql rejects that email domain at
 * auth.users insert, so such a user structurally cannot exist to sign in
 * as — this is layer 2 of CLAUDE.md's 3-layer defense, verified once live
 * via the Admin API during Prompt 9 hardening (not repeated here as an
 * automated test, since it would perform a real write against Supabase
 * Auth on every test run).
 */
describe.skipIf(!databaseUrl)("RLS audit — every policy's SQL actually checks the fitelo.co domain", () => {
  it("every table has at least one policy, and every policy's USING/WITH CHECK mentions fitelo.co", async () => {
    const sql = postgres(databaseUrl ?? "", { prepare: false })
    try {
      interface PolicyRow {
        tablename: string
        policyname: string
        qual: string | null
        withCheck: string | null
      }

      const policies = await sql<PolicyRow[]>`
        select tablename, policyname, qual, with_check as "withCheck"
        from pg_policies
        where schemaname = 'public' and tablename = any(${TABLES})
      `

      const byTable = new Map<string, PolicyRow[]>()
      for (const p of policies) {
        const list = byTable.get(p.tablename) ?? []
        list.push(p)
        byTable.set(p.tablename, list)
      }

      for (const table of TABLES) {
        const tablePolicies = byTable.get(table) ?? []
        expect(tablePolicies.length, `${table} has no RLS policies at all`).toBeGreaterThan(0)
        for (const p of tablePolicies) {
          const clause = `${p.qual ?? ""} ${p.withCheck ?? ""}`
          expect(clause, `${table}.${p.policyname}`).toContain("fitelo.co")
        }
      }
    } finally {
      await sql.end()
    }
  }, NETWORK_TEST_TIMEOUT_MS)
})
