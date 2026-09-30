-- "Same food on all days": some clients want one fixed daily routine rather
-- than a week that varies. The dietitian ticks it on the review page and
-- chooses the dishes for each meal; generation then repeats that one day on
-- all 7 days, with no model call at all.
--
-- Keyed on the CLIENT, not the roadmap: a roadmap is recomputed as a new
-- snapshot, and the client's routine must not vanish when that happens. The
-- same reasoning weekly_checkins already uses.
--
-- `items` is [{ slot, recipeId, grams }]. grams null = the plan sets the
-- quantity; a number = the dietitian's exact quantity, held fixed.
-- Validated in code (fixed-menu.ts) on every write and read. Turning the tick
-- off keeps the saved dishes, so ticking it again restores them.
create table if not exists client_fixed_menus (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references clients(id) on delete cascade,
  enabled boolean not null default false,
  items jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table client_fixed_menus is
  'A client''s fixed daily menu (same food on all days), chosen by the dietitian on the review page.';

-- A fixed-menu plan is neither AI-selected nor a fallback rotation, and must
-- never be mistaken for either.
alter table diet_plans drop constraint if exists diet_plans_generation_mode_check;
alter table diet_plans add constraint diet_plans_generation_mode_check
  check (generation_mode in ('ai', 'fallback', 'fixed_menu'));

-- Staff-only, matching every other table in this schema (CLAUDE.md "Auth").
alter table client_fixed_menus enable row level security;

drop policy if exists "fitelo staff can read client_fixed_menus" on client_fixed_menus;
create policy "fitelo staff can read client_fixed_menus"
  on client_fixed_menus for select
  using (auth.jwt() ->> 'email' like '%@fitelo.co');

drop policy if exists "fitelo staff can write client_fixed_menus" on client_fixed_menus;
create policy "fitelo staff can write client_fixed_menus"
  on client_fixed_menus for all
  using (auth.jwt() ->> 'email' like '%@fitelo.co')
  with check (auth.jwt() ->> 'email' like '%@fitelo.co');
