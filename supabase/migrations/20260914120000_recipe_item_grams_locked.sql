-- A dietitian-set quantity on one plan item.
--
-- Every recipe-engine edit (delete an item, add one, swap one) re-balances
-- the WHOLE day, because recipe-balancer.ts solves a day at once. That is
-- exactly what makes a hand-set quantity fragile: type "3 rotis", and the
-- next re-balance optimises it straight back to whatever the solver prefers.
--
-- So a hand-set quantity is LOCKED. The balancer holds that item's grams
-- fixed and re-optimises everything else in the day around it, which is what
-- a dietitian actually means by "make it three rotis" — the number stands,
-- and the rest of the day absorbs it. Unlocking hands the item back to the
-- solver.
--
-- Default false: every gram written by generation is solver-owned, exactly
-- as before this column existed.
alter table diet_plan_recipe_items
  add column if not exists grams_locked boolean not null default false;

comment on column diet_plan_recipe_items.grams_locked is
  'True when a dietitian set this quantity by hand. The balancer holds it fixed and re-optimises the rest of the day around it.';
