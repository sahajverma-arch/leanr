# LEANR — Diet Platform

Internal dietitian tool for Fitelo. Staff-only. Counselling intake → deterministic roadmap → exchange-list diet plan.

## Stack
- Next.js 14 App Router + TypeScript (strict). Server Actions for mutations, Route Handlers for anything the AI touches.
- Supabase: Postgres + Auth (Google OAuth) + RLS. Drizzle ORM. No Prisma.
- Vercel deploy. Node runtime for AI routes (not edge — long timeouts needed).
- OpenAI for LLM calls: default `baseURL`, key `OPENAI_API_KEY`, model from `OPENAI_MODEL` env var. Replaced NVIDIA NIM on 2026-09-08 when a real OpenAI key became available — every historical "live NVIDIA run" note further down this file describes that retired provider and is left as written.
- Tailwind + shadcn/ui. No component library beyond that.

## THE ONE RULE THAT MATTERS

**The LLM never has final say on a number.** Whatever quantity it proposes — an exchange count, or
nothing at all — is grounded against a verified nutrition table, deterministically
rebalanced/recomputed, and validated in code before it is persisted or shown to a dietitian. Until
2026-08 this rule was stricter and simpler ("the LLM never sees a calorie or macro target at all");
it was then deliberately relaxed one level for the dish-gram engine (retired 2026-08-19, see below),
which saw a macro target and proposed grams. The recipe engine that replaced it (2026-08-19) tightens
the rule back past its original strictness: the LLM sees a *daily* target for prompting purposes, but
never proposes a gram, calorie, or macro number of any kind, ever — it only names real recipes. Every
quantity is computed and optimized entirely in code. See "The recipe engine" below.

Numbers come from three deterministic places:
1. `src/lib/counselling/` — energy, BMI, roadmap, macros, protein ramp. Pure functions, zero I/O,
   zero randomness. Upstream of both generation engines below; produces the one `WeekTargets` value
   either engine consumes.
2. `src/lib/plan/exchange-solver.ts` (the **exchange engine**, default/live) — converts week targets
   into integer/half-integer exchange counts using Table 4.1 constants, *before* the LLM ever runs.
   Here the LLM's only job is picking which named food fills an already-fixed slot count: it returns
   food IDs, nothing else, and never sees a calorie or macro number at all. See "The exchange
   system" below.
3. `src/lib/plan/recipe-*.ts` (the **recipe engine**, gated by `RECIPE_ENGINE_ENABLED`, off by
   default — see "The recipe engine") — here the LLM sees the day's macro targets for context but
   *only ever outputs recipe names*, never a gram, calorie, or macro figure. What holds instead:
   `recipe-grounding.ts` resolves every recipe name (exact → alias → fuzzy) against a verified
   per-100g nutrition table; `recipe-balancer.ts` then deterministically computes and optimizes every
   gram from scratch toward the target, hard-capped to each recipe's realistic serving range;
   `recipe-plausibility-validate.ts` and `recipe-variety-tracker.ts` check the result is a sensible,
   varied plate before `recipe-validate.ts`'s tolerance gate runs; a plan that still fails after
   retries is *rejected*, not written with a warning — see "The recipe engine" for why that's a
   deliberate departure from every prior engine's "always succeeds" guarantee.

If you ever find yourself writing a prompt that asks a model to "calculate calories", "estimate
macros", or "make sure it adds up to 1775 kcal" **and then trusting that answer directly** — stop.
That is the bug this architecture exists to prevent, on both engines. The recipe engine's prompt
telling the model the day's target is not the same bug, because the model is explicitly instructed
never to compute anything from it, and nothing downstream ever trusts the model's arithmetic even if
it tried — a prompt with no grounding/balancing/validation step after it would be the actual bug.

## The exchange system

`exchange_types` (11 rows, read-only at runtime) is the classic textbook Table 4.1 — the
Comprehensive Food Exchange List (Indian modified American exchange list):

`milk_cow · milk_skim · meat · meat_lean · pulse · cereal · vegetable_a · vegetable_b · fruit ·
fat · sugar`

This was briefly swapped for the sister `dietitian-platform` codebase's richer 12-group exchange
list during Prompt 3, on the theory that its "production-validated" data was more authoritative.
That was wrong — verified by reading three real generated diet plans (Deepak Sharma, Anjali Joshi,
Ritu Verma). Deepak's and Anjali's plans both explicitly cite "Table 4.1" and their arithmetic
proves it: `Roti (atta 100 g raw, 5 rotis)` = 5 cereal exchanges at 20 g each (not the 12-group
system's 30 g/roti), `Milk (250 ml)` = 1 exact milk_cow exchange, and the guidelines list swap
groups as "Vegetable A (100 g)" / "Vegetable B (50 g)" — a split the 12-group system doesn't have
at all. Ritu Verma's plan is a different, superseded architecture entirely (INDB/USDA
portion-matched, not exchange-solved — the sister codebase's own
`0017_remove_indb_usda_foods.sql` deleted that pipeline). Reverted to Table 4.1 for good.

A second per-100g dish-nutrition architecture was deliberately reintroduced later (2026-08, gated by
`DISH_ENGINE_ENABLED`, off by default) — for a genuinely different reason than the one rejected
above, not a quiet reversal of it. It was itself fully replaced one day later by the recipe engine —
see the retirement note at the end of this section, and "The recipe engine" further down, for that
part of the story. The INDB/USDA pipeline
existed to *portion-match* Ritu Verma's plan against a rival per-100g exchange list, competing
directly with Table 4.1 for the same job; it lost because Deepak's and Anjali's real plans proved
Table 4.1 was what dietitians actually used. The dish-gram engine isn't trying to replace Table 4.1
at that job — it exists so the LLM can compose real, complete, already-named regional dishes
(grounded against a 525-dish per-100g CSV) instead of being constrained to Table 4.1's 11 abstract
categories, an explicit, informed choice made with this exact history in hand, not a rediscovery of
it. Everything in this "The exchange system" section below is unchanged and stays the default, live
generation path — the dish engine is a parallel, flagged-off-by-default addition sitting beside it,
not a replacement of this section's history.

Each exchange type carries protein_g/carbs_g/fat_g/fiber_g per 1 exchange; kcal is always
*computed* as `protein_g*4 + carbs_g*4 + fat_g*9`, never stored/sourced independently, so it can
never drift from the macros it summarises (this generated-kcal figure sits a few kcal off Table
4.1's own printed values in a couple of rows — e.g. fruit computes to 40 kcal against the table's
45 — an artifact of the textbook's own rounding, not a bug). Two Vegetable A exchanges = one
Vegetable B exchange. Eggs and lean meat/fish map onto the `meat` (1 whole egg = 1 exchange, 40 g)
and `meat_lean` (35 g chicken/fish = 1 exchange) types respectively — confirmed against Deepak's
plan's own non-veg swap line ("1 whole egg or 35 g chicken breast / fish").

Food *display names* vary by region even when the underlying exchange is identical — Anjali's
Maharashtrian plan calls the same wheat-flour cereal exchange "Poli" instead of "Roti", ghee is
"Toop", peanuts are "Shengdana", dal is "Varan/Amti/Usal" depending on prep, sabzi is "Bhaji". The
`foods` table carries region-specific alias rows for these (same exchange arithmetic, different
`name_en`) rather than a separate name-translation layer.

### Non-veg/eggetarian floors and indivisible exchanges

`exchange-solver.ts`'s `anchorVariantTiers()` originally let a non-vegetarian or eggetarian target
solve to **zero** eggs/meat whenever a milk-and-pulse-only combination fit the macro target as
well or better — "non-vegetarian" only meant meat/meat_lean were *permitted*, never *required*
(`cost()` only ever minimises macro deviation, with no preference for actually including animal
protein). Fixed by excluding the all-zero `{meat: 0, meat_lean: 0}` anchor from non-vegetarian's
candidate list, and the `meat: 0` anchor from eggetarian's, so the cost search can no longer land
on an animal-protein-free result — the same "hard floor" treatment vegan already got
(`VEGAN_PULSE_FLOOR`) and vegetarian already got (`meat: 0` unconditionally), just enforced from
the other direction.

A second pass raised the egg quantity from 1 to 2 (one `meat` exchange is one whole egg at ~40 g
raw, Table 4.1 — too small a serving to plate alone), and separately made non-vegetarian targets
prefer **real** meat (`meat_lean`, chicken/fish) over eggs — "non-vegetarian" already has
"eggetarian" as its own diet type for egg-only clients, so a non-vegetarian plan defaulting to
eggs-only defeats that distinction. Both are implemented as ordered **variant tiers**
(`anchorVariantTiers()`): `solveExchanges()` tries each tier's full search in order (base floors,
then widened floors) and returns the first that clears the 1.5% tolerance, only relaxing to a
looser tier when a stricter one can't fit the target.

- **eggetarian**: tier 0 requires 2 eggs; tier 1 allows a single egg — needed for Sneha (TEST-003)
  and Aadi (TEST-004), both golden worked examples, whose real targets push 2 eggs' fat to
  ~1.6–2.1% deviation, over tolerance.
- **non_vegetarian**: tier 0 requires 2 `meat_lean` exchanges (real chicken/fish, ~70 g), eggs
  optional; tier 1 drops that requirement back to "some egg or meat_lean, 0-2, never both zero"
  (the original floor, before real meat was preferred); tier 2 is the last-resort single-egg
  escape hatch. Verified against Rahul
  (TEST-002)'s real target, which lands exactly on tier 0 (2 eggs *and* 2 meat_lean, 0% deviation
  on every macro) — but tier 0 can still narrowly miss on a specific target purely from Table
  4.1's coarse 2.5 g fat-exchange grid (confirmed on a constructed case: `meat_lean=2`'s fixed 1 g
  fat shifts the remaining fat need off-grid enough to land at 1.66% deviation, just over
  tolerance), in which case it falls through to tier 1 like any other infeasible tier — an honest,
  non-silent fallback, not a bug.

Diet types with only one tier (vegetarian/jain/vegan) just run that tier once.

Getting the exchange *count* right upstream doesn't help if `meal-distributor.ts` then fractures
it across meals. The distributor proportionally splits every exchange type across all its allowed
meal slots by `kcal_share` — correct for continuously divisible foods (rice, dal, vegetables,
fruit, fat) but wrong for `meat`/`meat_lean` (a whole egg, a whole chicken/fish serving isn't a
fraction of a serving) and `milk_cow`/`milk_skim` (conventionally drunk in one sitting, not as a
125 ml glass at breakfast plus another 125 ml folded into evening chai). These four exchange types
are **indivisible**: the full day's count for each goes to a single meal slot — the earliest
`slot_order` that allows it — instead of being proportioned across every allowed one.

A meal built around `meat`/`meat_lean` also shouldn't carry `pulse` or `vegetable_a`/`vegetable_b`
alongside it — a non-veg dish is conventionally its own protein-and-side course, not an addition
to a dal-and-sabzi one. `meal-distributor.ts` resolves `meat`/`meat_lean` first (their field order
in `ZERO_COUNTS`, which `Object.keys(counts)` follows, puts them ahead of
`pulse`/`vegetable_a`/`vegetable_b` in the loop), then excludes whichever slot they landed in from
those three types' own apportionment — unless doing so would leave a type with nowhere to go, in
which case the exclusion is skipped rather than throwing. `cereal` and `fat` stay unrestricted (a
meat dish is still typically cooked in oil and served with a staple).

