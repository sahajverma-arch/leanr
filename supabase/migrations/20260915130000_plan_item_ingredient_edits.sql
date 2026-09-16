-- Per-plan-item ingredient edits (TRIAL, 2026-09-15)
--
-- Companion to 20260915120000_ingredient_layer_trial.sql. That migration added
-- the read-only ingredient data; this one lets a dietitian change it on ONE
-- item of ONE plan.
--
-- Only edited ingredients get a row. An untouched item stores nothing here and
-- renders exactly as it did before the layer existed.
--
-- Per plan item, never global: editing a dish for this client must not reach
-- into anyone else's plan. Same rule diet_plan_recipe_items' macro snapshots
-- already enforce for nutrition.

create table if not exists diet_plan_recipe_item_ingredients (
  id                        uuid primary key default gen_random_uuid(),
  diet_plan_recipe_item_id  uuid not null references diet_plan_recipe_items (id) on delete cascade,
  ingredient_id             uuid not null references ingredients (id),
  -- In the ingredient's own unit: pieces for an egg, tsp for ghee, grams for a
  -- gram-measured ingredient. 0 means the dietitian removed it from the dish.
  quantity                  numeric not null check (quantity >= 0),
  created_at                timestamptz not null default now(),
  unique (diet_plan_recipe_item_id, ingredient_id)
);

create index if not exists diet_plan_recipe_item_ingredients_item_idx
  on diet_plan_recipe_item_ingredients (diet_plan_recipe_item_id);

alter table diet_plan_recipe_item_ingredients enable row level security;

create policy diet_plan_recipe_item_ingredients_select_fitelo
  on diet_plan_recipe_item_ingredients for select to authenticated
  using (auth.jwt() ->> 'email' like '%@fitelo.co');

create policy diet_plan_recipe_item_ingredients_write_fitelo
  on diet_plan_recipe_item_ingredients for all to authenticated
  using (auth.jwt() ->> 'email' like '%@fitelo.co')
  with check (auth.jwt() ->> 'email' like '%@fitelo.co');

-- ---------------------------------------------------------------------------
-- TO REMOVE: drop table if exists diet_plan_recipe_item_ingredients;
-- Items edited before the drop keep their adjusted macro snapshots, which stay
-- internally consistent (grams x per-100g) — they simply lose the record of
-- WHY they differ from the base recipe. Re-generating the week clears it.
-- ---------------------------------------------------------------------------
