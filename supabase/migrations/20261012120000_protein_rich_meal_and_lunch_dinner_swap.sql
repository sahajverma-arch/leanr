-- Phase two of the meal structure (2026-10-12). See CLAUDE.md "Meal balance:
-- equal main meals, one dal or sabzi, protein-rich meal, lunch/dinner swap".
--
-- 1. The protein-rich meal. The dietitian picks breakfast, lunch or dinner on
--    the review page's Meal routine card. On client_fixed_menus because that
--    row already IS the client's meal routine (one per client, kept across
--    roadmap recomputes) — the same reasoning extra_slots used. Null = none.
alter table client_fixed_menus
  add column if not exists protein_rich_slot text;

alter table client_fixed_menus drop constraint if exists client_fixed_menus_protein_rich_slot_check;
alter table client_fixed_menus add constraint client_fixed_menus_protein_rich_slot_check
  check (protein_rich_slot is null or protein_rich_slot in ('breakfast', 'lunch', 'dinner'));

comment on column client_fixed_menus.protein_rich_slot is
  'The main meal the dietitian wants protein-rich: breakfast, lunch or dinner. Null = none. See recipe-meal-balance.ts.';

-- 2. Snapshotted onto the plan at generation, like supplement and
--    target_override: a later change on the review page must not re-aim an
--    existing plan's edits.
alter table diet_plans
  add column if not exists protein_rich_slot text;

comment on column diet_plans.protein_rich_slot is
  'The protein-rich meal in force when this plan was generated (snapshot). Null = none.';

-- 3. The plan page's lunch <-> dinner swap moves a day's two plates (and their
--    notes) between the slots. The flag records that it happened, so a later
--    edit re-balances that day with the protein-rich meal where its food now
--    is, not where it was generated. Toggled on every swap.
alter table diet_plan_days
  add column if not exists lunch_dinner_swapped boolean not null default false;

comment on column diet_plan_days.lunch_dinner_swapped is
  'True when the dietitian swapped this day''s lunch and dinner on the plan page (an odd number of times).';
