-- A dietitian's free-text note on one meal of a generated plan: what else
-- the client needs to make or eat it ("soak the rajma overnight", "add a
-- jeera-hing tadka", "have with a glass of lukewarm water"). Shown under the
-- meal's foods on the plan page and printed in the downloaded PDF.
--
-- Per meal, i.e. one day's one slot. The plan page can copy a note to the
-- same slot on every day, which simply writes it to each of those rows.
--
-- Display text only. Never read by any nutrition calculation, and never
-- sent to a model. Validated in code (src/lib/plan/meal-note.ts): at most
-- 300 characters, and only characters the PDF's font can print.
alter table diet_plan_meals
  add column if not exists note text;

comment on column diet_plan_meals.note is
  'Dietitian''s note for this meal, printed under its foods on the plan page and PDF. Display only — never read by any nutrition calculation. Null = no note.';
