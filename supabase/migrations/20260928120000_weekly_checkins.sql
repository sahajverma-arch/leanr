-- The dietitian's weekly follow-up with a client, filled in BEFORE the next
-- week's plan is generated. Week 1 comes from the full counselling; every
-- later week needs a submitted check-in for that week first (enforced in
-- /api/plan/generate, not only by the UI).
--
-- Keyed on (client, week) rather than on a roadmap: a roadmap can be
-- recomputed mid-programme, and the client's week 3 is still week 3.
--
-- The answers are recorded for the dietitian. They never change a target by
-- themselves and no model reads them; the dietitian sets the week's numbers
-- on the same page with the existing week-target editor.
create table if not exists weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  week_number integer not null check (week_number >= 2),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  answers jsonb not null default '{}'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  constraint weekly_checkins_client_week_unique unique (client_id, week_number)
);

comment on table weekly_checkins is
  'Weekly follow-up answers (weight, energy, sleep, adherence...) recorded before generating that week''s plan. Week 2 onward only.';

-- Staff-only, matching every other table in this schema (CLAUDE.md "Auth").
alter table weekly_checkins enable row level security;

drop policy if exists "fitelo staff can read weekly_checkins" on weekly_checkins;
create policy "fitelo staff can read weekly_checkins"
  on weekly_checkins for select
  using (auth.jwt() ->> 'email' like '%@fitelo.co');

drop policy if exists "fitelo staff can write weekly_checkins" on weekly_checkins;
create policy "fitelo staff can write weekly_checkins"
  on weekly_checkins for all
  using (auth.jwt() ->> 'email' like '%@fitelo.co')
  with check (auth.jwt() ->> 'email' like '%@fitelo.co');
