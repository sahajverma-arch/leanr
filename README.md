# LEANR — Diet Platform

Internal dietitian tool for Fitelo. Staff-only. Counselling intake → deterministic roadmap → exchange-list diet plan.

## THE ONE RULE THAT MATTERS

**The LLM never calculates nutrition. The LLM never sees a calorie or macro target.**

Numbers come from two deterministic places only:

1. `src/lib/counselling/` — energy, BMI, roadmap, macros, protein ramp. Pure functions, zero I/O, zero randomness.
2. `src/lib/plan/exchange-solver.ts` — converts week targets into integer/half-integer exchange counts using Table 4.1 constants.

The LLM (`src/lib/plan/food-selector.ts`, called from `POST /api/plan/generate`) does exactly one job: **given a list of exchange slots and a filtered list of eligible foods, pick which named food fills each slot.** It returns food IDs. Nothing else. Macros are then recomputed from exchange counts × Table 4.1 and validated (`src/lib/plan/quantity.ts`) — a plan is never written to the database until that validation passes.

If you're about to write a prompt that asks a model to "calculate calories" or "make sure it adds up to N kcal" — stop. That is the bug this architecture exists to prevent. See `CLAUDE.md` for the full governance doc.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Counselling intake (332-question bank, quick/full)                 │
│  src/lib/counselling/questions.ts, quick-intake.ts                  │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ Answers (jsonb)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Deterministic roadmap engine — pure functions, zero I/O            │
│  src/lib/counselling/{energy,anthropometry,strategy,macros,         │
│  protein-ramp,roadmap}.ts                                           │
│  BMR → TDEE → BMI/target weight → calorie strategy (4 categories)   │
│  → macros → protein ramp                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ RoadmapResult (immutable snapshot, jsonb)
                                ▼
                     Review page — dietitian checks
                     the math, records overrides on
                     block-level flags before proceeding
                                │
                                │ weekTargets(roadmap, N) → daily Macros
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Exchange solver — pure, no AI                                      │
│  src/lib/plan/exchange-solver.ts + table-4-1.ts                     │
│  daily Macros → integer/half-integer counts per exchange type       │
│  (Table 4.1: milk_cow, milk_skim, meat, meat_lean, pulse, cereal,   │
│  vegetable_a, vegetable_b, fruit, fat, sugar)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ ExchangeCounts
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Meal distributor — pure                                            │
│  src/lib/plan/meal-distributor.ts                                   │
│  splits counts across meal-template slots by kcal_share —           │
│  meat/meat_lean/milk_cow/milk_skim: whole day, one slot              │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ Skeleton (per-slot exchange needs)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Eligible-foods filter — pure                                       │
│  src/lib/plan/eligible-foods.ts                                     │
│  region / diet type / allergens / dislikes / medical tags / season  │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ pre-filtered candidates only
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Food selector — THE ONLY PLACE AN LLM RUNS                         │
│  src/lib/plan/food-selector.ts (Claude API)                         │
│  picks food IDs to fill slots · never sees a calorie/macro number   │
│  3 attempts + backoff → deterministic round-robin fallback          │
└──────────────────────────────┬──────────────────────────────────────┘
                                │ food IDs only
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Quantity + validation — pure                                       │
│  src/lib/plan/quantity.ts                                           │
│  grams from exchange count × food.servingRawG · macros recomputed   │
│  from exchange counts × Table 4.1 (never from the LLM) · <1.5%      │
│  deviation asserted before any DB write                             │
└──────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
              diet_plans / diet_plan_days / diet_plan_meals /
              diet_plan_items (Postgres, RLS-protected)
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          /plans/[id] (web view,   /api/plans/[id]/pdf
          inline food-swap edit)   (@react-pdf/renderer,
                                    same layout, same data)
```

## Stack

- Next.js 14 App Router + TypeScript (strict). Server Actions for mutations, Route Handlers for anything the AI touches (Node runtime, not edge — long timeouts).
- Supabase: Postgres + Auth (Google OAuth, `@fitelo.co` only) + RLS. Drizzle ORM.
- Claude API (Anthropic) for the LLM calls — it only ever names foods or recipes, never a number.
- Tailwind + shadcn/ui (Base UI, not Radix). `@react-pdf/renderer` for PDF export. `recharts` for the macro-split donut.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in Supabase + Anthropic credentials
npm run dev
```

Apply migrations in `supabase/migrations/` (timestamped, forward-only) to your Supabase project in order, then:

```bash
npm run seed:foods   # exchange_types (Table 4.1) + foods + meal_templates
npm run seed:demo    # four demo clients matching the golden worked examples, each with a week-1 plan
```

Sign-in is restricted to `@fitelo.co` Google accounts, enforced in three places: the OAuth `hd` hint, a Postgres trigger on `auth.users`, and RLS policies checking `auth.jwt() ->> 'email'`. See `src/db/rls-audit.test.ts` for the live check that an anon key reads zero rows anywhere.

## Testing

