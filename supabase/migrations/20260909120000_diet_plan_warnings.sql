-- The recipe engine's best-of-N path now saves its nearest week instead of
-- rejecting it, so the dietitian decides whether it is usable. That is only
-- safe if they can see WHAT is off — previously the generation warnings were
-- returned in the API response and then discarded, displayed nowhere.
--
-- Nullable: every historical row backfills as "nothing recorded", which is
-- honest, rather than as an empty array meaning "nothing wrong".
alter table diet_plans add column if not exists warnings jsonb;

comment on column diet_plans.warnings is
  'Reasons this plan is not a clean pass (per-day macro misses, plausibility, variety, serving limits). Shown to the dietitian on the plan page. Null = not recorded.';
