-- A protein supplement prescribed at review time. Its protein and calories
-- are subtracted from what the food plan must supply, so a client taking a
-- scoop of whey is not also given a full day of food protein on top.
--
-- Attached to the roadmap and never mutating it — the same shape as
-- roadmap_overrides, which already records a dietitian's review-time decision
-- this way.
create table if not exists roadmap_supplements (
  id uuid primary key default gen_random_uuid(),
  roadmap_id uuid not null unique references roadmaps(id) on delete cascade,
  name text not null,
  serving_label text not null,
  servings_per_day numeric not null,
  protein_g_per_serving numeric not null,
  kcal_per_serving numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table roadmap_supplements is
  'One prescribed protein supplement per roadmap. Protein and kcal are subtracted from the food target before generation.';
comment on column roadmap_supplements.roadmap_id is
  'Unique: confirmed scope is exactly one protein supplement per client.';

-- Snapshot of the supplement as it stood when a plan was generated. Not a
-- live join: editing the prescription later must not rewrite what an already
-- approved plan told the client to take.
alter table diet_plans add column if not exists supplement jsonb;

comment on column diet_plans.supplement is
  'Supplement in force at generation time, snapshotted. Null = none prescribed.';

-- Staff-only, matching every other table in this schema (CLAUDE.md "Auth").
alter table roadmap_supplements enable row level security;

-- drop-then-create so the migration is safely re-runnable; Postgres has no
-- "create policy if not exists".
drop policy if exists "fitelo staff can read roadmap_supplements" on roadmap_supplements;
create policy "fitelo staff can read roadmap_supplements"
  on roadmap_supplements for select
  using (auth.jwt() ->> 'email' like '%@fitelo.co');

drop policy if exists "fitelo staff can write roadmap_supplements" on roadmap_supplements;
create policy "fitelo staff can write roadmap_supplements"
  on roadmap_supplements for all
  using (auth.jwt() ->> 'email' like '%@fitelo.co')
  with check (auth.jwt() ->> 'email' like '%@fitelo.co');
