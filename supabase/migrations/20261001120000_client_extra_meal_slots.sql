-- Optional wake-up drink and bedtime meals (src/lib/plan/extra-meal-slots.ts).
-- The dietitian ticks them in the review page's Meal routine card; generation
-- writes each ticked one as an EMPTY meal on every day, for the dietitian to
-- fill with "+ add" on the plan page. They are never shown to the model.
--
-- On client_fixed_menus because that row already IS the client's meal routine
-- (one per client, kept across roadmap recomputes), and the extras apply to
-- both a regular and a "same food on all days" client.
alter table client_fixed_menus
  add column if not exists extra_slots text[] not null default '{}';

comment on column client_fixed_menus.extra_slots is
  'Optional meals added to every day as empty slots: wake_up, bedtime. Validated in code (extra-meal-slots.ts).';
