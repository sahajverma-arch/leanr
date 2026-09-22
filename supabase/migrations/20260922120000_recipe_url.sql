-- The public recipe page a client can open from their downloaded plan PDF.
--
-- Source: src/db/seed-data/recipe_links.csv, a committed export of the
-- dietitian-maintained "recipe hyperlink" workbook (see
-- scripts/extract-recipe-links.ts and src/lib/foods/recipe-links.ts).
--
-- Presentation metadata, not nutrition. Nothing downstream reads this
-- column for a number: it never reaches recipe-balancer.ts, recipe-
-- validate.ts, a target, or any macro figure, and it is deliberately NOT
-- snapshotted onto diet_plan_recipe_items the way the per-100g columns are
-- — a corrected or moved recipe URL should take effect on every plan
-- immediately, which is the opposite of what the macro snapshot exists to
-- guarantee. Same reasoning recipes.unit_label already gets in
-- recipe-view-adapter.ts.
--
-- Nullable, and an unlinked recipe is the ordinary case rather than a gap:
-- the workbook carries a URL for roughly half the catalogue and explicitly
-- marks 145 further dishes with "-" ("checked, no recipe page exists"). A
-- recipe with no link renders exactly as it does today.
alter table recipes
  add column if not exists recipe_url text;

comment on column recipes.recipe_url is
  'Public recipe page for this dish, from the dietitian-maintained hyperlink workbook. Display metadata only — never read by any nutrition calculation, and read live rather than snapshotted onto a plan.';
