-- Ingredient layer (TRIAL, 2026-09-15)
--
-- Lets a dietitian see and change what is actually in a dish — "make it 3 eggs
-- instead of 2" — and get an exact macro consequence.
--
-- Purely additive. No existing table is altered and no existing column is
-- touched, so the whole trial is removed by the DROP block at the bottom of
-- this file and nothing else. That is deliberate: this is on trial.
--
-- Nothing here changes any nutrition figure that is live today. A recipe's
-- stored per-100g stays exactly as it is; re-basing its batch to one portion
-- reproduces that same figure arithmetically (see ingredient-edit.ts), so this
-- layer is inert until somebody actually edits an ingredient.
--
-- Populated by `npm run seed:ingredients`, which admits ONLY recipes measured
-- as clean. A recipe with no rows here simply offers no ingredient breakdown.

-- One row per distinct ingredient, with verified per-100g nutrition.
create table if not exists ingredients (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  carbs_per_100g    numeric not null,
  protein_per_100g  numeric not null,
  fat_per_100g      numeric not null,
  fiber_per_100g    numeric not null,
  -- The source's own stated kcal. Deliberately NOT generated, unlike
  -- recipes.kcal_per_100g: recipe totals were built from this value, so
  -- replacing it would break the reconciliation that admits a recipe.
  kcal_per_100g     numeric not null,
  -- Atwater from this row's own macros, so the disagreement is queryable
  -- rather than invisible. 26 of 377 ingredients differ by >10%.
  kcal_atwater      numeric not null generated always as (
                      round(protein_per_100g * 4 + carbs_per_100g * 4 + fat_per_100g * 9, 2)
                    ) stored,
  usage_count       integer not null default 0,
  -- Non-null holds every recipe using this ingredient out of the trial.
  quarantine_reason text,
  created_at        timestamptz not null default now()
);

-- What ONE unit weighs: "1 onion = 150 g", "1 tsp oil = 5 g".
create table if not exists ingredient_units (
  id             uuid primary key default gen_random_uuid(),
  ingredient_id  uuid not null references ingredients (id) on delete cascade,
  unit           text not null,
  grams_per_unit numeric not null,
  unique (ingredient_id, unit)
);

-- One ingredient line of one recipe, at BATCH scale exactly as the source
-- states it. Re-basing to a portion happens in code at read time.
create table if not exists recipe_ingredients (
  id             uuid primary key default gen_random_uuid(),
  recipe_id      uuid not null references recipes (id) on delete cascade,
  ingredient_id  uuid not null references ingredients (id),
  kind           text not null check (kind in ('piece', 'measure', 'direct')),
  quantity       numeric not null check (quantity >= 0),
  unit           text,
  grams_per_unit numeric,
  grams          numeric not null check (grams >= 0),
  display_order  integer not null,
  unique (recipe_id, ingredient_id)
);

create index if not exists recipe_ingredients_recipe_id_idx
  on recipe_ingredients (recipe_id);

-- Per-recipe scaling constants, plus the audit numbers that admitted it.
create table if not exists recipe_ingredient_profiles (
  recipe_id          uuid primary key references recipes (id) on delete cascade,
  servings           numeric not null check (servings > 0),
  portion_grams      numeric not null check (portion_grams > 0),
  raw_batch_grams    numeric not null check (raw_batch_grams > 0),
  -- (servings * portion_grams) / raw_batch_grams. Estimated, not measured:
  -- it absorbs cooking water and un-itemised salt, spices and water.
  yield_factor       numeric not null check (yield_factor > 0),
  reconciliation_gap numeric not null,
  created_at         timestamptz not null default now()
);

-- Same posture as every other table in this schema: staff-only, enforced by
-- the same company-domain claim the rest of the app uses. These tables carry
-- no client data, but an unprotected table is still an unprotected table.
alter table ingredients                enable row level security;
alter table ingredient_units           enable row level security;
alter table recipe_ingredients         enable row level security;
alter table recipe_ingredient_profiles enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ingredients', 'ingredient_units', 'recipe_ingredients', 'recipe_ingredient_profiles'
  ] loop
    execute format(
      'create policy %I on %I for select to authenticated using (auth.jwt() ->> ''email'' like ''%%@fitelo.co'')',
      t || '_select_fitelo', t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- TO REMOVE THIS TRIAL ENTIRELY, run:
--
--   drop table if exists recipe_ingredient_profiles;
--   drop table if exists recipe_ingredients;
--   drop table if exists ingredient_units;
--   drop table if exists ingredients;
--
-- then delete src/lib/foods/recipe-calculation-parser.ts,
-- src/lib/plan/ingredient-edit.ts, src/db/seed-ingredients.ts,
-- src/db/seed-data/recipe_ingredients.csv, their tests, and the
-- INGREDIENT LAYER block in src/db/schema.ts. Nothing else references it.
-- ---------------------------------------------------------------------------
