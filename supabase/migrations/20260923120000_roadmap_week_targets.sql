-- A dietitian's hand-set daily target (kcal, protein, carbs) for one week,
-- entered on the review page to match what the client prefers. Replaces the
-- roadmap's computed target for that week; fat is derived as the residual in
-- code (week-target-override.ts), so it is not stored.
--
-- Attached to the roadmap and never mutating it — the same shape as
-- roadmap_overrides and roadmap_supplements.
create table if not exists roadmap_week_targets (
  id uuid primary key default gen_random_uuid(),
  roadmap_id uuid not null references roadmaps(id) on delete cascade,
  week_number integer not null,
  kcal numeric not null,
  protein_g numeric not null,
  carbs_g numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint roadmap_week_targets_roadmap_week_unique unique (roadmap_id, week_number)
);

comment on table roadmap_week_targets is
  'Dietitian-set daily target for one week of a roadmap. Replaces weekTargets() for that week; fat = (kcal - 4*protein - 4*carbs) / 9.';

-- Snapshot of the week target override in force when a plan was generated,
-- so a later edit on the review page cannot re-aim an existing plan's edits.
alter table diet_plans add column if not exists target_override jsonb;

comment on column diet_plans.target_override is
  'Week target override {kcal, proteinG, carbsG} in force at generation time, snapshotted. Null = computed target.';

-- Staff-only, matching every other table in this schema (CLAUDE.md "Auth").
alter table roadmap_week_targets enable row level security;

drop policy if exists "fitelo staff can read roadmap_week_targets" on roadmap_week_targets;
create policy "fitelo staff can read roadmap_week_targets"
  on roadmap_week_targets for select
  using (auth.jwt() ->> 'email' like '%@fitelo.co');

drop policy if exists "fitelo staff can write roadmap_week_targets" on roadmap_week_targets;
create policy "fitelo staff can write roadmap_week_targets"
  on roadmap_week_targets for all
  using (auth.jwt() ->> 'email' like '%@fitelo.co')
  with check (auth.jwt() ->> 'email' like '%@fitelo.co');