The "earliest allowed slot" rule above was originally day-invariant by construction —
`distributeMeals()` runs once for the whole week, not once per day, so `meat_lean` structurally
resolved to the same slot (lunch) every single day, all week, every week. A first fix
(`nonveg-slot-rotation.ts`'s `rotateNonVegSlot()`, **since removed**) relabelled the `lunch`↔`dinner`
pairing for a `stableHash`-selected ~half of the week's days, as a pure post-selection swap of both
the meal content and the archetype pairing together.

A dietitian directive replaced that mechanism entirely: real non-veg dishes (chicken/fish) belong
at dinner, always — never lunch, and never rotating between the two. Variety wasn't actually the
goal; a stable, predictable day structure was (lunch is always the vegetarian-style meal — cereal,
dal, sabzi; dinner is always the protein-and-side course). `meal-distributor.ts`'s
`LAST_SLOT_INDIVISIBLE_TYPES` now anchors `meat_lean` to the **last** allowed slot (dinner)
directly, instead of the first. `meat` (a whole egg) is unaffected — still the first allowed slot
(breakfast) — since eggs-for-breakfast was never part of this directive, only real
chicken/fish dishes. `nonveg-slot-rotation.ts` and its test file are gone; there is nothing left to
rotate.

`POST /api/plan/generate`'s DB-write loop derives `diet_plan_meals.slot_order` by looking up the
meal's `slot` name against `templates` (the real meal-template metadata) rather than trusting
`day.meals`'s array position — that array's order matches `slot_order` only incidentally (it falls
out of `Object.entries(skeleton)` at generation time, not a real ordering guarantee). This predates
and outlives the rotation mechanism above (which is what originally surfaced the gap, by relabelling
a meal's `slot` without moving it in the array) and stays in place as a defensive habit even now
that nothing relabels a meal's `slot` after generation.

### Milk, vegetable portion caps, and the one-dish-per-meal rule

Two more real dietitian constraints, both about what a single plated dish should actually look
like, not about the exchange math (which is untouched — only *which* combination of exchanges hits
the same target changes):

**Milk (`MILK_COW_CAP`, `exchange-solver.ts`)**: `milk_cow` is now fixed at exactly 1 exchange
(250 ml — Table 4.1's own standard serving) for *every* diet type, never 2. It was previously fixed
at 2 for vegetarian/eggetarian and searched `[1, 2]` for non_vegetarian; `milk_cow` being
**indivisible** (see above) meant a solved count of 2 put the *whole day's* milk in one glass at
breakfast — an unservable 500 ml pour. `milk_skim` (previously never used by the solver at all —
always 0) is now a real searched variable, so whatever dairy macro the capped `milk_cow` no longer
covers gets picked up there instead, plated as **Raita** or **Chaach** (`table41_foods.json`,
`milk_skim`, 200 g / 200 ml per exchange — deliberately *not* the 320 g/exchange every other
`milk_skim` food uses, since a thicker curd-based preparation is more calorie-dense per gram; a
dietitian-specified figure, not inferred) at **lunch only** — "people only take raita or chaach at
lunch," never breakfast or dinner. `milk_skim` was never an allowed exchange type at lunch in any
region until `20260810940000_milk_skim_at_lunch.sql` added it there, uniformly, the same way
`20260810400000_no_milk_at_lunch.sql` removed `milk_cow` from lunch earlier.

`milk_cow` itself has since moved again — `20260811040000_shift_milk_cow_to_dinner.sql`, a direct
dietitian instruction, relocated it from breakfast to dinner, system-wide, every region. Since
`milk_cow` is indivisible and resolves to the *earliest allowed* slot for the day's single 1-exchange
total, simply adding `dinner` to its allowed slots wouldn't have moved anything — breakfast
(`slot_order` 1) and mid_morning (2) were both still earlier than dinner (5) and still nominally
allowed it, so it would have kept resolving to breakfast exactly as before. The fix removes
`milk_cow` from breakfast/mid_morning/evening's `allowed_exchange_types` entirely, leaving dinner as
the sole allowed slot — the same technique `20260810400000_no_milk_at_lunch.sql` already used to
rule *out* a slot, now used to make dinner the *only* one left in. No conflict with `meat_lean`
anchoring permanently to dinner too: they're independent exchange types, each resolved within its
own needed-slots set, and `MEAT_CONFLICTING_TYPES` never touched `milk_cow` in the first place.

**Vegetable_a ceiling (`NON_VEGETARIAN_VEGETABLE_A_CAP`, `exchange-solver.ts`)**: `meat_lean`
anchoring permanently to dinner (above) means dinner *never* carries `vegetable_a`/`vegetable_b`
(the existing `MEAT_CONFLICTING_TYPES` exclusion), so for a non-vegetarian client, lunch is the
*only* slot that can ever hold a cooked vegetable — every single day, not just some. The textbook
4-exchange floor (400 g, and up to 6 on the solver's widened retry tier — see `attemptTier()`)
doesn't fit a single realistic ~200 g dish there. A dietitian confirmed capping `vegetable_a` at
exactly 2 exchanges (200 g) for `non_vegetarian` specifically is clinically fine, and that the
resulting carb shortfall should just be absorbed by more cereal — which needed no new code: cereal
is *already* solved as a residual against the exact carbs target, after every other exchange type
is chosen, so tightening `vegetable_a`'s ceiling automatically pulls in more rice/roti to
compensate. Every other diet type keeps the original 4-exchange floor (widened up to 8 across
`attemptTier()`'s base/widened pair) — they still split `vegetable_a` naturally across both lunch
*and* dinner, so nothing concentrates for them.

Two earlier attempts at this specific fix were tried and rejected before landing on the solver-level
cap above — worth recording so nobody re-tries them: (1) splitting the oversized single dish into
2+ *different* foods of the *same* exchange type within one meal (a `MAX_SINGLE_FOOD_RAW_G`-style
mechanism, briefly implemented and fully reverted) traded "one huge dish" for "two dishes in one
meal," which a dietitian ruled out categorically — a meal may never carry two separate
cooked-vegetable dishes, regardless of size. (2) Allowing `vegetable_a`/`vegetable_b` into the
meat_lean slot too (undoing part of `MEAT_CONFLICTING_TYPES`) was also rejected — non-veg meals
stay vegetable-free, full stop.

**vegetable_a + vegetable_b co-occurrence (`food-selector-fallback.ts`,
`curatedVegetableFamilyPairs`)**: a second, independent source of the same "two dishes in one meal"
symptom, unrelated to the cap above — whenever `vegetable_a` and a *non-salad-tagged* `vegetable_b`
food both land in the same slot (routine on any diet type, not just non-vegetarian) without forming
a genuine named dish (Aloo Gobi, Aloo Baingan, Tinda Aloo, Aloo Methi) or landing on the week's one
designated `isMixedVegDay` (see "Vegetable dish naming" below), `vegetable-dish-naming.ts` already
split an uncurated pairing back into two separately-labelled dishes at *display* time — which is
exactly the outcome being avoided, just arrived at from a different pairing (cross-type, not
same-type). Fixed at *selection* time instead: `route.ts` now loads `vegetable_dish_combinations` +
`vegetable_dish_combination_members` *before* calling `selectFoods` (previously this data was only
ever loaded at display time, in `plan-view-model.ts` — too late for the selector to use), reduces
it to a `Set` of sorted `dishFamilyId` pairs, and passes it through `FoodSelectorInput` as
`curatedVegetableFamilyPairs`. When resolving `vegetable_b` for a slot that already has
`vegetable_a`, the fallback selector restricts its pool to salad-tagged foods (Carrot, Onion,
Beetroot, Radish — always rendered as a separate "Salad" line, never a competing sabzi) *unless* a
candidate's `dishFamilyId` forms a genuine curated pair with that day's chosen `vegetable_a` food,
in which case the real named-dish pairing (e.g. Potato + Cauliflower → "Aloo Gobi") is preserved.
This is a pool restriction, not a fabricated macro or a hidden quantity — whichever salad-tagged
food wins the rotation is a real, honestly-labelled food actually served. Degrades to the
unfiltered pool (same graceful pattern as `PROTEIN_EXCHANGE_TYPES`'s same-day exclusion) only if no
salad-tagged or curated-matching food is eligible at all — an edge case this project's seeded data
doesn't currently produce, since most regions' `vegetable_b` pools are majority salad-tagged.

### Vegetable dish naming — salad vs. sabzi

`meal-composition.ts`'s `composeMealDisplay()` used to pool every `vegetable_a` + `vegetable_b`
item in a slot into one generic "Mixed Vegetable {RegionWord}" the moment there were 2+ — with no
culinary logic at all, so e.g. Beetroot could land in the same dish as Capsicum/Tomato/Onion/
Potato. A curated name (`vegetable-dish-naming.ts`, matching against `vegetable_dish_combinations`)
only ever covered the exact-set case, and only 2 such rows exist system-wide (Avial, Aloo Gobi) —
so almost every multi-vegetable day fell through to the generic label.

Fixed at the `foods.tags` level: a `"salad"` tag (Cucumber, Onion, Beetroot, Radish, Carrot — see
`table41_foods.json`) pulls a food out of the cooked-sabzi pool into its own separate "Salad" line,
built by `composeMealDisplay()` before the general pooling runs. A food's existing `seasons` tag
already governs *when* it's eligible at all, so a winter-only salad food (Radish, Carrot) is only
ever grouped as salad during the season it can appear in — no separate season-conditional salad
logic was needed, the two tags compose for free. This can now produce up to two `mixed_dish`
vegetable groups in one meal (sabzi + salad); `vegetable-dish-naming.ts`'s `applyVegetableDishNames`
was updated to check every such group independently rather than assuming at most one — the salad
group is expected to never match a curated combo (its foods carry no `dish_family_id` by design;
curated naming is for cooked combos like Aloo Gobi) and keeps its generic "Salad (...)" label,
which now falls out correctly regardless of which group happens to appear first.

`food-selector-fallback.ts`'s `SPLITTABLE_TYPES` used to include `vegetable_a`/`vegetable_b`,
forcing a 2+-exchange slot to split into 2 arbitrary DIFFERENT foods of that type (e.g. Cabbage +
Capsicum) — combined with meal-composition.ts's pooling, this meant "Mixed Vegetable Sabzi" was
close to the everyday default rather than the exception. Reverted: real everyday Indian sabzi is
overwhelmingly single-vegetable (Lauki Sabzi, Karela Sabzi, Bhindi Masala — confirmed via web
research), and a genuine 2-vegetable dish almost always means a specific named "Aloo + X" pairing
(Aloo Gobi, Aloo Baingan, Tinda Aloo, Aloo Methi), not two unrelated vegetable_a foods thrown
together. `vegetable_a`/`vegetable_b` now each resolve to ONE food per slot (like every other
non-splittable exchange type) — `fruit` keeps its 2-item split, that part of the original Deepak/
Anjali-grounded observation stands. This naturally produces mostly single-vegetable sabzi (or
single-vegetable + salad, once the salad-tagged `vegetable_b` item is pulled into its own line) —
a 2-item cooked pool only forms on the days `vegetable_b`'s rotation lands on Potato, which is
exactly when the newly-seeded Aloo Gobi/Aloo Baingan/Tinda Aloo/Aloo Methi combos (see
`20260810930000_more_vegetable_dish_combinations.sql`) can name it properly instead of falling
through to the generic label.

One side effect of the reversal above, caught by inspecting a real generated PDF: `vegetable_a`
resolving to one food per slot combines badly with `meal-distributor.ts`'s `MEAT_CONFLICTING_TYPES`
exclusion — on a non-vegetarian day, that exclusion routes pulse/vegetable_a/vegetable_b away from
whichever slot has meat/meat_lean, so the day's ENTIRE vegetable_a allocation (Table 4.1's own
floor: 4 exchanges/day) lands in the other slot alone — a 400 g single-vegetable dish, double the
~200 g a slot normally gets when no such exclusion applies. A first fix (`LARGE_PORTION_SPLIT`,
now removed) re-enabled a 2-food split once a slot's count cleared a threshold — this fixed the
oversized-single-dish *portion size* but not "mix veg" *frequency*: the concentration happens on
literally every non-vegetarian day (every such day has meat/meat_lean somewhere), so a count-based
threshold meant "mixed veg" itself showed up nearly every day too, just at realistic per-item sizes
instead of one huge one. Wrong layer to fix it at — the count threshold answers "is this dish too
big", not "should today be a mixed-veg day at all", and those are different questions.

That portion-*size* half of the problem stayed genuinely unsolved at the time this paragraph was
first written — `isMixedVegDay` below only ever fixed the *frequency* of the generic "Mixed
Vegetable" label, never the underlying 400 g concentration. It was finally fixed properly later,
one layer up: see "Milk, vegetable portion caps, and the one-dish-per-meal rule" above
(`NON_VEGETARIAN_VEGETABLE_A_CAP`, `meat_lean` anchored permanently to dinner). The two mechanisms
now operate on genuinely orthogonal axes — `isMixedVegDay` still decides which ~1-in-7 day is
allowed to show the generic multi-vegetable label at all; the portion cap independently guarantees
every day's single-vegetable dish stays within a realistic ~200 g regardless of which day that is.

Replaced with `mixed-veg-day.ts`'s `isMixedVegDay(rotationDay)`: a `stableHash`-gated function that
picks exactly ONE day per 7-day week block (`rotationDay % 7 === stableHash("mixed_veg_day",
weekBlock) % 7`), not an independent per-day coin flip — hashing each day on its own (the actual
first version of this function) can and did collide, producing 3+ "mixed veg" days in a single real
week, since 7 independent draws landing on residue 0 isn't the same as "exactly one of the 7 is
selected". `rotationDay` (`dayIndex + (weekNumber - 1) * 7`) is always a multiple-of-7-aligned
window, so every week's 7 days fall inside one block, and the specific weekday still varies week to
week since the hash input changes with the block. Shared between two call sites that both need the
exact same answer for a given day or they'd disagree about which day is "the" mixed-veg day:
- `food-selector-fallback.ts`'s `MIXED_VEG_TYPES` combo pool — gates whether 2 arbitrary
  `vegetable_a` foods combine at *selection* time. `SOLO_ONLY_TAG` foods (Karela, Lauki, Brinjal,
  Tori, and regional aliases — see `table41_foods.json`) are filtered out of this pool entirely,
  even on the designated day: these are real, always-solo dishes (Karela Sabzi, Baingan Bharta),
  never randomly combined with an unrelated vegetable in practice. They can still appear alone (any
  day, any count) and still pair with `vegetable_b` for a curated combo (Aloo Baingan) — a different
  mechanism (two distinct exchange types naturally co-occurring in a slot), not this same-type pool.
- `vegetable-dish-naming.ts`'s `applyVegetableDishNames` — gates a *second*, independent source of
  the same symptom that the selection-time fix alone didn't touch: `meal-composition.ts` pools a
  single `vegetable_a` food with a single `vegetable_b` food into one combined sabzi group whenever
  neither is salad-tagged, regardless of whether `vegetable_a` itself ever split. When that pairing
  doesn't match a curated `vegetable_dish_combinations` row (Aloo Gobi, Aloo Baingan, Tinda Aloo,
  Aloo Methi, Avial), it used to fall straight through to the generic "Mixed Vegetable {word}" label
  — with no day-gating at all, this alone put "Mixed Vegetable Sabzi" on 3-4 of 7 days in a real
  generated plan even after the selection-time fix. `applyVegetableDishNames` now takes an
  `allowGenericMixedVeg` boolean (the caller's `isMixedVegDay(rotationDay)`); when false, an
  uncurated generic group is split back into N separate `single_dish` entries (one per food, each
  named `"{Food} {word}"`, the word recovered from the generic label itself) instead of merging.
  A curated match always wins over this gate — Aloo Gobi is a real named dish and can show on any
  day, not just the designated one; only the *uncurated* fallthrough is day-limited. Call sites
  (`composed-meal-cell.tsx`, `plan-pdf-document.tsx`) compute `rotationDay` the same way route.ts
  computes `dayIndexOffset` (`dayIndex + (weekNumber - 1) * 7`), so the review page and the PDF
  always agree with each other and with the generator on which day is "the" mixed-veg day.

`vegetable_b` isn't included in the `vegetable_a`-vs-`vegetable_a` combo pool — its smaller 50
g/exchange size means even a concentrated count (3 exchanges/150 g) still reads as a normal
single-dish portion, so there's nothing to gate there; it only ever participates in the second
mechanism above (pairing with `vegetable_a`).

Display simplification (`meal-composition.ts`'s `formatComposedGroupPlainText`): even on the one day
a generic "Mixed Vegetable {word}" group is shown, it renders as `"{dishName} ({totalGrams} g)"` —
total grams only, no per-vegetable breakdown. Scoped narrowly via `GENERIC_MIXED_VEG_PREFIX`
("Mixed Vegetable ") so it doesn't affect a curated name (Aloo Gobi still lists its two components —
a named dish's own composition is useful information) or the separate "Salad" pool (dishName exactly
`"Salad"`, doesn't match the prefix).

Quantity display (`format-item.ts`) normally shows only the verified gram figure, deliberately
never inventing a piece count (see the file's own comment — the real reference PDF's richer
per-food phrasing, e.g. "5 rotis", comes from a data model this app didn't adopt). `meat`/
`meat_lean` are the one exception: `exchangeCount` is already the exact, verified count for these
— not derived or guessed from the gram figure — so it's shown alongside it, e.g. `"2, 80 g"` for 2
eggs, exactly as trustworthy as the gram number itself.

### Seasonal eligibility

`foods.seasons` (`text[]`, default `{all_year}`) is a seventh AND-combined eligibility filter in
`eligible-foods.ts`, sitting after `medical_tags` — same discipline as the Meal Archetype layer:
additive, narrows which foods can fill a slot the solver already decided the exchange counts for,
never touches a macro number. `"all_year"` always passes regardless of the derived season, so an
untagged/staple food (the default for every existing row) is never accidentally narrowed by this
migration alone — only an explicit retag can narrow a pool.

`season.ts`'s `seasonFor(weekStartISO, region)` derives the season from the plan's actual
`week_start` (not "today" — a plan's week can start in a different season than the day it's
generated on) via a fixed month→season table (`NORTH_CALENDAR`). Only one calendar exists today;
every region currently falls back to it. This is a known, deliberate limitation — real
`SOUTH_CALENDAR`/`WEST_CALENDAR`/`EAST_CALENDAR` tables need their own grounding (monsoon onset
genuinely differs by coast) rather than being guessed. `POST /api/plan/generate` accepts an
optional `season` override in its request body; when omitted it derives from `week_start` + region
automatically, so a dietitian never has to think about it unless overriding.

Seed data (`table41_foods.json`) is retagged only where grounded in a concrete claim — e.g. Sarson
saag/Methi/Palak/Carrot → `winter`, Lauki/Tinda/Guava → `monsoon`, Musk melon → `summer`. Every
region besides Punjab is left at the `all_year` default; fabricating seasonal claims for regions
with no source data to check them against would be worse than not tagging them at all.

### No cooking fat alongside a plain porridge cereal

A dietitian correction on a generated PDF: Oats — added specifically because Gobi/Mooli Paratha's
new seasonal tagging (above) could otherwise leave breakfast with too few eligible cereals in some
weeks, and given its own "Oats Meal" archetype with **no** fat component precisely because "plain
oats porridge doesn't conventionally need a ghee tempering the way a paratha does" (see the Meal
Archetype migration) — still showed up with Ghee plated next to it every time it was actually
selected.

Root cause: the Meal Archetype layer's dish-family narrowing is a **weekly union** per (slot,
exchangeType) across all 7 days' assigned archetypes (`route.ts`, see "Meal Archetype + Dish
Composition layer" above), while `meal-distributor.ts`'s skeleton is identical for every day of the
week — breakfast always carries a nonzero `fat` exchange count regardless of which archetype that
specific day landed on. Giving "Oats Meal" no fat component only meant it contributed nothing *new*
to that union; it never *removed* Ghee, which the region's paratha archetypes' own `ghee_fat`
components already put there for the whole week. So on the days Oats was actually selected, Ghee
remained the only eligible `fat` food for breakfast — the exact pairing the archetype was designed
to avoid. (This is a distinct, independently-discovered instance of the same architectural gap
already documented in `plan-view-model.ts`'s adherence comment — a day's archetype intent can drift
from the food actually plated — except this time the drift is visible in the rendered PDF, not just
in an internal label.)

Fixed one level below the archetype/dish-family system, at plain food tags, which
`food-selector-fallback.ts` (and, via a matching `ROTATION_RULES` entry, the LLM prompt path) can
check per-item within a single slot regardless of which archetype is nominally assigned that day —
the same mechanism already used for the `vegetable_a`/`vegetable_b` salad restriction above.
`cooking_fat` tags every fat-exchange food actually used to cook or temper a dish (Ghee, Toop,
Mustard oil, Groundnut oil, Til oil, Coconut oil, Sesame oil, Grated coconut) — inappropriate
spooned over a cold cereal porridge. `no_cooking_fat` on Oats means: whichever `fat` food fills the
same slot should avoid `cooking_fat`-tagged foods, degrading to the unfiltered pool (same graceful
pattern as everywhere else in this file) when no alternative is eligible. Almonds and Walnut
(already `generic` region, so eligible in every region including Punjabi) had their `meal_slots`
widened to include `breakfast` so a real alternative exists — chopped nuts over porridge is a
standard preparation, unlike ghee. Scoped to Oats only, not Dalia/Upma (also fat-component-free
breakfast archetypes) — those are legitimately still cooked with an oil tempering in real
preparation, so forcing the same restriction onto them would have been a fabricated rule, not a
correction.

### Omelette pairs with plain Paratha

A direct, repeated user instruction: whenever a slot's `meat` exchange resolves to Omelette, that
slot's `cereal` exchange should be the literal food Paratha, every time — not a stuffed/fried dish
(Aloo/Gobi/Methi/Paneer/Mooli Paratha), not a porridge (Oats, Dalia), and not a region-specific
substitute. Implemented in `food-selector-fallback.ts`: `meat` resolves before `cereal` in the
per-slot loop (`ZERO_COUNTS`'s field order, the same ordering fact `MEAT_CONFLICTING_TYPES` in
`meal-distributor.ts` already relies on), so by the time a slot's `cereal` item is reached,
`selectedItems` already reflects whichever `meat` food was picked — no lookahead needed. Omelette
carries `pairs_with_plain_paratha`; when that tag is present on the slot's chosen `meat` food, the
`cereal` pool is restricted to foods tagged `omelette_pairing_cereal` (currently Paratha only).

First implemented by matching the cereal side by literal food name ("Paratha") instead of a tag,
since only one plain-Paratha food existed in the dataset at the time. That broke the moment a real
Rajasthani non-vegetarian plan was generated and inspected: Rajasthani's breakfast cereal pool has
no food named "Paratha" at all (Bajra bhakri and Pyaaz Kachori instead), so the name-match filter
always came up empty there and silently fell through to the fully unrestricted pool — an Omelette
day and a Bajra bhakri day only *appeared* correlated in that generated plan by coincidence (both
the meat pool and the cereal pool happened to have exactly 2 members and use the same day-indexed
rotation formula), not because the rule was doing anything.

A first attempt at fixing this generalized to a per-region "plain cereal" tag — Paratha for
north_indian, Bajra bhakri newly added for rajasthani, on the reasoning that Bajra bhakri is
Rajasthan's own unstuffed everyday flatbread. **Rejected on direct correction**: the user clarified
that "plain Paratha" means the literal food, everywhere it can be made eligible, not a per-region
stand-in. The real root cause wasn't the pairing logic at all — Paratha was simply never *eligible*
for rajasthani, on two independent layers: its `foods.regions` was `{north_indian}` only, and even
past that, rajasthani's own two breakfast archetypes (`rajasthani_bajra_bhakri_meal`,
`rajasthani_pyaaz_kachori_meal`) didn't declare the `plain_paratha` dish family in their cereal
role, so the Meal Archetype layer's weekly union would have excluded it regardless — the exact same
class of bug already fixed once for north_indian's own archetypes (widening the cereal
`dish_family_ids` of its five paratha/roti/dalia breakfast archetypes to also accept
`plain_paratha`), just never carried over to rajasthani. Fixed both, widening Paratha's `regions`
to add rajasthani and widening both
rajasthani breakfast archetypes' cereal `dish_family_ids` to also accept `plain_paratha` — the Bajra
bhakri tag was removed. Once eligible, Paratha also becomes a normal (non-Omelette-gated) rotation
option for rajasthani breakfast, same as it already was for north_indian — this rule only ever
*forces* Paratha when Omelette is present, it never excludes Paratha the rest of the time.

Any other region (punjabi, gujarati, bengali, south_indian, hyderabadi, maharashtrian) still has no
food tagged `omelette_pairing_cereal` and no archetype declaring `plain_paratha` — an Omelette there
gracefully degrades to the unrestricted cereal pool, same as everywhere else in this file, until
Paratha is confirmed and made eligible there too. Scoped to Omelette only, not Egg/Egg curry/Egg
bhurji — the instruction named Omelette specifically.

### Rajasthani lunch pulse variety

A real generated Rajasthani plan showed only "Rajma curry" or "Gatte sabzi" at lunch, every week, no
other pulse ever appearing. Root cause: rajasthani has exactly two active lunch archetypes
(`rajasthani_rajma_chawal_meal`, `rajasthani_gatte_rice_meal`), and each narrows its `pulse` role to
a single dish family (`rajma`, `gatte`). The Meal Archetype layer's weekly union (`route.ts`) is
built only from these two archetypes' declared families, so lunch's pulse pool is capped at exactly
`{rajma, gatte}` every week regardless of which combination gets picked which day — even though the
`foods` table already has 5 more generic pulses eligible at rajasthani lunch (Chana dal, Toor dal,
Masoor dal, Moong dal, Kala chana), none of which ever passed the narrowing filter. The exact same
shape as the Omelette/plain-Paratha and Oats/Ghee bugs above: a food can be fully eligible by every
other check and still never appear because no archetype assigned that week declared its dish family.

Fixed the same way: widened `rajasthani_rajma_chawal_meal`'s `pulse` role `dish_family_ids` to also
accept `chana_dal`, `masoor_dal`, `moong_dal`, `toor_dal`, `kadala_curry` (Kala chana's family) —
direct precedent already existed in this dataset: `north_indian_roti_dal_meal`'s own `dal_curry`
role already accepts 4 dal families, not 1. Widened only the generic Rajma Chawal archetype, not
Gatte Rice Meal — Gatte ki Sabzi is Rajasthan's own uniquely named specialty (steamed gram-flour
dumplings in a yogurt curry), and diluting a real named dish's own archetype with unrelated generic
dals would repeat the mistake already rejected once this session for vegetable dish naming and for
Oats. These dals are already tagged `generic` (used across every region's rotation already), so
widening Rajma Chawal Meal to include them is not a fabricated regional claim.

Sprouts (also lunch-eligible, `generic`) is NOT included: it has no `dish_family_id` at all in this
dataset, and `eligible-foods.ts`'s narrowing filter (`f.dishFamilyId !== null && dishFamilyIds.
includes(...)`) unconditionally excludes any food with a null family the moment any narrowing
constraint exists for that (slot, exchangeType) — giving it a family is a separate, unrelated fix.

### 2026-08-12 regional food expansion (79 new foods across all 8 regions)

A direct instruction to "do more research on all regions and add more foods in all categories"
(breakfast/lunch/evening/dinner). Before researching, counted existing region-specific coverage per
(region, slot) — pooling in `generic`-region foods (fruit, plain dal, plain rice/roti) papered over
just how thin real regional identity was: Gujarati had 5 breakfast / 4 lunch / 3 dinner / 1 evening
region-specific dishes despite being one of India's richest vegetarian cuisines; Bengali, Rajasthani,
and Hyderabadi were similarly thin; every region's breakfast/evening/mid_morning skewed almost
entirely generic (Poha, Corn flakes, Murmura) rather than actually regional.

Ran 8 parallel research passes (one per region), each given the fixed Table 4.1 serving-weight
convention (cereal 20 g, pulse 30 g, vegetable_a 100 g, vegetable_b 50 g, fat 5 g, meat 40 g,
meat_lean 35 g, sugar 5 g — exceptionless across the existing 137-food dataset) so the research task
was pure culinary classification, never a nutrition estimate. Each pass returned real, named dishes
with an exchange-type classification, jain/vegan judgment, and a confidence level, explicitly
instructed to skip anything that doesn't cleanly map to one exchange type (mixed dishes like biryani,
misal-with-toppings, undhiyu, shukto) rather than force a bad fit — several candidates were dropped
this way (Gunda/Kachri ki Sabzi for rajasthani, low-confidence and more chutney than sabzi in
practice; Avial, already handled as a curated dish combination elsewhere).

79 new foods were added (137 → 216), following the same one-line-per-food schema and the same
"UNVERIFIED — pending dietitian confirmation" convention already used for Laal Murgh/Meen Curry/Kanji
etc. Highlights: Bengali went from 3/4/4 (breakfast/lunch/dinner) to a real repertoire (Begun Bhaja,
Aloo Posto, Doi Begun, Dhokar Dalna, Macher Jhol, Shorshe Ilish — its fish tradition finally has named
dishes, not just generic "Fish"); Gujarati gained its first-ever vegetable_a dishes (Ringan nu Shaak,
Bhinda nu Shaak, Patra) plus a real repertoire of besan/rice snacks (Khaman, Fafda, Khichu, Khandvi,
Handvo, Muthiya); Hyderabadi gained Bagara Baingan, Beerakaya Kura, Bendakaya Vepudu, and named
meat_lean dishes (Kodi Kura, Chepala Pulusu) matching the precedent already set by south_indian's
Meen Curry/Nadan Kozhi Curry; Rajasthani's evening slot went from zero region-specific dishes to
Pyaaz Kachori (which also fills the food-row gap behind the pre-existing
`rajasthani_pyaaz_kachori_meal` archetype name) and Moong Dal Kachori.

**Cross-agent conflicts resolved by hand**: two agents independently proposed "Besan Cheela"/"Besan
Chilla" for overlapping regions (north_indian, punjabi, rajasthani) with different exchange-type
calls (pulse vs cereal) and two proposed "Mathri" (north_indian, rajasthani). Resolved to one row
each, spanning all proposing regions — Besan Cheela as `pulse` (2 of 3 agents agreed, and it is pure
besan/gram flour with zero grain, matching the existing Kadhi/Gatte precedent of besan-only
preparations being modeled as a pulse exchange, not the rice-forward Dhokla precedent). Where an
agent's own reasoning for a food's exchange type differed from this besan-as-pulse convention but was
still internally consistent with an *existing* precedent (Gujarati's Khaman/Khandvi/Fafda/Handvo/
Muthiya, reasoned by that agent as cereal "for consistency with the already-seeded Dhokla/Missi
roti"), the agent's own call was kept rather than overridden by a blanket rule — both Dhokla-cereal
and Kadhi/Gatte-pulse are legitimate existing precedents in this dataset for different reasons
(rice-forward batter vs pure legume flour), so there wasn't one single correct answer to impose.

**A real regression found and fixed during verification, not caused by this pass's research but
surfaced by it**: reseeding after this addition made `milk_cow` (`Milk`) fail with
`NoEligibleFoodsError` at dinner, for every region. Root cause: `20260811040000_shift_milk_cow_to_
dinner.sql` (an earlier, uncommitted fix this same session) moved `milk_cow`'s only allowed
`meal_templates` slot to dinner, system-wide — but never updated the `Milk` food row's own
`mealSlots` array to include `"dinner"`, since that migration only touched `meal_templates`, not
`foods`. The live DB had likely been hand-patched around this at the time, but `seed-foods.ts`'s
upsert unconditionally overwrites a matching row's `mealSlots` from `table41_foods.json` on every
run — so reseeding silently reverted that patch back to the stale JSON, breaking generation for every
region until `table41_foods.json` itself was corrected to include `"dinner"`. A reminder that a live
DB fix that never makes it back into the JSON source of truth is a fix that reseeding will undo.

**A second, more systemic gap found while auditing every new food for reachability**: 14 of the 79
new foods were tagged with a real-world mealSlots that `meal_templates.allowed_exchange_types` can
never actually solve for, *system-wide, every region* — `breakfast` never allows `pulse`,
`vegetable_a`, or `vegetable_b`; `mid_morning` allows only `fruit`/`fat`; `evening` allows only
`fruit`/`cereal`. A besan pancake (Besan Cheela, Moong Dal Chilla, Pesarattu), a fritter
(Kothimbir Vadi, Uzhunnu Vada, Parippu Vada, Peyaji, Aloor Chop, Beguni), a tikka starter (Paneer
Tikka, Chicken Tikka), a full usal meal (Misal), a leaf snack (Patra), or a roasted-legume snack
(Bhuna Chana) at its real-world breakfast/evening/mid_morning slot would have been added to the
dataset fully correctly classified and still *never once be selectable in a generated plan* — the
exact "eligible by every other check, invisible because a higher layer never asks for it" shape
already documented three times above (Omelette/Paratha, Oats/Ghee, Rajasthani lunch pulse), just at
the `meal_templates` layer instead of the archetype layer this time. Fixed by adding `lunch`/`dinner`
to each affected food's `mealSlots` (both slots always allow `pulse`/`vegetable_a`/`vegetable_b`/
`meat`/`meat_lean`) so every new food is genuinely reachable, while keeping the original
breakfast/evening/mid_morning tag too where it's still the food's honest real-world occasion — this
preserves the useful "how is this actually eaten" signal without leaving the row dead. `Paneer
Tikka`/`Chicken Tikka` had their evening-only tag *replaced* rather than extended, since `meat`/
`meat_lean` genuinely can't ever be assigned to `evening` and the existing Egg/Egg bhurji/Omelette/Egg
curry precedent already shows multiple distinctly-named preparations of the same exchange type
happily coexisting at the same lunch/dinner slots. Verified with a script auditing every one of the
216 foods' `mealSlots` against `meal_templates`' allowed types per slot (0 fully-unreachable foods
remain, matching before this pass too — the pre-existing dataset already tolerates some *partially*
unreachable slots, e.g. `Sugar`'s `evening` tag, which this pass's newly-added foods now also do in
the same harmless way), then regenerated real plans for Gujarati, Bengali, Punjabi, and Hyderabadi and
confirmed the fixed foods (Amritsari Fish, Chicken Tikka, Makkhan, Bagara Baingan, Beerakaya Kura,
Bendakaya Vepudu, Khakhra, Bhinda nu Shaak, Ringan nu Shaak, and others) actually appear in generated
output, not just in the JSON.

This surfaces a real open question for a dietitian, not resolved here: should `meal_templates` widen
`breakfast` to allow `pulse` (besan pancakes are a genuine everyday breakfast) and `evening` to allow
`pulse`/`vegetable_a`/`vegetable_b` (fritters and vadas are genuine everyday snacks)? Three independent
regional research passes converged on real pulse-based breakfast dishes without being told about each
other, which is a stronger signal than any one region's request — but widening a meal slot's allowed
exchange types is a platform-wide nutritional-structure decision (it changes what every region's
breakfast/evening *can* solve for, not just what one food is tagged with), not a data-addition
decision, so it's flagged here rather than made unilaterally.

### Day-to-day macro variety, weekly average pinned to target

A direct dietitian correction on a generated plan: every one of the 7 days carried mathematically
identical macros (`solveExchanges()` runs once per week, and the resulting exchange counts were
applied unchanged to every day — `dietPlans.achieved` was even documented as `priced.days[0].achieved`,
"identical every day by construction"). A real client's week doesn't look like that, and a plan that
does reads as artificial. The fix needed to satisfy two things at once, not trade one for the other:
the week's **average** protein must still land exactly on the prescribed target (still "THE ONE RULE
THAT MATTERS" — nothing here lets a number drift from deterministic exchange arithmetic), while
individual days wobble by a small, bounded amount — confirmed as a **total spread across the week**
of about 5-7g of protein (not per-day; the gap between the best and worst day), with carbs/fat/kcal
allowed to move too rather than being artificially pinned flat.

`solveExchanges()` itself is untouched — still called once per week, exactly as before. The wobble is
injected afterward, in `daily-macro-jitter.ts`'s `computeDailyPulseJitter()`: 7 deltas (3× `+0.5`, 3×
`-0.5`, 1× `0`, sum exactly 0) added to the single solved `pulse` exchange count, one delta per day.
±0.5 pulse exchange = ±3.5g protein per direction = 7g spread across the week, matching the confirmed
band; because the deltas are exactly zero-sum, the week's average pulse count — and therefore average
protein — is mathematically identical to the base solve's already-tolerance-checked value, not merely
close to it. Which 3 of the 7 days go up/down is decided by a `stableHash` seeded on
`${roadmapId}:${weekNumber}` (same small per-file hash pattern already used in `mixed-veg-day.ts` /
`food-selector-fallback.ts` / `archetype-selector.ts`), so it's deterministic per plan but not the same
3 weekdays for every client.

**Why `pulse` and nothing else.** `milk_cow`, `milk_skim`, `meat`, `meat_lean` are documented above as
indivisible and/or dietitian-mandated fixed floors — `milk_cow` always exactly 1 exchange; `meat`/
`meat_lean` driven by `anchorVariantTiers()`'s tiered floor logic for non_vegetarian/eggetarian. A
fractional day-to-day nudge on any of these would violate those invariants and risk flipping which
tier "fits" on a given day — a much bigger, uglier swing than the 7g of protein actually asked for.
`fat` carries no protein but has its own universal `FAT_EXCHANGE_FLOOR` (2, every diet type) with the
identical floor-collision risk `pulse` has, for a macro nobody gave numeric requirements for. `pulse`
is the one protein-bearing exchange type that's genuinely continuous and freely divisible, with no
fixed floor outside `VEGAN_PULSE_FLOOR` for vegan diets (exported from `exchange-solver.ts` specifically
so this file's floor guard can't silently drift out of sync with the solver's own number) — and it
carries 17g carbs per exchange too, so carbs and kcal wobble along with protein for free, which is why
a single jittered exchange type satisfies "protein wobbles, but other macros can move a little too"
without needing a second, independent jitter mechanism.

**Floor guard, graceful degradation.** If the base solved `pulse` count is too low to safely subtract
0.5 without breaching its floor (0 for every diet type except vegan's `VEGAN_PULSE_FLOOR`),
`computeDailyPulseJitter()` returns all-zero deltas for that one plan — today's flat behavior, not a
forced unsafe jitter or an asymmetric non-zero-sum one. Same "degrade to the unfiltered/unjittered
case" philosophy already used elsewhere in this file (e.g. the salad-restriction fallback in
`food-selector-fallback.ts`).

**What actually changed, mechanically.** `distributeMeals()` is now called 7 times per plan (once per
day, each with that day's own jittered exchange counts) instead of once, producing
`FoodSelectorInput.skeletonsByDay: Skeleton[]` instead of one shared `skeleton` — `fallbackSelection()`,
`validateSelection()`, and the LLM prompt (`food-selector-prompt.ts`'s `skeletonsByDay` payload field)
all index into the day-specific skeleton instead of assuming every day matches. `quantity.ts`'s
`assertWithinTolerance()` now checks each day against *its own* expected achieved macros (from that
day's jittered exchange counts, via `sumExchanges()`) rather than the flat weekly target — a real
wobble day would otherwise fail every time against a target it was never meant to hit exactly; this
stays the same "defensive, should be impossible to fail" guard it always documented itself as. The
actual clinical guarantee lives in the new `assertWeeklyAverageWithinTolerance()`: the mean of all 7
days' achieved macros must be within the existing 1.5% `ACCEPTANCE_FRACTION` of the true prescribed
target — mathematically guaranteed to hold whenever the base solve was already `ok`, given the
zero-sum property, so this is a defensive re-check too, not a new source of risk. `dietPlans.achieved`
(DB write and the route's response body) changed from `priced.days[0].achieved` to the computed mean
across all 7 days, and `plan-view-model.ts`'s displayed `deviationPct` now derives from that same
weekly-average `achieved` against `targets`, rather than reading `plan.deviation[0]` — since
per-day deviations are now checked against each day's own (deliberately moved) goalpost, day 0's
stored deviation is ~0 by construction and no longer means "how far this plan is from the client's
real target," which is exactly what the weekly-average figure is for.

Verified against real plans, not just the golden-file tests (which are untouched — they only assert
tolerance on `solveExchanges()`'s single-solve output, never exact exchange counts, so they pass
unchanged): regenerated Priya's (TEST-001, vegetarian) and Rahul's (TEST-002, non_vegetarian, tier 0)
plans and confirmed protein spans exactly the confirmed band (e.g. Rahul: 114.5g–121.5g, a 7g spread,
weekly average 118.0g against a 118g target) while `meat`/`meat_lean`/`milk_cow` stay bit-for-bit
identical across all 7 days in both cases — the floor/indivisibility boundary held exactly as designed.

### Curd replaces milk as the default dairy exchange

A direct dietitian correction: milk should not be served by default at all — curd instead, about
300 g/day, generally split across lunch and dinner, with milk only ever coming back if a dietitian
specifically asks for it on a given client (no such override exists yet; this just retires milk as
the *default*). This meant reworking one of the most heavily protected fixed values in the solver —
`MILK_COW_CAP`, previously hardcoded into every single anchor variant across every diet type — not
just adding a food-data tag.

**`exchange-solver.ts`**: `MILK_COW_CAP` changed from 1 to 0 for every diet type (vegan already
excluded milk_cow entirely, for an unrelated "no dairy at all" reason — unaffected). In its place,
curd's own exchange type (`milk_skim`) is now fixed at exactly 1 exchange (`MILK_SKIM_CAP`, 320 g —
Curd's own `servingRawG`, close enough to "about 300 g/day") for every non-vegan diet type, tried
first as a single value, not a searched range.

Two designs were tried and rejected before landing on that fixed value:
1. **Floor + wide search span** (mirroring how milk_cow/milk_skim used to share dairy duty): let the
   cost-minimization search freely pick anywhere from 1 to 6 milk_skim exchanges. Rejected on a real
   regeneration — for one real client's target, the solver landed on 3 exchanges (960 g curd), the
   opposite of "only about 300 g," which is a cap, not a minimum.
2. **Hard-fixed at exactly 1, no flexibility at all**: broke a real golden-file client (Sneha,
   TEST-003) that used to clear tolerance specifically via milk_cow's 10 g of "free" fat — milk_skim
   carries 0 g fat, and none of pulse/vegetables/cereal carry fat either, so for her tight ~48 g fat
   ceiling, losing that 10 g pushed the fat-exchange residual just past Table 4.1's coarse 2.5 g grid,
   with zero remaining flexibility anywhere to rescue it (the classic "coarse grid near-miss" already
   documented elsewhere in this file, just newly triggered by this specific change).

The shipped design fixes both problems with the two-attempt/tier machinery the solver already had,
rather than inventing new machinery:
- `SearchFloors` gained a `milkSkimCeiling` field: `{MILK_SKIM_CAP}` (a single value, no band) on
  `attemptTier()`'s base attempt, `MILK_SKIM_CAP + WIDEN_STEP` (a small rescue band) on its widened
  attempt — the same "try strict first, allow a little more only if that narrowly misses" logic
  `vegetable_b`/`fruit` already use for the exact same coarse-grid reason.
- `anchorVariantTiers()` now appends one **milk-rescue tier** per diet type (except vegan) at the very
  end of its tier list — an exact copy of every existing curd-only tier with `milk_cow` restored to
  `MILK_COW_RESCUE` (1) instead of `MILK_COW_CAP` (0). Every curd-only tier, across both floor widths,
  is exhausted first; milk is the absolute last resort, never preferred over a looser curd-only
  egg/meat combination. This is what actually rescues Sneha's case — the widened milk_skim band alone
  doesn't help her (milk_skim carries 0 fat, so no amount of it fixes a fat shortfall), only milk_cow's
  fat contribution does.

**`meal-distributor.ts`**: `milk_skim` was removed from `INDIVISIBLE_TYPES`. It used to share the same
"whole day's count goes to one slot" treatment as `milk_cow` and `meat`/`meat_lean`, but that was only
ever exercised by Raita/Chaach, which were lunch-only foods anyway (nothing to split, so it was moot).
Once curd became eligible at both lunch and dinner with a real per-meal serving size, that same
indivisible treatment started producing a wrong result: dumping the whole day's 320 g into whichever
slot happened to be earliest-allowed, confirmed on a real generated plan landing 100% at breakfast.
`milk_skim` now proportions across its allowed slots by `kcal_share` like any ordinary exchange type —
160 g at lunch and 160 g at dinner are both completely normal curd servings, unlike milk_cow's
"half a glass" problem that justified the indivisible treatment in the first place. `milk_cow` itself
stays indivisible (unaffected — it's essentially never solved for now anyway, only in the rescue tier).

**Two migrations** complete the "lunch and dinner, never breakfast" placement, mirroring the exact
`array_append`/`array_remove` technique `20260810400000_no_milk_at_lunch.sql` and
`20260811040000_shift_milk_cow_to_dinner.sql` already established:
`20260811100000_milk_skim_at_dinner.sql` adds `milk_skim` to dinner's `allowed_exchange_types` (it was
lunch-only before, back when it only ever absorbed milk_cow's overflow); `20260811110000_remove_milk_
skim_from_breakfast.sql` removes it from breakfast, where it had been eligible since the original
exchange system design but is no longer wanted now that curd is the day's primary dairy exchange
rather than a top-up. Curd's own `mealSlots` in `table41_foods.json` was narrowed to `["lunch",
"dinner"]` (dropping breakfast) to match — "Skim milk" (a different, still-breakfast-eligible
milk_skim food) is unaffected and keeps its own breakfast/evening/bedtime role.

Verified end-to-end on real plans, not just unit tests: regenerated Priya's (TEST-001, vegetarian) and
Sneha's (TEST-003, eggetarian) real plans — both land on 320 g curd/day (1 milk_skim exchange), zero
milk, split 160 g/160 g across lunch and dinner (rotating between Curd and Raita, both genuine curd
preparations), never at breakfast. Sneha's real week-1 target didn't even need the milk-rescue tier
(her actual computed target differs slightly from the literal numbers hardcoded in the unit test,
landing on a different, solvable grid alignment) — confirming the rescue tier is a true rare-case
safety net, not something that fires on ordinary generation.

### mid_morning never splits fruit across two foods

A dietitian hard rule: mid_morning must always carry exactly ONE fruit food, however many fruit
exchanges land there — a bigger mid_morning fruit need means a bigger serving of that same fruit,
never a second, different fruit alongside it. This runs directly against the *general* fruit rule
already documented above ("fruit keeps its 2-item split" once a slot's count reaches 2 — the one
part of the original Deepak/Anjali-grounded splitting behavior that survived the vegetable_a/b
reversal): breakfast and evening still split a 2+-exchange fruit requirement across two different
fruits exactly as before, mid_morning now doesn't.

Implemented as a slot-scoped exception, not a change to the general rule: `food-selector-fallback.ts`'s
`isFruitSplit` check gained `&& !NO_FRUIT_SPLIT_SLOTS.has(slot)` (a new one-entry set, `{mid_morning}`)
alongside its existing count/pool-size conditions — a mid_morning fruit item simply falls through to
the generic single-food branch already used for every non-special exchange type, which naturally
gives the food its item's full exchange count instead of splitting it in two.
`food-selector-prompt.ts`'s `ROTATION_RULES` LLM-facing text carries the same exception, so the AI
path and the deterministic fallback path can't disagree about which slot this applies to.

**Follow-up correction — necessary but not sufficient**: a real generated plan still showed fruit
three separate times in one day (Apple + Papaya at breakfast, Guava at mid_morning, Papaya again at
evening). The fix above only stopped the split WITHIN mid_morning — it never addressed fruit ALSO
being *allowed* at breakfast and evening (`meal_templates.allowed_exchange_types`), which is where
`distributeMeals()` was still proportioning a share of the day's fruit regardless, and where
`food-selector-fallback.ts`'s own (unrelated, still-active) 2-item split then put two *different*
fruits at breakfast on top of that. The dietitian's actual rule was broader than first implemented:
one fruit food, in one meal, per day — full stop, not "one fruit per meal but still multiple meals."
`20260811120000_fruit_only_at_mid_morning.sql` removes `fruit` from breakfast's and evening's
`allowed_exchange_types` (same `array_remove` technique as the milk migrations above), leaving
mid_morning as fruit's sole eligible slot system-wide — the solver's existing proportional split
then trivially puts 100% of the day's fruit there, and the earlier NO_FRUIT_SPLIT_SLOTS fix ensures
it lands as one food, not two.

This surfaced a real, previously-latent display quirk: `format-item.ts` shows fruit's `householdMeasure`
verbatim ("1 medium") because fruit has no computed `servingRawG` to pair a gram figure with —
harmless while a food's own per-slot fruit count stayed near 1 (which the old 2-way split kept true
by construction), but consolidating a whole day's fruit into one food regularly produces a count of
3-5+, while the display still always read "1 medium" regardless of that real count. A first attempt
substituted the real count into the phrase ("3 medium", mirroring meat/meat_lean's own "2, 80 g"
`INDIVISIBLE_EXCHANGE_TYPES` carve-out) — reverted on direct dietitian correction: fruit's household
measure should always read "1 medium", never substituting in the exchange count, regardless of how
many exchanges the day's single fruit item actually carries. Dry fruits (Almonds, Walnut —
exchangeType `fat`, not `fruit`) were never affected either way, since they carry a real
`servingRawG` and show a plain gram figure, not a household measure.

Verified on a real regenerated plan: every day shows exactly one fruit food, only at mid_morning,
with its real (now often 3-5) exchange count still stored and priced correctly — only the displayed
household-measure text is now always "1 medium", never substituted — confirmed directly from the DB
before re-exporting the PDF.

### Realistic per-meal portions — pulse and cereal

A direct dietitian complaint, backed by a real generated plan: "Aloo Paratha 10 g" at breakfast and
"Moong dal 120 g" at dinner — both structurally impossible as real single-meal servings, not just
unusual ones. Root-caused to one shared cause, traced with a research table (below) before touching
any code, per the explicit request to ground the fix rather than guess.

**Root cause.** Removing `milk_cow` (see "Curd replaces milk as the default dairy exchange" above)
took away ~8 g of protein a day that used to come "for free." With curd capped at a small fixed
amount, `pulse` — searched with no realistic ceiling (`PULSE_SEARCH_SPAN`, previously 8, i.e. no
effective limit: 240 g raw dal/day) — became the cost search's cheapest remaining lever to close that
gap, landing on 7.5-8.5 exchanges/day (225-255 g), split ~evenly into two ~120 g single-meal servings.
The same oversized pulse ALSO starved `cereal`'s own residual computation (pulse's 17 g carbs/exchange
was already covering most of the carbs target), rounding cereal down to 0.5 exchanges (10 g, less
than one roti) — one root cause, two visible symptoms.

**Reference table** (Table 4.1 exchange → realistic single-meal serving, built before designing the
fix):

| Exchange type | Raw g/exchange | Real 1-exchange equivalent | Realistic per meal | Bug found |
|---|---|---|---|---|
| cereal | 20 | 1 roti | 1-5 exchanges (never &lt;1 when present) | 0.5 exchange (10 g) |
| pulse | 30 | 1 katori dal | 1-2 exchanges (60 g is already a big bowl) | 4-4.5 exchanges/meal (120-135 g) |
| vegetable_a/b, fat, milk_skim | — | — | — | none found — already realistic |

**The fix, and why it took several iterations to land.** `PULSE_SEARCH_SPAN` dropping straight to a
"realistic" 4 broke a real golden client (Sneha, TEST-003): her eggetarian tier 1 (a single egg,
trading lower egg-protein for more pulse — see `anchorVariantTiers()`'s own comment) genuinely needs
6 exchanges to clear tolerance on her exact historical numbers, confirmed by instrumenting every
tier's own search individually rather than guessing at the right number. `PULSE_SEARCH_SPAN` is 6,
not 4 — the empirically-verified minimum that keeps every golden client (and every real regenerated
plan checked this session) solvable, still a large real improvement over the original unbounded 8.
6 exchanges/day split across lunch and dinner is ~90 g raw dal/meal in practice — smaller than the
120-135 g bug, though not quite the idealized 60 g ceiling, because Sneha's exact numbers are the
binding constraint. This is an honest, documented trade-off, not a rounding of the actual bug away.

A companion attempt — flooring cereal's own residual at a fixed minimum (6 exchanges/day) — was tried
and rejected: it broke Sneha's target in the *opposite* direction (her real, correct solution has
*zero* cereal exchanges; forcing 6 pushed her carbs 26% over target). Cereal's residual has no daily
floor for the same reason fat and cereal were never floored before — some genuinely low-carb targets
have little or no cereal need, and that's correct, not a bug to paper over with a flat number.

The part of the bug a solver-level fix couldn't reach — a *small but nonzero* cereal total (like
0.5 exchanges) still being proportionally split across all 4 allowed slots, giving every single one
an unservable fragment — was fixed one layer down instead, in `meal-distributor.ts`:
`MIN_VIABLE_SERVING` (currently just `{cereal: 1}`) and `slotsMeetingMinimumServing()` drop the
lowest-`kcal_share` slot(s) from a type's allowed set until the remaining slots' even proportional
share would clear the minimum, or until only one slot is left — concentrating a small total into
fewer, real servings instead of thinning it across every slot. Scoped to cereal only (the reported
bug); vegetable_a/vegetable_b/fat weren't part of the complaint and their own per-meal amounts were
already realistic on inspection, so extending this further would be an unverified generalization.

Verified against all four golden clients (unchanged, still passing) and two real regenerated plans:
pulse per meal dropped from 120-135 g to 75-105 g, and a small cereal total now lands as one real
(if occasionally modest) serving in a single meal instead of a sub-1-exchange fragment repeated
across four.

A follow-up, narrower fix for the case where the raw carbs residual is small but genuinely
*positive* — rounds to e.g. 0.5 exchanges rather than landing at exactly 0 — sits in
`exchange-solver.ts` itself: `CEREAL_FLOOR_WHEN_WANTED` (4) is applied to `neighboringHalfSteps()`'s
own floor argument only when `rawCereal > 0`, giving `slotsMeetingMinimumServing()` enough of a
total to keep all 4 cereal-eligible slots above its 1-exchange minimum rather than dropping any of
them. When the raw residual is at or below 0 (cereal genuinely not needed at all, Sneha's own case),
the floor stays 0 — the same "only floor a value that's genuinely wanted, never force one that
should be zero" pattern used throughout this section, just applied one level up from
`meal-distributor.ts`'s own slot-dropping logic.

### breakfast and evening can never be structurally empty

A direct dietitian correction: "we can't leave breakfast and evening blank." Root cause, found by
inspecting a real generated plan directly from the DB: `cereal` is a pure carbs residual
(`exchange-solver.ts`) and can legitimately solve to exactly 0 for a real client target — not a bug,
already true of Sneha's own golden case (TEST-003) before this session even started. But
`evening`'s `meal_templates.allowed_exchange_types` was `['cereal']` and *nothing else* — whenever
cereal was 0, evening had structurally nowhere to put anything, every day of that client's week.
Vegetarian breakfast (`['cereal', 'meat', 'fat', 'sugar']`, `meat` always 0 for a vegetarian client)
degraded to a single "Ghee 15 g" line — technically nonzero, not a real meal.

This wasn't unique to one client — any target whose correct answer is cereal=0 hits it, confirmed on
both a real Punjabi vegetarian client (this session) and, separately, on Sneha's own eggetarian
golden target when run past week 1. A flat cereal floor was already tried and rejected earlier in
this same section for breaking her zero-cereal correctness in the opposite direction, so the fix
had to live at the meal-slot-eligibility layer, not the solver.

`20260812130000_pulse_at_breakfast_and_evening.sql` widens both slots' `allowed_exchange_types` to
include `pulse` — chosen because real pulse-exchange foods for exactly this occasion already existed
in the dataset from the 2026-08-12 regional expansion (Besan Cheela, Moong Dal Chilla, Pesarattu,
Bhuna Chana, Misal, Kothimbir Vadi, Uzhunnu Vada, Parippu Vada) but were never reachable there — the
same "eligible by every other check, invisible because a higher layer never asks for it" shape
already fixed three times over for Omelette/Paratha, Oats/Ghee, and Rajasthani lunch pulse, just
surfacing again one layer up. This closes an open question flagged, not resolved, in this same
file's "2026-08-12 regional food expansion" section.

Widening the allowed-types list alone would have been too blunt, though: `distributeMeals()`
proportionally splits *any* nonzero exchange type across every slot that allows it, regardless of
whether that slot already has something else covering the same need — so a normal week (cereal
nonzero) would put a besan-cheela item at breakfast/evening *alongside* an already-complete
paratha/roti, verified as a real regression on Priya's (TEST-001) own week-1 target ("Moong Dal
Chilla 30 g, Methi Paratha 40 g, Ghee 12.5 g" at breakfast — two starches crowding one meal that
used to have one). `meal-distributor.ts`'s `CEREAL_FALLBACK_ONLY_SLOTS` (`{breakfast, evening}`)
closes this: when `counts.cereal > 0` for the week, pulse is excluded from these two slots'
candidate list — the same conditional-exclusion shape as `MEAT_CONFLICTING_TYPES`, just keyed off
the week's cereal total instead of a same-slot meat item, and with the same "only exclude if a
slot actually remains" guard (moot here, since lunch/dinner always still allow pulse).

A second, independent display bug surfaced once these pulse foods actually became reachable for the
first time: `meal-composition.ts` unconditionally renders every pulse item as `"{Food Name} Curry"`
— correct for an actual dal preparation (Rajma Curry, Chana dal Curry) but wrong for a food whose own
name already *is* the complete dish ("Besan Cheela Curry" is not a real dish). This tag/name mismatch
existed in the dataset since the regional expansion but was invisible until now, since none of these
foods could previously be selected at all. Fixed with a new `already_named_dish` tag (Besan Cheela,
Moong Dal Chilla, Pesarattu, Bhuna Chana, Misal, Kothimbir Vadi, Uzhunnu Vada, Parippu Vada — every
pancake/fritter/roasted-snack pulse food currently in the dataset) that `composeMealDisplay()` checks
before appending "Curry", keeping the food's bare name instead — the same tag-driven pattern as
`salad`/`cooking_fat`/`no_cooking_fat` elsewhere in this file.

Verified end-to-end on real regenerated plans, not just unit tests: riya's (Punjabi vegetarian,
zero-cereal week) breakfast now shows "Besan Cheela (45 g)" with Ghee alongside it, and evening
shows the same dish alone, every day of the week, weekly-average macros still landing within
tolerance of target (1.06% on the worst macro). Priya's (TEST-001) own week-1 target (cereal=8, a
normal week) confirmed unaffected — breakfast and evening are back to a single cereal-based dish
each, no pulse item alongside it.

### 2026-08-12 pulse-breakfast/evening regional expansion (10 new foods, 2 widened)

The fix above unblocked breakfast/evening *structurally*, but auditing every region afterward found
the actual food-level coverage was wildly uneven — Besan Cheela (`regions: [north_indian, punjabi,
rajasthani]`) was the ONLY pulse food eligible at Punjabi/Rajasthani breakfast or evening, so it
appeared every single day with zero rotation (a direct dietitian complaint: "only besan chilla is
added"), and Gujarati/Bengali had ZERO pulse foods tagged for either slot at all — meaning a
Gujarati or Bengali client whose target genuinely needs no cereal would still hit the exact blank-
slot bug the migration above was meant to fix, just for a different reason (no eligible food, not
no eligible slot).

Ran 7 parallel research passes (one per region needing it — north_indian already had 2 breakfast/3
evening options, skipped), each given the same constraint set: a real, named dish (a pancake,
fritter, or roasted/dry snack whose own name is already the complete dish — never a wet dal curry,
those already exist for lunch/dinner), built primarily from a pulse/legume/besan base (not
rice/wheat-forward), a genuine breakfast and/or evening tea-time occasion, and no duplication of
anything already seeded for that region. Each pass was explicitly told to report fewer dishes (or
zero) rather than force a bad fit, and to flag jain/vegan fitness and confidence level per dish
rather than assume it.

**Result, 10 new foods across 6 regions:**
- **Gujarati** (0 → 2): Ganthiya (breakfast+evening, deep-fried besan-strand farsan, jain/vegan by
  default) and Chorafali (evening, urad-dal-flour crisps, jain/vegan; minor caveat — some recipes
  fold in a small amount of rice flour alongside the dal flour for crispness).
- **Bengali** (0 → 2): Ghugni (breakfast+evening, dried-yellow-pea preparation, a genuine Kolkata
  street/tiffin staple; standard recipe has onion/ginger so NOT tagged jain here, though a named
  onion-garlic-free festival variant — Niramish Ghugni — exists for a future separate row) and Daler
  Bora (evening, ground masoor dal fritter, vegan but not jain — no onion-garlic-free variant found).
- **Rajasthani** (evening: 1 → 4): Bikaneri Bhujia (moth-bean/besan namkeen strands, jain/vegan in
  the traditional recipe — some commercial brands add garlic powder) and Moong Dal Pakoda (ground
  moong dal fritter, vegan; a jain variant is documented but not confirmed as the default, so not
  tagged jain pending a dietitian call).
- **Hyderabadi** (1 → 3 at both slots): Pesara Garelu (moong dal vada, distinct from the already-
  seeded Pesarattu crepe) and Minapa Garelu (urad dal vada — the genuine Telugu/Andhra regional name
  for the same preparation already seeded as south_indian's "Uzhunnu Vada," same alias convention as
  Poli/Toop/Bhaji). Both vegan; onion is the common default in published recipes for both, so neither
  is tagged jain.
- **Maharashtrian** (breakfast: 1 → 2): Besan Dhirde — the Marathi name/alias for the same
  preparation as Besan Cheela, same alias convention as above; traditional recipe (used for religious
  naivedhyam offerings) is onion-and-garlic-free, so jain/vegan.
- **South Indian** (breakfast: 1 → 2): Hesaru Bele Dose — Karnataka's own name for a pure moong-dal
  dosa (no rice, no fermentation), the standalone-dish counterpart to Sambar's side-curry role; the
  region's own alias of the Pesarattu/Pesara Garelu/Minapa Garelu dish family. No onion/garlic in any
  recipe found; jain/vegan (ginger is present but trivially omittable without changing the dish).

**2 widened, no new rows needed** — the cleanest fix in this whole pass, because the food already
existed: Moong Dal Chilla and Bhuna Chana were seeded for `north_indian` only, but research confirmed
both are genuinely Punjabi dishes too (multiple sources name Moong Dal Chilla directly as Punjabi,
not just generic north Indian) and Bhuna Chana's dry-roasted-chana tradition spans the whole Hindi
belt Punjab and Rajasthan sit within. `regions` widened to `[north_indian, punjabi]` and `[north_
indian, punjabi, rajasthani]` respectively — same technique as Paratha's own rajasthani-region
widening for the Omelette-pairing fix above.

All 10 new rows follow the existing schema exactly: `pulse`, 30 g raw per exchange, `already_named_
dish` tag (so `meal-composition.ts` doesn't wrongly append "Curry" to a pancake/fritter/snack name —
see the naming-bug fix above), `mealSlots` scoped honestly to whichever occasion the research
actually supported (several are evening-only because the breakfast claim was too weak to include —
e.g. Chorafali, Bikaneri Bhujia, Moong Dal Pakoda, Daler Bora), plus lunch/dinner for reachability
matching every other besan-snack row's own precedent, and a `notes` field carrying the confidence
level and any caveat, ending "UNVERIFIED — pending dietitian confirmation."

Rejected candidates, for traceability (not seeded): Besan Pudla (often blended with rava/vegetables,
not a clean single exchange), Sev (more a garnish/mixing ingredient than a standalone plated dish),
Zunka/Jhunka (Maharashtrian, real and cleanly pulse, but breakfast is a secondary occasion to lunch/
dinner, not primary), Cherupayar Dosa (Kerala, real dish but commonly made with rice and/or shallots
— composition too recipe-dependent to call clean pulse), Adai/Uddina Dosa/Ulundu Dosai (all
genuinely rice-forward or contradictory on composition), Sunnundalu (jaggery/ghee-forward, a sweet,
not a clean pulse exchange), Mirchi Vada/Pyaaz Pakoda/Bread Pakora (all genuinely mixed-exchange-type
dishes), Punugulu/Chegodilu (rice-flour-forward), Sundal (real, but its occasion is evening snack/
prasadam, not breakfast), Khichiya Papad (a meal accompaniment, not standalone), Dal-Moth/Chana Jor
Garam (multi-ingredient mixtures or weak on regional grounding).

Verified end-to-end on real regenerated plans: riya's roadmap re-solved at region=gujarati and
region=bengali (both landing on the same zero-cereal target already established above) now shows
Ganthiya at breakfast / Chorafali at evening, and Ghugni at breakfast / Daler Bora at evening,
respectively — both regions' first-ever non-blank pulse-fallback breakfast/evening. A fresh Punjabi
regeneration confirms real day-to-day rotation for the first time: breakfast alternates Besan
Cheela/Moong Dal Chilla, evening alternates Besan Cheela/Bhuna Chana — resolving the original "only
besan chilla is added" complaint. Full suite still 334/335 (same pre-existing, unrelated DB-
connectivity failure).

### Dalia added to Punjabi breakfast

A direct dietitian request: "add dalia also in breakfast options." Dalia (broken-wheat porridge)
was seeded `regions: ['north_indian']` only, and punjabi's own breakfast archetype list had no
porridge option at all — same "eligible by every other check, invisible because the region tag /
archetype union never reaches it" shape as Paratha's earlier rajasthani widening and the Rajasthani
lunch pulse fix. Fixed the same way: widened Dalia's `regions` to add `punjabi` (both are wheat-belt
regions where daliya is an everyday breakfast, not a fabricated regional claim) and added
`punjabi_dalia_meal` (`20260812140000_dalia_in_punjabi_breakfast.sql`), mirroring
`north_indian_dalia_meal` exactly — one required cereal component, no fat component (a porridge
isn't conventionally topped with ghee the way a paratha is, same reasoning already established for
Oats/Dalia/Upma above). Verified by loading punjabi's real breakfast archetype candidates from the
DB and running `selectArchetypesForWeek` across 30 simulated weeks: `punjabi_dalia_meal` lands on
48/210 breakfast-days (~23%), rotating alongside the paratha varieties and the already-seeded
`punjabi_oats_meal`, not starved out by their higher authenticity scores.

A second per-100g dish-nutrition architecture — the "dish-gram engine" — briefly existed alongside
this section as a parallel, flagged-off-by-default addition (2026-08-18), for a genuinely different
reason than the INDB/USDA pipeline rejected earlier in this section's history: it let the LLM compose
real, complete, already-named regional dishes (grounded against a 525-dish per-100g CSV) instead of
being constrained to Table 4.1's 11 abstract categories. It was fully replaced one day later
(2026-08-19) by the recipe engine (see "The recipe engine" below) — not because the underlying idea
was wrong, but because live testing against a real non-vegetarian client exposed a hard data-
completeness limit (only 2 of 64 non-veg dishes in that 525-dish CSV were lean), and a much larger,
richer recipe dataset became available with a cleaner division of labour: the LLM only ever names
recipes, code alone computes every quantity. Every dish-gram-engine table, file, and CLAUDE.md
subsection this paragraph used to link to has been deleted — this paragraph is kept, not removed,
purely so the "why did we try a 525-dish CSV and then stop" history stays legible, the same "keep
history honest, add rather than delete" discipline the INDB/USDA paragraph above already established.
Everything in this "The exchange system" section is unaffected by any of this and stays the default,
live generation path.

## The recipe engine

A full replacement (2026-08-19) of the retired dish-gram engine, gated by `env.RECIPE_ENGINE_ENABLED`
(default **off**) in `route.ts`, sitting immediately after `weekTargets()` — everything upstream of
it (auth, rate-limit, roadmap/session loading, block-flag checks) is shared, byte-identical code with
the exchange engine. See "THE ONE RULE THAT MATTERS" for how this engine's LLM contract — the
strictest of any engine so far, it never outputs a number at all — holds the platform's core
invariant.

**Why this exists, in one line**: a dietitian wants the LLM to compose a realistic week of meals from
a much larger, richer recipe dataset (1222 real recipes, not 525) purely by *naming* dishes, with
every gram, calorie, and macro figure computed and optimized entirely in code — no LLM arithmetic to
trust or distrust, ever. This is a genuinely cleaner split of responsibility than the dish-gram engine
had (where the model also proposed grams), not just a bigger food table.

### Data model

Three tables, purely additive over the exchange system (`exchange_types`/`foods`/`diet_plan_items`
are untouched) and a full replacement of the deleted `dishes`/`diet_plan_dish_items`:

- **`recipes`** (`src/db/schema.ts`) — one row per CSV recipe. Carries its own `protein_per_100g`/
  `carbs_per_100g`/`fat_per_100g`/`fiber_per_100g` directly, same reasoning the dish-gram engine's
  `dishes` table had: the LLM never computes nutrition, so the source of truth has to live on the row
  itself, not be deferred to a shared exchange table. `kcal_per_100g` is a **generated column**
  (Atwater), same discipline as `exchange_types.kcal` — never trusted from the source CSV's own
  `Energy/100gm` column, which mixes clean numbers with literal `"#VALUE!"` Excel errors. `min_grams`/
  `max_grams`/`ideal_grams` are computed once at ingestion (see below) and read as a thin field by the
  balancer — a real improvement over the dish-gram engine's `dish-serving-limits.ts` regex-matching,
  since this dataset actually authors a serving size per recipe.
- **`recipe_aliases`** — the grounding resolver's alias tier (exact → **alias** → fuzzy), something
  the dish-gram engine's resolver never had. Deterministically generated at ingestion time (paren-
  stripping, `&`/`and` swaps, plural/singular variants — see `recipe-alias-generation.ts`), never an
  LLM call. An alias that would resolve ambiguously to more than one recipe is dropped entirely, never
  guessed at.
- **`diet_plan_recipe_items`** — the leaf item, hanging off the *same* `diet_plan_meals` row every
  engine uses. `grams` is the code-optimized final value; the LLM never proposes one at all (a step
  further than the dish-gram engine, whose LLM at least *guessed* a starting gram figure).
  `protein_per_100g_snapshot`/etc. are snapshotted at generation time, never a live `recipes` join —
  a later CSV re-ingestion correcting a recipe's macros must never retroactively change an
  already-approved historical plan's displayed numbers.
- **`recipe_embeddings`** — a placeholder for a deferred v2 embedding-search grounding tier (see
  "Grounding" below). Created, unpopulated, unindexed. Not read by any code path today.
- **`diet_plans.engine`** (`"exchange" | "recipe"`) — the discriminator. The dish-gram engine's own
  `"dish"` value was retired along with every `engine='dish'` row (deleted by the same migration that
  created these tables, `20260819100000_recipe_engine_pipeline.sql` — including the one real
  dietitian-facing plan that existed with it, accepted as an explicit, confirmed trade-off). It never
  reappears in this enum. `dietPlans` has no dedicated `cuisine` column — the recipe engine pragmatically
  reuses the existing `region` column to carry the cuisine string, the same reuse the dish-gram engine
  made of it.

### Ingestion — `npm run seed:recipes`

Source: `src/db/seed-data/recipe_database.csv` (1224 raw rows, 59 columns — committed into the repo,
not read from a Downloads folder, same reasoning `table41_foods.json` already established). Column
indices (`recipe-csv-parser.ts`) were read directly off the real header row, not guessed — two of the
59 columns ("Base"/"Theme") appear twice under the same header text; only the second, real occurrence
is read.

**Two real data issues, found and resolved before writing any ingestion code, not guessed at**:
1. The literal first data row is a leaked spreadsheet `COUNTA()`-style artifact — every column holds
   a plain row-count number. Filtered by `RECIPE_NAME` being purely numeric; must drop exactly 1 row,
   fails loud if the count is ever different (signals the file changed).
2. Two duplicate-name groups (`scripts/inspect-recipe-duplicates.ts`, a one-off diagnostic, not part
   of the permanent pipeline): "Nutri Pulav" was a byte-identical copy-paste duplicate (dropped
   generically — any two rows sharing a name and every tracked column collapse to the first
   occurrence); "Fish In Lemon Butter Sauce" had two rows differing ONLY in `Category` ("Heavy Meal"
   vs "Light Meal") despite both sharing `Heavy Light="Heavy"` and identical serving data/macros — the
   "Light Meal" row was an inconsistent mislabel of the same recipe, not a genuinely lighter portion,
   and is dropped by an explicit, hardcoded exception in `recipe-csv-parser.ts`. Net: 1224 raw → 1222
   real recipes. Any *future* CSV update introducing a genuine name collision (two different recipes
   sharing a name) is reported via `duplicates`, not silently guessed at — `seed-recipes.ts` refuses
   to proceed until it's empty.

**Classification, all profiled against the real distinct-value distributions before being coded, not
assumed**:
- `recipe-diet-classifier.ts` — token-based (the free-text `Diet Pref` column, not an ingredient
  list, unlike the deleted dish engine's classifier), positive-list convention: a plain vegetarian
  recipe (no meat, no egg) is listed safe for vegetarian **and** eggetarian **and** non_vegetarian
  clients (anyone can eat vegetarian food); vegan/jain are only added when the source explicitly
  confirms them, never inferred from a token's absence. Covers all 25 real distinct `Diet Pref`
  values found in the file (including every real typo variant: `OVOVETARAIN`, `OVO VEGETRAIAN`,
  `NONVEGTARIAN`, etc.) with zero `unclassifiedTokens`.
- `recipe-cuisine-mapping.ts` — normalizes the real 15 distinct `Cuisine` values onto 6:
  `General`/`North Indian`/`South Indian`/`Maharashtrian`/`Bengali`/`Gujarati`. Per a direct,
  confirmed decision: every non-Indian or low-volume cuisine (Italian, Chinese, Mediterranean,
  Mexican, Exotic, Parsi, Japanese, Goan — ~71 rows total) is **relabeled to `"General"` at
  ingestion**, a deliberate one-way transformation (the original cuisine tag survives only in
  `raw_csv_row`, never in `recipes.cuisine` itself) that permanently folds them into the
  always-eligible pool.
- `recipe-season-mapping.ts` — `Winter`/`Summer`/`All Season` → `winter`/`summer`/`all_year`. No
  `monsoon` tag exists in this data at all — a monsoon-week generation's eligible pool is exactly the
  `all_year` recipes (452 of 1222), an accepted narrowing, not a fabricated claim, same discipline
  CLAUDE.md's exchange-system seasonal tagging already established.
- `recipe-allergen-normalize.ts` — the real `Allergen` column is genuinely messy (315 distinct raw
  combinations of ~15 atomic concepts, real casing/typo drift: `"CITRUS"` vs `"Citrus"`,
  `"Onion/Garli"` vs `"Onion/Garlic"`, `"Lactos"` vs `"Lactose"`) — normalized to a fixed tag
  vocabulary, with `wheat`/`Wheat` merged into `gluten` (confirmed: the same concept duplicated by a
  casing artifact, not two distinct tags) while `Nut` and `Peanuts` deliberately stay separate (they
  co-occur as two different tokens in the same cell repeatedly, matching dietplat's own `ALLERGENS`
  vocab already having both). `containsEgg`/`containsFish`/`containsSeafood` from the diet classifier
  are folded into `allergen_tags` too (`egg`/`fish`/`seafood`) — the Allergen column itself never
  tags egg content, so this is the actually-reliable signal for a hard egg exclusion.
- `recipe-quantity-normalize.ts` — `minGrams`/`maxGrams`/`idealGrams` derived unit-agnostically from
  `perUnitGrams = Wt.of Measured Amt. (grams) / Quantity per serving (number)`, never parsing *what*
  a unit ("Cup", "tikki") means. Handles text ranges (`"2-3 egg whites"` → midpoint, flagged), the one
  known stray case where `Min/Max Quantity` itself carries a unit suffix (treated as already-grams,
  flagged for manual review — e.g. the real "Bel Fruit" row), and a 5–1000g plausibility envelope;
  anything unparseable or implausible drops to a `recipeCategoryBucket()`-keyed fallback table,
  recorded via `serving_limits_source = 'fallback_category_default'` so a dietitian can audit which
  recipes are running on a guessed portion.
- `priority` (raw column 58) is real text — `"Primary"`/`"Secondary"` — **not an integer**, a wrong
  initial assumption caught by profiling the real column before writing the schema, not after.

**`Macro Category`, `Commonality`, and `Priority`** — per a direct instruction, these are real inputs,
not stored-but-unused metadata: `macro_category` (44% blank) is a prompt-table column plus a
fallback-selector complementary-balance tie-breaker; `commonality` (raw 0/1/2) biases the prompt
toward common, everyday combinations and weights the fallback selector's rotation; `priority`
(`Primary`/`Secondary`) is a secondary rotation tie-breaker. `seed-recipes.ts` prints the real
distribution of both at the end of every run — the exact weighting curve is tuned against that real
output, not fixed in advance.

### Generation pipeline (`src/lib/plan/recipe-*.ts`)

The LLM's entire contract (`recipe-schema.ts`): `{ dayIndex, meals: [{ slot, items: [{ name }] }] }`
— **no grams field exists anywhere in this schema**, at either the whole-week or the day-retry parse
path. `recipe-prompt.ts` shows the model the day's macro targets for context and a recipe table
(name/category/Main-Mid/cuisine/macro category/commonality/macros-per-100g), with an explicit closing
instruction that it will never see or produce a gram/calorie/macro number. Unlike the dish-gram
engine's prompt, there is **no per-meal target, no meal-percentage split, no fat/carb-balance rule at
all** — that whole class of rule existed only because the old LLM also picked grams; this one never
does.

**Grounding** (`recipe-grounding.ts`) — the same tiered chain the dish-gram engine proved out, with a
new tier this dataset earns: `exact → alias → parenthetical-stripped exact/alias → base-name →
unique-prefix → fuzzy (Levenshtein, 0.82 floor, plus a minimum margin over the runner-up — tightened
from the dish engine's bare floor since this pool is 2.3× larger) → null`. The final `null` is the
explicit, intentionally-unimplemented seam for a **deferred v2 embedding-search tier** — confirmed
with the user: exact→alias→fuzzy is expected to cover real usage (the dish-gram engine's weaker
exact/fuzzy-only chain, with no alias tier at all, saw zero unresolved names against a smaller pool),
and standing up pgvector + embedding generation + a live embedding call on the hot path isn't
justified pre-emptively. `recipe_embeddings` exists purely as that seam's landing spot.

**Optimization** (`recipe-balancer.ts`) — the same box-constrained weighted least-squares
(Lee–Seung multiplicative update) solver the dish-gram engine proved out, run **once per day**,
pooling every recipe across every meal that day against the day's **5** targets (kcal/protein/carbs/
fat/fiber — a macro the dish-gram engine never tracked at all):
`{kcal:0.4, proteinG:2.0, carbsG:1.0, fatG:1.0, fiberG:0.5}`, 200 iterations, `[0.3,3]` damped step,
hard-clamped every iteration to each recipe's real authored `[minGrams, maxGrams]`. Seeded at
`x0 = recipe.idealGrams` — the recipe's own authored typical portion, a materially better starting
point than the dish-gram engine had (which had to seed from the LLM's own guessed grams, since there
was no per-recipe "typical" figure at all).

**Two extra validation layers, both new, both run independently of the macro check**:
- `recipe-plausibility-validate.ts` — a day can be perfectly on-macro and still be a nonsensical
  plate. Checks: no structurally empty meal, no duplicate recipe within one meal, every meal has at
  least one `main_or_mid='main'` item, no meal stacks more than one `heavy_meal`/`dessert`-bucketed
  recipe together (the same "implausible plate" shape the dish-gram engine's evening-snack-stacking
  fix once addressed), and a defense-in-depth re-check that every grounded item still satisfies the
  client's diet-type/cuisine/allergen constraints (the prompt pool was pre-filtered, but a fuzzy-tier
  resolution could in principle land on an ineligible recipe).
- `recipe-variety-tracker.ts` — recipe repetition is tracked and enforced in code
  (`MAX_RECIPE_REPEATS_PER_WEEK = 2`), not left as a hopeful prompt instruction alone (the prompt's
  own "no recipe >2x" rule stays too, as a first line of defense). Computed once after the whole-week
  grounding (a genuinely week-level signal); a day is flagged for retry the moment a recipe's
  cumulative count, in day order, exceeds the cap.

### Tolerance and reject semantics — a real ethos change from every prior engine

`RECIPE_MACRO_TOLERANCE = 0.08` (`recipe-validate.ts`), checked per-day against kcal/protein/carbs/fat
**only** — fiber is deliberately excluded (see "Fiber" below). This starts deliberately looser than
the literal spec ask of ±5%: real cooked recipes with real authored serving ranges make 5% per-day a
materially harder bar than either the exchange engine (which hits its target to arbitrary precision
before any food is picked) or the dish-gram engine (whose final gate was a 5% **weekly-average**, not
per-day, check) ever had to clear. `RECIPE_MACRO_TOLERANCE` is a named, easily-tunable constant for
exactly this reason — tighten it toward 5% only once real live-generation data proves convergence,
never loosen it further without an equally explicit decision.

`recipe-selector.ts` runs two phases: **(1) whole-week**, up to 3 attempts with backoff, falling back
to `recipe-selector-fallback.ts`'s deterministic selector after 3 straight failures (skipping phase 2
entirely — a model that failed 3x is very likely unreachable); **(2) per-day retry**, LLM path only,
`MAX_DAY_RETRIES = 3` — a day retries if **any** of three independent checks fail: macro tolerance,
plausibility, or variety, with the retry prompt naming exactly which problem(s) fired.

**The reject gate is genuinely stricter than every prior engine's philosophy.** Both the exchange and
dish-gram engines guarantee generation always succeeds, worst case with honest warnings. The recipe
engine does not: any day still failing macro tolerance, plausibility, **or** variety after every retry
**rejects the entire plan** — no DB write, an error response naming exactly which day/check failed.
This applies to the deterministic fallback too, with **no exemption** — unlike the dish-gram engine's
fallback, which skipped retries and was accepted with warnings regardless. There is no dietitian
manual-override affordance in v1 (a `roadmapOverrides`-style "save anyway" was deliberately not
built) — ship exactly what was asked for, and add an override only if real rejection rate turns out
to be an operational problem, not pre-emptively.

**A serving-limit hit is advisory, not blocking (2026-08-25 fix).** The three checks above are the
whole gate; `cappedRecipeNames` — a recipe landing within `CAP_MARGIN_G` (2 g) of its own authored
min/max — is deliberately NOT among them. It used to be, and that was an unintended dead-end rather
than a decision: caps were absent from `dayNeedsRetry()` but present in the final gate's
`diagnoseDay()`, so a day whose ONLY flaw was a capped serving was never selected for retry, yet
still rejected the whole plan — a failure the retry loop was structurally incapable of repairing.
The giveaway was `selectRecipes()`'s own `warnings` block: it collects exactly these capped names and
was provably unreachable with anything in it, since any capped day threw first. Real serving data
makes this bite constantly rather than rarely — of 1222 ingested recipes, 18% have a zero-width range
(`min == max`, so they trip the check no matter what the balancer does) and only 15% have real
headroom in both directions; in a single cuisine pool it is worse (48 of 416 for North Indian
non-veg). The split now lives in `recipe-day-diagnosis.ts` (extracted from `recipe-selector.ts` only
so it is unit-testable — that file imports `openai-client.ts`, which validates server env at module
load): `blockingProblems()` is the write gate and mirrors `dayNeedsRetry()` exactly, `diagnoseDay()`
is a strict superset that still reports caps to the model on a retry, and caps now reach the returned
`warnings` as originally designed. This is NOT a softening of the reject-on-failure ethos in the "Do
not" list below — macro tolerance, plausibility and variety reject exactly as before; a check that
could never be retried into compliance simply stopped being a gate.

### Best-of-N generation (2026-09-08) — the default path

`RECIPE_BEST_OF_N` (env, **default 3**) makes `selectRecipes()` run N *independent* whole-week calls
with **no day retries**, and keep the week closest to target on its **weekly average**. Setting it to
`0` restores the original per-day-retry path, untouched, as an escape hatch.

**Why this replaced the retry loop.** Measured on real OpenAI runs against Aadi (TEST-004, North
Indian) — not reasoned from first principles: the retry path spent **19 calls (~$1)**, of which 18
were day-retries, and repaired **exactly one day** before the week was rejected anyway. The day-retry
loop kept steering toward the same low-density snack recipes it was already stuck on; three retries
per day was nowhere near enough to escape that basin. Five *independent* samples produce genuinely
different weeks instead of five variations of one bad one. Best-of-5 costs **5 calls (~$0.15)** and,
on the first real run, produced an accepted week at **2.89%** weekly-average deviation (protein
+0.2%, kcal −0.2%), with 2 of the 5 candidates clearing the gate outright.

**The acceptance rule genuinely changed for this path, and that was an explicit decision, not drift.**
Best-of-N gates on the **weekly average** (`isRecipeWeekOffTarget`) rather than requiring all 7 days
to clear the per-day ±8% tolerance. This is not a new standard invented for convenience — it is
exactly what the exchange engine has always held itself to (`assertWeeklyAverageWithinTolerance`, see
"Day-to-day macro variety, weekly average pinned to target"), so the recipe engine was until now held
to a *stricter* rule than the platform's own established clinical one. The measured reality that
forced the question: per-day, a single-call week lands 0–2 of 7 days inside tolerance, while its
weekly average lands within tolerance on every macro.

**This is NOT the "always succeeds with warnings" softening the "Do not" list forbids.** A week whose
*average* misses is still **rejected outright, with no DB write** — that guarantee is intact. What
changed is which quantity is measured, not whether failure is tolerated. Per-day macro misses,
plausibility problems, variety breaches and serving-limit hits do not vanish either: `bestOfNWarnings()`
surfaces every one of them in `RecipeSelectionResult.warnings`, so a dietitian sees exactly how much
each day wobbles. Nothing is hidden; it simply no longer blocks.

**Ranking** lives in `recipe-week-score.ts` (extracted so it is unit-testable — `recipe-selector.ts`
imports `openai-client.ts`, which validates server env at module load; same reason
`recipe-day-diagnosis.ts` was extracted). `weeklyDeviationScore()` is the mean absolute deviation of
the weekly average across kcal/protein/carbs/fat, as a fraction directly comparable to
`RECIPE_MACRO_TOLERANCE`; fiber is excluded for the same soft-target reason `recipe-validate.ts`
excludes it. Days that cancel out — one low, one high — score well *by design*, since the weekly
average is what the gate measures. Plausibility and variety counts are deliberately **not** folded
into the score: mixing them in would quietly reintroduce the per-day gate this strategy exists to
replace. Ties resolve to the earliest candidate, so a fixed input order gives a deterministic winner
rather than depending on sort stability.

**Ranking is two-level, and the second level was a real bug fixed before first deploy.** A candidate
that *clears* the gate always beats one that does not, whatever their scores; ties within each group
break on the lower score. Ranking on the score alone — the first implementation — was wrong because
`isRecipeWeekOffTarget` checks **each macro individually** against the tolerance while the mean can
hide a single macro far outside it. Observed on a real run: a candidate scored 3.84% mean and still
failed, because one macro was over 8%. Picking purely by mean can therefore choose a *failing* week
over a *passing* one and reject the whole plan when an acceptable week was right there. It did not
bite on that run only because the lowest-mean candidate happened to also pass.

**Operational note — why the default is 3, not 5.** Measured call latency is ~5-10s, so 5 attempts run
~45-50s end to end. Vercel **Hobby caps functions at 60s**, which leaves no real margin (a single slow
call, or a cold start, times the request out *after* the OpenAI calls are already billed). 3 attempts
run ~30s. `route.ts`'s `maxDuration` is **60** to match that ceiling; raise both together if the
deployment moves to a plan with a longer one. This also fixes the constraint the retry path had:
19-22 calls ran ~65-90s against a `maxDuration = 120` that itself required Vercel Pro. `attemptWholeWeek()` is shared by both paths so they
cannot drift apart on how a week is built, and the deterministic fallback selector is still used, but
only if *every* one of the N calls failed.

### Recipe pool filter — nutritionally-empty rows

`recipe-pool-filters.ts`, applied in `route.ts` (and the dev tools' shared input builder) *before the
model sees the pool*. ONE filter, found by inspecting a real rejected week.

A row claiming to be food while declaring 0 kcal is dropped. Two kinds were being plated to
dietitians: the placeholders `Any Veg` and `Any Veg (W/O Aloo, Arbi, Paneer, Soy)` — served as
"Any Veg (150 g)" on three days of a real plan — and, worse, genuinely mis-ingested foods
(`Watermelon`, `Moong Dal Idli`, `Kandi Pachadi` all at 0 kcal). The second kind is more damaging
than a placeholder: the balancer will happily assign 250 g of a zero-macro idli, so the day's
arithmetic still "adds up" while the client is told to eat something the plan does not count.
Deliberately **not** a blanket "0 kcal is invalid" rule — `Lukewarm Water`, `Apple Cider Vinegar` and
the green teas are legitimately 0 and stay eligible, gated by a small
`ZERO_KCAL_PLAUSIBLE_CATEGORIES` set (Morning Water / Bedtime Water / Tea).

Applied at **eligibility time**, not as an `is_active` flag written at ingestion — deliberately.
It is code, so it takes effect with no reseed and a later `npm run seed:recipes` cannot silently
undo it, which is exactly the failure mode recorded above for the Milk/`milk_cow` `mealSlots`
regression.

**A second filter was added here, measured, and REMOVED — recorded so it is not reinvented.** It
dropped recipes whose fat share of calories exceeded the client's own target share by some factor.
Measured against a real client (Aadi, TEST-004) over three live runs it made convergence
monotonically worse and never better:

| fat headroom | pool | weekly deviation | result |
|---|---|---|---|
| 1.5x | 281 | 13.0% | REJECTED |
| 2.5x | 363 | 5.0% | REJECTED |
| removed | 392 | worst macro 4.4% | **ACCEPTED** |

The premise was simply wrong. The pool does not skew fatty — its median fat share is **23% against a
27% target**, already under. Removing calorie-dense recipes only made the fat target harder to
reach, and fat then ran UNDER on every day (14-49%) instead of over. The observation that motivated
the filter was real — a rejected week ran fat over on all 7 days with nearly every dish pinned at a
serving bound, and `recipe-balancer.ts` can only scale grams, never fix a dish set's ratio — but that
is a **selection** problem, which dishes the model picks out of a balanced pool. It has to be fixed
where it happens (the prompt, or a check on the chosen set). Narrowing the pool to compensate treated
the symptom and broke what was working. **Over-fat selection remains open.**

### Fiber — soft target, still logged

`weekTargets()` produces a real `fibreG` daily target, and the recipe engine is the first engine to
actually track fiber end-to-end — but it is a **soft** target: the balancer steers toward it (lightly
weighted, 0.5 vs. 2.0 for protein), and `recipe-validate.ts` computes `fiberDeviationPct` for every
day, but nothing ever rejects a plan for missing fiber alone. This is a deliberate reading of a real
tension in the spec (fiber is a listed daily target, but absent from the literal ±5% validation list)
— treating it as a 5th simultaneous hard constraint would meaningfully raise real non-convergence
risk for no confirmed clinical requirement.

Surfacing this required a genuinely additive change to shared display code: `AchievedMacros`
(`table-4-1.ts`) and `PlanViewItem`/`WeeklySummaryRow` (`plan-guidelines.ts`) all gained an
**optional** `fiberG` field — the same low-risk shape of change the dish-gram engine's
`exchangeType: ExchangeCode | null` widening already proved safe. Only the recipe engine's own
adapter (`recipe-view-adapter.ts`) populates it; the exchange engine's adapter is unaffected (the
field is simply absent for those items, same as before this change — `exchange_types.fiber_g` exists
in the DB but stays unsurfaced for the exchange engine, out of scope here).

### View-model adapter

Mirrors the dish-gram engine's own adapter pattern almost exactly: `recipe-view-adapter.ts`'s
`recipeItemToPlanViewItem()` computes every macro from the **snapshot** columns, never a live
`recipes` join; `exchangeType`/`dishFamilyId` are `null`/`[]`, which every existing
`exchangeType`-keyed check elsewhere (`format-item.ts`, `meal-composition.ts`,
`vegetable-dish-naming.ts`) already no-ops correctly against, with zero further changes needed in
those three files. `recipe-guidelines.ts` is a real sibling to `plan-guidelines.ts`'s
`buildGuidelines()` (not a branch inside it) — several of that function's bullets are pure exchange
vocabulary with no recipe-engine analog, and its raw-weight-cereal/pulse bullet is actively wrong for
recipes (CSV grams are as-served/cooked weight, the opposite convention, stated explicitly in the
recipe engine's own guidelines rather than silently reusing the misleading claim).

**Explicit v1 non-goal, same as the dish-gram engine before it**: no swap support for recipe-engine
plan items — the swap action keys off `diet_plan_items.exchange_type`, a column
`diet_plan_recipe_items` doesn't have, so it naturally finds no row for a recipe item. Swapping a
recipe would mean re-running grounding + rebalancing for one substitution, a genuinely separate
feature, not implemented here.

### Rollout

`RECIPE_ENGINE_ENABLED` defaults off everywhere. Both engines coexist in `route.ts`, gated by one
`if` right after `weekTargets()`; the request body's `engine` field defaults to `"exchange"` when a
caller omits it entirely, so both existing UI callers (`actions-bar.tsx`, `plan-actions-bar.tsx`) work
byte-identically unchanged — a caller wanting the recipe engine must pass `engine: "recipe"` and
`cuisine` explicitly, which no UI does yet (a real, open follow-up, not solved here). Flip the flag
locally only once live-generation testing at the relaxed 8% tolerance shows consistent convergence.

## Dietitian knowledge layer

By 2026-08-20, live testing on the recipe engine (real NVIDIA calls, both 8B-tier attempts this
session) had already surfaced a problem one layer up from anything grounding/balancing/validation can
fix: a plan can pass every existing check — macro tolerance, plausibility, variety, diet/allergen
eligibility — and still not read like something a real Indian dietitian composed. Nothing in the
pipeline up to that point had any concept of regional identity, common-vs-rare food pairings, or how
a fat-loss week should be built differently from a muscle-gain one — `recipe-plausibility-validate.ts`
and `recipe-variety-tracker.ts` only ever checked *structural* things (no duplicate recipe in a meal,
no two heavy dishes stacked), never dietitian domain reasoning.

This is a **separate knowledge base from `recipes`**, by design — the recipe table stays the sole
source of truth for dish names and nutrition; this layer only ever adds descriptive guidance text to
the prompt, never a recipe, a number, or a new field in the LLM's output contract. It is a genuine
extension of "THE ONE RULE THAT MATTERS": the recipe engine already tightened that rule to "the LLM
never proposes a gram, calorie, or macro number of any kind, ever"; this layer adds "and it now gets
better *descriptive* material to reason with, not more numeric responsibility."

### Recommendation: hybrid, not pure RAG, not fine-tuning, not pure rules

Fine-tuning was rejected outright — no training/ML-ops infra exists anywhere in this stack (only an
inference client), and a fine-tune cycle can't be corrected as fast, cheaply, or auditably as this
project's own proven loop, visible throughout this entire file's history: a dietitian gives feedback,
an engineer encodes it into a versioned source file, a seed script ingests it, this file records why.
Pure hardcoded rules don't scale to "sounds like an experienced dietitian" nuance on their own, but
they stay essential as the backstop that was already there. Pure RAG with no backstop was rejected
too — this session's own live NVIDIA test already proved the current 8B model ignores explicit prompt
instructions (the variety-cap rule was ignored, fat consistently ran low, all 7 days were rejected
after retries) — a retrieved chunk is no more guaranteed to be obeyed than that was. The shipped design
is a **hybrid**: this layer shapes the LLM's soft choices; `recipe-plausibility-validate.ts`,
`recipe-variety-tracker.ts`, and `recipe-validate.ts`'s tolerance gate are **completely unmodified** by
this layer and remain the only hard gate. A knowledge chunk whose guidance proves reliably necessary
over time — dietitians keep correcting the same mistake even with it present — is a candidate to
graduate into a new hardcoded plausibility check later, mirroring this project's own repeated history
(the `salad` tag → hard pool exclusion; `cooking_fat`/`no_cooking_fat` → hard degrade rule for Oats).
Not attempted yet — just the same open path this file already documents elsewhere.

### Data model — a separate knowledge base, not more recipe metadata

Three new tables, purely additive: `dietitian_knowledge_docs` (one row per source markdown file —
`slug`, `title`, `category` from a fixed 10-value enum, `status: draft|confirmed`, `version`,
`confirmedBy`/`confirmedAt`, and the four retrieval-filter arrays `regions`/`dietTypes`/`goals`/
`mealSlots`), `dietitian_knowledge_chunks` (one row per markdown H2 section — the actual
retrieval/injection unit), and `dietitian_knowledge_embeddings` — an unpopulated v2 placeholder,
mirroring `recipe_embeddings`' own exact precedent (same 1536-dim column, same "no ANN index until a
model is chosen" posture), not wired into anything in v1. `plan_generation_runs` gained a nullable
`knowledge_chunks_injected jsonb` audit column, sibling to its existing nullable `raw_response`/`model`
columns — `{injected: [...], droppedForBudget: [...]}` chunk slugs, so a dietitian can trace which
knowledge shaped a specific generated plan, without needing to snapshot knowledge content onto
`diet_plans` itself (knowledge is guidance, not a numeric fact the way recipe macros are).

An `EMPTY filter array means "applies universally"` — the exact same wildcard convention
`foods.seasons`'s `"all_year"` already established. `regions` values reuse the exact `RecipeCuisine`
strings already flowing through `RecipeSelectorInput.cuisine`, not a second region vocabulary.

### Ingestion — `npm run seed:knowledge`

Source: `src/db/seed-data/dietitian-knowledge/**/*.md`, 27 files, file-per-region + file-per-topic
(not file-per-region-per-topic — a dietitian correcting "Punjabi" should edit exactly one file).
`knowledge-markdown-parser.ts` is a hand-rolled frontmatter + H2-chunk parser — no markdown/YAML
dependency exists in this stack (confirmed: no `gray-matter`/`remark`/`unified`/`js-yaml` in
`package.json`), and the frontmatter here is flat scalars/arrays only, genuinely simple to split on
`---` fences with a line scan, matching this codebase's revealed preference for small hand-rolled
parsers (see `csv-parser.ts`'s own quoted-CSV state machine) over a new dependency. Each markdown
**H2 section is one chunk** (~50-200 words, an authoring target the parser warns on but never fails
for); a doc whose sections genuinely need different retrieval filters should be split into separate
files rather than grow per-heading frontmatter, which was deliberately never built.

`seed-knowledge.ts` mirrors `seed-recipes.ts`'s exact shape: manual `select`-into-a-Map upsert-by-slug
(never `.onConflictDoUpdate()`), chunks recomputed fresh every run (delete-then-reinsert per doc,
mirroring how `recipe_aliases`' generated rows are recomputed fresh every `seed-recipes.ts` run), a
hard `process.exit(1)` refusal on a duplicate frontmatter `id` across files (the same class of guard
as `seed-recipes.ts`'s duplicate-name refusal), and a warnings banner printed after the loop.

A real bug the parser needed a second pass to catch, found only by inspecting the *actual rendered
prompt* (not just the seed script's own diagnostics, which had nothing to flag): every file's closing
`**UNVERIFIED — pending dietitian confirmation.**` disclosure line — the same disclosure convention
this file already uses for every unconfirmed food/recipe addition — was being authored inside whichever
H2 section happened to be a doc's last, so it flowed straight into that chunk's retrieved `content` and
showed up as a stray bullet in the middle of the LLM's guidance list. Fixed by stripping the literal
disclosure line out of chunk `content` at parse time (`DISCLOSURE_LINE` regex in
`knowledge-markdown-parser.ts`) — the full, unstripped markdown is still preserved verbatim in
`raw_markdown` for a human auditor. The disclosure is for a person reading the source file, never for
the model.

All 27 files ship `status: draft`, `confirmedBy: null` — content drafted from well-established,
broadly-agreed Indian-dietetics patterns (roti/rice-dal-sabzi as the lunch/dinner backbone, regional
staple identities, standard katori/roti/cup serving language already surfaced via `recipes.unitLabel`),
never invented statistics or fake citations, and explicitly not presented as dietitian-validated ground
truth until a real review pass flips each file's `status` to `confirmed` in small batches.

### Retrieval — deterministic tag filter (v1), no embeddings

`knowledge-retrieval.ts`'s `retrieveKnowledgeChunks()` is the same tiered-deferral philosophy the
recipe engine's own grounding resolver already established (exact → alias → fuzzy → **null**, the
explicit seam for a deferred v2 embedding tier) applied one level up: v1 is deterministic
tag/metadata filtering only, no semantic search, because no embedding provider is confirmed available
and this dataset's filter dimensions (cuisine/dietType/goal/mealSlot) cover real usage cleanly enough
to not need one yet. A doc is a retrieval candidate when every one of its non-empty filter arrays
intersects the request; candidates rank by specificity (how many filter dimensions are actually
narrowed) → author-assigned `weight` (1-10, mirroring `recipes.commonality`/`priority`'s existing
precedent as a ranking tie-breaker) → a deterministic `stableHash` tie-break — the same small per-file
32-bit rolling hash already independently duplicated in `food-selector-fallback.ts` /
`daily-macro-jitter.ts` / `archetype-selector.ts` / `mixed-veg-day.ts` / `recipe-selector-fallback.ts`,
copied locally here too rather than extracted into a shared utility, matching this codebase's explicit,
repeated choice not to share that helper. Chunks are greedily accepted in rank order until a
**700-token budget** (`DEFAULT_KNOWLEDGE_TOKEN_BUDGET`) is spent — deliberately small, reasoned
directly from the 8B model's already-documented convergence fragility on a *smaller* prompt than this
layer adds to; a smaller lower-ranked chunk can still fit after a larger higher-ranked one is dropped
(best-effort greedy, not a hard stop at the first miss). Nothing is ever silently dropped —
`droppedForBudget` is returned, `console.warn`'d at generation time, and written into
`plan_generation_runs.knowledge_chunks_injected` alongside what *was* injected.

**A real starvation bug, found only by inspecting actual retrieved output on a real client, not by unit
tests alone**: the first content pass authored `combinations-*`/`goals-*`/`meal-patterns-*` docs at
`weight: 9` and every region doc at `weight: 7-8`. Since a region doc, a goal doc, and a meal-slot doc
are each narrowed on exactly one filter dimension, they tie at specificity — so weight alone decided
the ranking, and the weight-9 docs' combined chunk count already exceeded the 700-token budget on their
own. The result: **no client's generated prompt ever received any region-specific guidance at all** —
the flagship deliverable of this whole layer was silently starved out by unrelated higher-weight docs,
every single time, for every cuisine. Confirmed on both Priya (Punjabi) and Rahul (South Indian) before
the fix, and confirmed fixed after. Fixed by raising all 8 specific-region docs (not `general.md`,
which stays lower — it's the deliberate no-strong-identity fallback) to `weight: 9`, matching the other
flagship categories, so regional identity now competes on equal footing rather than losing by
construction. This is a content-authoring correction, not a retrieval-algorithm redesign — the
algorithm's deterministic ranking behaved exactly as designed; the inputs it was given were wrong.

### Prompt integration

`recipe-prompt.ts`'s `formatKnowledgeSection()` renders retrieved chunks as a `Dietitian guidance for
this client:` bulleted block, inserted in both `buildInitialMessages()` and `buildDayRetryMessages()`
at the identical spot — between the recipe table and the final instruction line, so the model sees its
full recipe pool before being told to compose/choose, with the guidance framing that choice rather than
preceding it. Absent or empty `knowledgeChunks` renders `""` and the prompt is byte-identical to before
this layer existed — a dedicated regression test asserts this directly, not just informally. One static
bullet was appended to `SYSTEM_PROMPT`'s existing Rules list framing the guidance as advisory,
"alongside (never instead of) the recipe table and targets" — never a new instruction the model could
mistake for a reason to override the recipe list or the numeric targets it's already told never to
touch. `recipe-schema.ts` — the LLM's actual output contract — is completely untouched.

### Goal inference — an accepted proxy, not a dietitian-confirmed signal

There is no `fat_loss`/`muscle_gain`/`maintenance` field anywhere in the roadmap/counselling pipeline
— confirmed by a direct search before building anything, not assumed. `goal-inference.ts`'s
`inferGoalFromRoadmap()` derives one purely for this layer's retrieval filter, comparing the week's
`weekTargets(roadmap, weekNumber).kcal` against `roadmap.energy.tdee`: more than 5% under → `fat_loss`,
more than 5% over → `muscle_gain`, otherwise `maintenance`. A new file, not a change inside
`roadmap.ts` — the counselling engine itself stays untouched, and this stays an explicit, accepted v1
simplification to revisit only if a real dietitian-confirmed goal field is ever added upstream.

### Cuisine widening — Punjabi/Rajasthani/Hyderabadi, with a real limitation

`RECIPE_CUISINES` (`recipe-cuisine-mapping.ts`) widened from 6 to 9 values to add Punjabi/Rajasthani/
Hyderabadi, mirroring the exchange engine's 9-value `REGIONS` — needed because the user asked for
Punjabi regional knowledge by name, and the recipe engine had no way to even request that cuisine
before this. `meal_templates` already had all three seeded at `mealCount=5`
(`20260809300000_five_more_regions.sql`, predating the recipe engine entirely) — zero new seed work
there. `route.ts`'s `recipeRequestSchema` uses `z.enum(RECIPE_CUISINES)` directly, so it widened for
free. **A real limitation, stated plainly, not hidden**: the raw recipe CSV has zero rows tagged
Punjabi or Rajasthani cuisine, and its one Hyderabadi hit is inside a dish *name* ("Hyderabadi
Biryani"), not the `Cuisine` column — confirmed directly against `recipe-cuisine-mapping.ts`'s own
15-value distribution profile before widening anything. The widening is safe (`eligibleCuisinesFor()`
always folds in `"General"`, so nothing can resolve to zero eligible recipes) but does **not** unlock a
native recipe pool for these three regions — they draw from the same 762-recipe General pool as every
other cuisine's fallback. This knowledge layer's docs for Punjabi/Rajasthani/Hyderabadi are therefore
the *only* region-specific signal anywhere in the recipe-engine pipeline for them; backfilling
`recipes.cuisine` for an identifiable subset is real, explicit follow-up work, not attempted here.

### Rollout

`DIETITIAN_KNOWLEDGE_ENABLED` defaults off everywhere, same polarity and reasoning as
`RECIPE_ENGINE_ENABLED` — a new, unproven layer stacked on an already convergence-fragile 8B model, not
an established one being rolled back. It only takes effect when `RECIPE_ENGINE_ENABLED` is also on;
this layer has no meaning for the exchange engine and never touches it. Verified end-to-end without
spending a live LLM call: loaded a real client's roadmap, ran real retrieval against the seeded
knowledge base, and rendered the real `buildInitialMessages()` output directly — confirmed genuine
Punjabi-specific content (Makkhan/ghee as an everyday fat, Sarson da saag/makki di roti as a named
seasonal pairing) appears in the actual rendered prompt for a real Punjabi client, and equivalent
region-specific content for a South Indian client, after the weight-starvation fix above. Flip the flag
locally only once the initial draft content has had a real dietitian review pass.

## Diet plan examples layer

Direct feedback on the knowledge layer above: it's "still too theoretical." A dietitian doesn't reason
from isolated rules ("Punjabis eat parathas") — they think in **complete meal patterns for a specific
client profile**. This is a SECOND, independent RAG layer — not a modification of the knowledge layer,
a parallel one — that retrieves and injects complete real example days as few-shot precedent, so the
LLM sees not just *how dietitians think* (knowledge layer) but *what dietitians actually build* (this
layer), in that order, with examples explicitly ranked above the general principles when the two
disagree. `recipe-schema.ts` is untouched; nothing here is ever grounded against `recipes`.

### Real-content sourcing — a real blocker, resolved directly with the user

There is no real, dietitian-authored diet plan anywhere in this environment. Investigated directly: the
"Deepak Sharma/Anjali Joshi/Ritu Verma" plans this file's own exchange-system history calls "real
generated diet plans" turned out to be machine-generated PDFs from synthetic, fabricated intake data —
a sister repo's own quick-client test script seeded fake names/ages/phone numbers and ran them through
the deterministic pipeline. Useful once for verifying Table 4.1 arithmetic, not genuine clinical source
material. Flagged to the user rather than silently substituted with fabricated content. Confirmed
direction: **use the internet to find real examples.** Two parallel web-research passes found 17 real,
credible, structured, quantified full-day Indian diet plan examples from named/credentialed sources —
registered dietitians (Dietburrp/RD Payal Banka, 15yr experience), hospital nutrition departments
(Apollo247/Dr. Pondugula MBBS, CK Birla Hospital/Ms. Deepali Sharma PG Dietetics), and established
platforms with named credentialed reviewers (Netmeds/M Sowmya Binu, Fitelo/Varleen Kaur qualified
dietitian) — spanning fat-loss, muscle-gain, and maintenance goals across multiple regions and calorie
ranges, each with a real source URL and credibility note retained for audit.

Separately, the user pasted a ~30-item batch of fabricated placeholder examples (generic "Roti + Dal +
Sabzi" patterns, no source) and asked for more to be generated — directly conflicting with their own
"use real examples" direction from minutes earlier. Flagged rather than silently actioned. **Resolved**:
both tiers ship. Real examples are the primary, always-preferred tier; the synthetic batch (expanded to
50 per the user's own instruction to vary breakfast/lunch/protein-source/region/goal/condition) is an
explicitly-labeled filler tier, used only to cover combinations the real set doesn't reach. Neither tier
is ever presented to the LLM as anything other than "a real example day" in the rendered prompt text —
the real/synthetic distinction is an internal ranking and audit concern, never exposed to the model.

### Data model — one row = one complete day, never chunked

`diet_plan_examples` — purely additive, alongside (not touching) `dietitian_knowledge_docs`/`chunks`.
`goal` is a required scalar (`fat_loss | muscle_gain | maintenance`, exactly `InferredGoal`'s values) —
unlike the knowledge layer's `goals[]`, an example is never goal-universal. `diet_types text[]` is a
**positive list**, mirroring `recipes.dietTypes`'s existing convention exactly (`r.dietTypes.includes
(ctx.dietType)`) — a veg-only day gets `["vegetarian","eggetarian"]`, a day containing chicken/fish gets
`["non_vegetarian"]` only, authored by hand same as recipes, never inferred automatically. `region`
reuses `RecipeCuisine`'s 9 values (`"General"` = pan-Indian), singular — a real example was built for
one region. `gender` defaults `"any"` (most real sources don't specify one; `"any"` is a real, meaningful
value here, not an absence). `calorie_min`/`calorie_max` are a range, not a point estimate, since real
sources vary (exact numbers, stated ranges, or surplus-only framing with no absolute figure — the latter
gets a plausible range estimated from the actual transcribed meal composition, never left null).
`meal_structure jsonb` is an array of `{slot, timeHint, items}` — structured, not pre-formatted text, so
the row stays queryable/auditable and `recipe-prompt.ts`'s formatter owns rendering, the same separation
`RecipeForPrompt`/`RetrievedKnowledgeChunk` already use; `items` are free-text strings ("Methi paratha
(2, no-fat)"), never grounded recipe references — this layer never touches `recipe-grounding.ts`.
`condition text[]` is a genuinely new field, not in the original spec — added because the user's pasted
batch introduced real medical-condition tagging (PCOS, diabetes, thyroid) that's a legitimate dimension.
**v1 no-op at retrieval**: no client-condition signal exists anywhere upstream today (same class of gap
`goal-inference.ts` closed for "goal") — ingested and stored now, ready for a v2 retrieval dimension.
`source_type` (`real | synthetic`) is the two-tier model; `source_url`/`source_credibility` are required
for `real` rows (enforced at ingestion, `seed-diet-plan-examples.ts` hard-refuses a `real` row missing
either — not a DB constraint, since cross-column conditional nullability needs a trigger for no real
benefit here). `diet_plan_example_embeddings` mirrors `recipeEmbeddings`/`dietitianKnowledgeEmbeddings`'s
exact v2-deferred placeholder shape, explicitly **lower priority than even the knowledge layer's own
placeholder** — v1's entire similarity surface (goal/dietType/region/calories/mealCount) is literal
structured columns; nothing here benefits from embeddings without also changing what's matched.
`plan_generation_runs.diet_plan_examples_injected` is a sibling audit column to `knowledge_chunks_
injected` (not merged into it), same `{injected, droppedForBudget}` shape, keeping the two RAG layers'
audit trails independently queryable.

**Multi-day sources become per-day rows.** Several real sources are 7-day tables (Maharashtrian, CK
Birla, Apollo247, Netmeds) — each day becomes its own row, sharing goal/region/gender/calorie-range but
each with its own `meal_structure`/`reasoning`/`day_label`, and critically its own `diet_types` — the
Maharashtrian source's one day with chicken biryani is tagged `["non_vegetarian"]` while its six sibling
days stay `["vegetarian","eggetarian"]`; collapsing to one row per source would misclassify or lose that
day's real content. 17 sources became 43 real rows once expanded.

### Ingestion — `npm run seed:diet-plan-examples`

Source: `src/db/seed-data/diet-plan-examples/{real,synthetic}/**/*.md`, one file per final DB row — the
top-level `real`/`synthetic` split mirrors the `source_type` column, making the tier visually unmissable
to anyone browsing the repo. New parser, `diet-plan-example-markdown-parser.ts`, genuinely different in
kind from the knowledge layer's `parseChunks()`: a diet-plan-example markdown file's body has exactly
two named H2 sections, `## Meal Structure` (one line per slot: `- {slot} ({timeHint}): {item}; {item}`)
and `## Reasoning` (free prose, omittable) — parsed into fields of ONE record, not an array of N
independent chunks. Chunking a day the way knowledge docs are chunked would destroy the "complete day"
signal this whole layer exists to preserve. The small generic helpers (`parseScalar`/`parseArray`/
`splitFrontmatter`/the frontmatter line-scan) are duplicated locally rather than imported from
`knowledge-markdown-parser.ts` — matches this codebase's explicit, repeated choice not to share tiny
helpers (`stableHash`, independently duplicated in 5 files), and the sibling parser doesn't export them
anyway. `seed-diet-plan-examples.ts` mirrors `seed-knowledge.ts`'s upsert/diagnostics shape but is
simpler: no child-table delete-reinsert step, since each markdown file is one `diet_plan_examples` row
1:1. Hard refuses on a frontmatter-`id` collision (same class of guard as every other seed script in
this codebase) or a `sourceType: real` file missing `sourceUrl`/`sourceCredibility`. Diagnostics banner
prints the real/synthetic split explicitly, so it's never silently unclear how much of a seeded set is
real — verified on the actual seed run: 93 files (43 real, 50 synthetic), zero warnings, zero collisions.

All content ships `status: draft` — real-tier content is public-web-sourced, paraphrased and
restructured into the schema (not verbatim marketing copy), retained with true `sourceUrl`/
`sourceCredibility` for audit, never presented as validated ground truth until a real dietitian review
pass. Synthetic-tier content is explicitly fabricated filler (`sourceUrl`/`sourceCredibility` null,
`weight: 4` — deliberately below the real tier's 6-9 range), used only where real coverage doesn't
reach.

### Retrieval — hard filters + weighted similarity + a real/synthetic tier split

`diet-plan-example-retrieval.ts`'s `retrieveDietPlanExamples()` is genuinely different in kind from
`retrieveKnowledgeChunks()`'s hard-filter-only approach — this needs real similarity ranking, not just
eligibility. **Hard filters** (never a candidate if failed): `goal` exact match; `dietType ∈
example.dietTypes[]` (the same inclusion check `recipes.dietTypes` already uses, same reason — never
surface a diet-incompatible example). **Soft-scored, weighted composite** (never hard-excludes):
```
score = regionScore*0.40 + calorieScore*0.35 + mealCountScore*0.15 + genderScore*0.10
finalScore = score * (weight / 10)
```
`regionScore`: 1.0 exact match, 0.5 if either side is `"General"`, 0.15 otherwise (cross-region structure
is still somewhat informative). `calorieScore`: 1.0 inside `[calorieMin, calorieMax]`, else `max(0, 1 -
distanceOutsideRange/500)` — 500 kcal chosen as roughly one meal's worth in this dataset. `mealCountScore`:
1.0/0.6/0.3/0 at 0/1/2/3+ slots off. `genderScore`: 1.0 for `"any"` or a real match; 0.6 for "unknown
client gender vs. a specific example" (no client-gender signal exists upstream today — an accepted v1
gap, stated explicitly rather than silently assumed); 0.4 for a genuine mismatch.

**Real-first, synthetic-as-filler**: candidates partition into `real`/`synthetic` by `source_type`, each
ranked independently by `finalScore` → a locally-duplicated `stableHash` tie-break (same convention as
`knowledge-retrieval.ts`'s own), then `maxExamples` slots fill from the real-ranked list first — only
once that pool is exhausted before reaching `maxExamples` does the synthetic-ranked list fill the
remainder. A synthetic example can never outrank an eligible real one.

**`DEFAULT_MAX_EXAMPLES = 1`, `DEFAULT_EXAMPLE_TOKEN_BUDGET = 500`** — deliberately not 2-3 examples or a
larger budget. This is the single most consequential risk in the whole layer, stated prominently, not
buried: this session's own two live NVIDIA test runs — with only the knowledge layer's smaller ~700-token
addition already present in the prompt — both still ended in full-retry rejection (persistent low-fat
bias, the variety-cap instruction ignored, on the current 8B-tier model). A full example day is
inherently a *larger* block of text than one knowledge-layer bullet. Stacking a second, larger section on
a knowledge layer that already measurably didn't prevent rejection is a real risk of making convergence
worse, not a hypothetical one — ships at N=1/tight budget behind its own flag, and the first real
validation step once content is confirmed should be a live A/B comparison run (knowledge-only vs.
knowledge+examples), not just green unit tests.

### Prompt integration

`formatExamplesSection()` in `recipe-prompt.ts`, called directly after `formatKnowledgeSection()` in
both `buildInitialMessages()`/`buildDayRetryMessages()` — same insertion point (between the recipe table
and the final instruction). This delivers "knowledge-first-then-examples" exactly as directed: knowledge
principles render textually before examples in the composed prompt. Each rendered example: a `[{region},
{goal}, ~{avg kcal} kcal]` header, one line per real meal slot, then `Why: {reasoning}` if present.
Framing text explicitly states examples carry more weight than the knowledge guidance above them, and —
the same non-negotiable boundary the knowledge layer already states, re-anchored here since this section
is materially richer text — neither ever overrides the recipe table or the numeric daily targets. One
new terse `SYSTEM_PROMPT` bullet states the same precedence. Absent/empty `dietPlanExamples` renders
`""`, byte-identical to before this layer existed — a dedicated regression test asserts this directly,
plus a test asserting the examples block renders textually after the knowledge block when both are
present.

`recipe-selector.ts`'s control flow needed zero changes — one more optional field
(`dietPlanExamples?: RetrievedDietPlanExample[]`) on `RecipeSelectorInput`, same mechanism the knowledge
layer's own `knowledgeChunks` field already established.

### Verified end-to-end without spending a live LLM call

Loaded a real client's roadmap, ran real retrieval against the seeded 93-example table, rendered the
real `buildInitialMessages()` output directly. For Priya (Punjabi, vegetarian, fat_loss, 1774 kcal
target): retrieval correctly picked the closer-calorie Pan-Indian 1800kcal Dietburrp example (finalScore
≈0.65) over the exact-region-match Punjabi 1218kcal example (finalScore ≈0.53) — the Punjabi example's
narrow 1200-1218 kcal range scored 0 on calorie-closeness against a 1774 kcal target, while the Pan-Indian
example's broader 1800 kcal range scored ≈0.95; a legitimate, explainable outcome of the weighting, not a
bug — real dietitian judgment would likely also favor a closer-calorie broader-cuisine example over an
exact-region one built for a client on a very different calorie budget. Confirmed the rendered prompt
shows the full real meal structure and stated reasoning verbatim, in the correct position after the
knowledge-guidance section, with the correct precedence framing.

### Rollout

`DIET_PLAN_EXAMPLES_ENABLED` defaults off everywhere, independent of `DIETITIAN_KNOWLEDGE_ENABLED` so
each layer's real impact can be isolated in testing — both still require `RECIPE_ENGINE_ENABLED` to mean
anything. Flip locally only once the initial content has had a real dietitian review pass AND a live
A/B convergence comparison (see the token-budget risk above) shows this layer doesn't make an already
convergence-fragile 8B model worse.

## Rounding & precision
- All intermediate maths unrounded. Round only at display.
- kcal, protein/carb/fat grams → integer at display.
- BMI → 1 decimal. Weights → 1 decimal.
- Timeline divisors displayed at full precision (`20.2 ÷ 0.74`, never `÷ 0.7`).

## Testing
Every function in `src/lib/counselling/` and `src/lib/plan/` gets a Vitest unit test. The four worked examples (TEST-001 Priya, TEST-002 Rahul, TEST-003 Sneha, TEST-004 Aadi) are golden-file tests — if any figure drifts, the build fails. Do not change a golden file to make a test pass; fix the code or ask. `recipe-engine-golden.test.ts` reuses these same 4 clients' real `weekTargets()` output against the recipe engine's balancer (a small hand-picked fixture recipe set, not the live CSV, so it's exact and LLM-free) — see "The recipe engine" for why its tolerance is looser than the exchange engine's. One real fixture-design lesson worth keeping in mind if this file is ever extended: Sneha's real target only converged once the fixture pool included a genuinely LEAN protein item (egg whites) alongside a fattier one (whole egg/paneer) — a fixture with only fat-heavy protein sources reproduces the exact real "no lean protein to offer" tension this section's own live-testing already found for non-vegetarian targets (see below), so don't remove that item while "simplifying" the fixture later. A green golden test is a floor on the balancer's math, not a ceiling on real-pool convergence — that's what live-generation testing against the real 1222-recipe table is for, and two real runs against Aadi (TEST-004, North Indian cuisine, `meta/llama-3.1-8b-instruct`) surfaced genuine findings worth recording, not smoothed over: (1) the plausibility validator's "every meal needs a MAIN item" check was firing on nearly every `mid_morning` slot in the first run — fixed by scoping it to exclude `mid_morning`/`evening`/`bedtime` (snack-only occasions by this codebase's own established convention), confirmed gone from the second run's diagnostics; (2) even after that fix, the plan was still correctly REJECTED end-to-end (no DB write) on the second run too — several days missed kcal/protein/carbs by 20-70%, not a near-miss. This confirms the reject-gate itself works exactly as designed (an honest failure, not a silent bad write), but it also means real convergence at the 8B model tier is a genuinely open problem, not close to solved: the day-retry loop kept steering toward small snack-like recipes (soups, teas, salads) that clear the plausibility/variety checks more easily than they clear the macro target, and 3 retries per day wasn't enough to escape that pattern. Real next steps, not started here: try the 70B model (the `.env.local` NVIDIA_MODEL swap to 8B was itself only ever a temporary workaround for 70B API queueing, see that file's own comment), tune the retry-prompt's macro-miss framing to push harder toward calorie-dense recipes when a day is running low, and/or revisit whether `RECIPE_MACRO_TOLERANCE` needs to start even looser than 8% before tightening. None of this blocks `RECIPE_ENGINE_ENABLED` staying off by default — it already is.

## Conventions
- No `any`. No `@ts-ignore`.
- Zod schema at every boundary: form input, LLM output, API response.
- Errors surface to the UI. Never silently fall back to a default number in a clinical calculation — throw, and let the review page show a blocked state.
- Server-only secrets in `src/lib/env.ts`, validated with Zod at boot.
- Migrations in `supabase/migrations/`, timestamped, forward-only.

## Auth
Google OAuth via Supabase. Access restricted to `@fitelo.co`. Enforced in three places — all three required:
1. `queryParams: { hd: 'fitelo.co' }` on sign-in (UX hint only, spoofable).
2. Postgres trigger on `auth.users` insert — reject non-fitelo.co emails.
3. Middleware + RLS policy checking `auth.jwt() ->> 'email' LIKE '%@fitelo.co'`.

## Do not
- Do not install a nutrition API or food database package for the exchange engine. `exchange_types` + our own `foods` table is that engine's entire source of truth. (The recipe engine's `recipes` table is a deliberate, one-time, explicitly-approved exception to this rule, not a precedent for adding more — see "The recipe engine" before adding any other external nutrition source.)
- Do not let plan generation write to the DB until validation passes — on EITHER engine. The recipe engine's raw LLM-proposed recipe names are never trusted for a single number, and the grams it proposes for them (none — the LLM proposes zero grams, ever) are entirely code-computed; `recipe-validate.ts`'s per-day gate plus the reject-the-whole-plan semantics in `recipe-selector.ts` are that engine's write-blocking mechanism, stricter than every prior engine's.
- Do not add a "regenerate with AI" button that bypasses the solver.
- Do not soften the recipe engine's reject-on-failure behavior back to "always succeeds with warnings" without an explicit decision — it was a deliberate, confirmed departure from every prior engine's philosophy, not an oversight to quietly patch over the first time it rejects a real plan.