```bash
npm run verify   # typecheck + lint + test — the pre-deploy gate (vercel.json)
```

Every function in `src/lib/counselling/` and `src/lib/plan/` has a Vitest unit test. `src/lib/counselling/roadmap.test.ts` and `src/lib/plan/exchange-solver.test.ts` are golden-file tests reproducing four real worked examples (TEST-001 Priya, TEST-002 Rahul, TEST-003 Sneha, TEST-004 Aadi) — if a figure drifts, the build fails. Do not edit a golden-file expectation to make a test pass; fix the code or ask.

`src/db/rls-audit.test.ts` is a live network test against the real Supabase project (anon key, asserts zero rows on every table) — it self-loads `.env.local` and skips cleanly if credentials aren't available, so `npm test` stays runnable without them.

## How to add a region

All 8 `REGIONS` (`src/lib/foods/vocab.ts`) have real seeded food + meal-template data today. To add a new one:

1. Add a migration inserting 5 `meal_templates` rows for the region (`breakfast`/`mid_morning`/`lunch`/`evening`/`dinner`, `meal_count = 5`) — copy the shape from `supabase/migrations/20260808200000_classic_table41_exchange_system.sql`'s existing rows, adjusting `time_hint`/`kcal_share`/`allowed_exchange_types` if the region's meal pattern differs.
2. Add food rows to `src/db/seed-data/table41_foods.json` tagged with the new region in `regions: [...]` (or add the region to an existing `"generic"` food if it applies everywhere), then run `npm run seed:foods` (idempotent — safe to re-run).
3. Run the coverage check every (`region`, `slot`, `exchangeType`, `dietType`) combination the meal templates actually allow has at least one eligible food — see the approach in `src/lib/plan/eligible-foods.ts`'s filter pipeline; a gap here surfaces at generation time as `NoEligibleFoodsError`, not silently.
4. Add the region to `SEEDED_REGIONS` in `src/components/review/actions-bar.tsx` and to the picker in `src/components/plan/plan-actions-bar.tsx` if it needs its own generate-flow entry point (only regions with seeded templates should appear there).

## How to add foods

Either through the `/foods` admin page (`src/app/(app)/foods/`) or by adding a row to `src/db/seed-data/table41_foods.json` and running `npm run seed:foods`. Every food needs:

- `exchangeType` — one of the 11 Table 4.1 rows (`milk_cow`, `milk_skim`, `meat`, `meat_lean`, `pulse`, `cereal`, `vegetable_a`, `vegetable_b`, `fruit`, `fat`, `sugar`). This fixes the food's macros — never store macros on the food row itself.
- `servingRawG` + `exchangeUnits` — grams per `exchangeUnits` exchanges of that type. `servingRawG` is nullable **only** for `fruit` (Table 4.1 defines fruit's raw amount as variable; `householdMeasure` carries the real portion instead).
- `regions`, `dietTypes`, `mealSlots` — arrays; a food needs `"generic"` in `regions` to be eligible everywhere, and must list every slot it can appear in (a meal template allowing an exchange type at a slot is not enough — the food itself must also allow that slot, checked in `eligible-foods.ts`).
- `allergens` — must match `src/lib/foods/vocab.ts`'s `ALLERGENS` vocabulary to be excludable by intake-answer allergies (see `src/lib/plan/client-profile-from-answers.ts`'s slug mapping).
- `seasons` — optional, defaults to `["all_year"]`. Only tag a food with `summer`/`monsoon`/`winter` when you have an actual claim behind it (a real dietitian source, not a guess) — see CLAUDE.md "Seasonal eligibility". Most foods should stay untagged.

Region-specific display names for the same exchange (Roti/Poli, Ghee/Toop, etc.) are separate alias rows with identical exchange arithmetic, not a translation layer — see CLAUDE.md "The exchange system".

## How to bump the engine version

Bump `ENGINE_VERSION` in `src/lib/counselling/roadmap.ts` whenever a formula in `src/lib/counselling/` changes (a coefficient, a threshold, a new guardrail flag). Roadmap snapshots (`roadmaps.engine_version`) are immutable and store the version they were computed under, so old snapshots stay correctly interpretable — recomputing a roadmap always inserts a new row (`recomputeRoadmap` in `src/app/(app)/sessions/[sessionId]/review/actions.ts`), it never updates one in place. Update the golden-file tests in `roadmap.test.ts` only if the real worked examples' own published numbers changed — never to make a formula change "pass".

## Observability

`/settings/generation-log` shows every LLM attempt behind plan generation (session, model, latency, validation result, linked plan) — `plan_generation_runs` is written independent of whether the overall generation succeeds, specifically so a blocked/failed generation still leaves an audit trail. `POST /api/plan/generate` is rate-limited per user (Postgres counter, `plan_generation_requests` — see `src/lib/plan/rate-limit.ts`; no Redis/Upstash is configured for this project).

## Deploy

`vercel.json` wires `npm run verify` as the build command's pre-deploy gate — a broken typecheck/lint/test never reaches a live deploy.
