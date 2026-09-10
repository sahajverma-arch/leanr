import { pgTable, uuid, text, timestamp, jsonb, numeric, integer, boolean, vector } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  fullName: text("full_name"),
  role: text("role").notNull().default("dietitian"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Profile = typeof profiles.$inferSelect
export type NewProfile = typeof profiles.$inferInsert

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  city: text("city"),
  createdBy: uuid("created_by").references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Client = typeof clients.$inferSelect
export type NewClient = typeof clients.$inferInsert

export const counsellingSessions = pgTable("counselling_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["quick", "full"] }).notNull(),
  status: text("status", { enum: ["draft", "submitted", "reviewed"] })
    .notNull()
    .default("draft"),
  answers: jsonb("answers").notNull().default({}),
  createdBy: uuid("created_by").references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
})

export type CounsellingSession = typeof counsellingSessions.$inferSelect
export type NewCounsellingSession = typeof counsellingSessions.$inferInsert

/** Roadmap snapshots are immutable — recomputation creates a new row, never an update. */
export const roadmaps = pgTable("roadmaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => counsellingSessions.id, { onDelete: "cascade" }),
  engineVersion: text("engine_version").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Roadmap = typeof roadmaps.$inferSelect
export type NewRoadmap = typeof roadmaps.$inferInsert

/** Records a dietitian's explicit override of a block-level roadmap flag. The roadmap row is never mutated. */
export const roadmapOverrides = pgTable("roadmap_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  roadmapId: uuid("roadmap_id")
    .notNull()
    .references(() => roadmaps.id, { onDelete: "cascade" }),
  flagCode: text("flag_code").notNull(),
  reason: text("reason").notNull(),
  dietitianName: text("dietitian_name").notNull(),
  createdBy: uuid("created_by").references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type RoadmapOverride = typeof roadmapOverrides.$inferSelect
export type NewRoadmapOverride = typeof roadmapOverrides.$inferInsert

/**
 * A protein supplement the dietitian prescribes at review time, before the
 * plan is generated. Its protein and calories are subtracted from what the
 * FOOD has to supply — see supplement-adjusted-targets.ts.
 *
 * Attached to the roadmap and never mutating it, exactly like
 * roadmapOverrides above: this is a clinical decision made while reviewing,
 * not a recalculation of the roadmap itself.
 *
 * ONE row per roadmap (enforced by a unique index, not just convention) —
 * confirmed scope is exactly one protein supplement per client.
 */
export const roadmapSupplements = pgTable("roadmap_supplements", {
  id: uuid("id").primaryKey().defaultRandom(),
  roadmapId: uuid("roadmap_id")
    .notNull()
    .unique()
    .references(() => roadmaps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** How one serving is described to the client — "1 scoop", "1 sachet". */
  servingLabel: text("serving_label").notNull(),
  servingsPerDay: numeric("servings_per_day", { mode: "number" }).notNull(),
  /**
   * Per SERVING, off the tub's label. Confirmed scope: protein and calories
   * only. Carbs and fat are not entered — the scoop's non-protein calories
   * still reach the plan, via the carbs residual in weekTargets()'s own
   * formula. See supplement-adjusted-targets.ts.
   */
  proteinGPerServing: numeric("protein_g_per_serving", { mode: "number" }).notNull(),
  kcalPerServing: numeric("kcal_per_serving", { mode: "number" }).notNull(),
  createdBy: uuid("created_by").references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type RoadmapSupplement = typeof roadmapSupplements.$inferSelect
export type NewRoadmapSupplement = typeof roadmapSupplements.$inferInsert

/** Table 4.1 — Comprehensive Food Exchange List (11 rows). READ-ONLY at runtime. See CLAUDE.md "The exchange system". */
export const exchangeTypes = pgTable("exchange_types", {
  code: text("code").primaryKey(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull(),
  proteinG: numeric("protein_g", { mode: "number" }).notNull(),
  carbsG: numeric("carbs_g", { mode: "number" }).notNull(),
  fatG: numeric("fat_g", { mode: "number" }).notNull(),
  fiberG: numeric("fiber_g", { mode: "number" }).notNull().default(0),
  // Postgres-generated column (protein_g*4 + carbs_g*4 + fat_g*9) — never
  // written to directly, so Drizzle must be told it's generated or it will
  // try to INSERT a value into it and Postgres will reject the query.
  kcal: numeric("kcal", { mode: "number" }).generatedAlwaysAs(
    sql`round(protein_g * 4 + carbs_g * 4 + fat_g * 9, 1)`
  ),
  standardServing: text("standard_serving").notNull(),
  notes: text("notes"),
})

export type ExchangeType = typeof exchangeTypes.$inferSelect

export const foods = pgTable("foods", {
  id: uuid("id").primaryKey().defaultRandom(),
  nameEn: text("name_en").notNull(),
  nameHi: text("name_hi"),
  exchangeType: text("exchange_type")
    .notNull()
    .references(() => exchangeTypes.code),
  exchangeUnits: numeric("exchange_units", { mode: "number" }).notNull().default(1),
  // Nullable: Table 4.1 defines fruit's raw amount as variable — the
  // household_measure ("1 medium") carries the real-world portion instead.
  servingRawG: numeric("serving_raw_g", { mode: "number" }),
  householdMeasure: text("household_measure"),
  regions: text("regions").array().notNull().default([]),
  dietTypes: text("diet_types").array().notNull().default([]),
  mealSlots: text("meal_slots").array().notNull().default([]),
  allergens: text("allergens").array().notNull().default([]),
  tags: text("tags").array().notNull().default([]),
  // One or more of SEASONS (src/lib/foods/vocab.ts) — "all_year" always
  // passes the eligibility filter regardless of what else is listed (see
  // eligible-foods.ts), so an untagged/staple food is never accidentally
  // narrowed. See CLAUDE.md "The exchange system".
  seasons: text("seasons").array().notNull().default(["all_year"]),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Nullable — most foods (generic sides, fruit, fat) never need one; only
  // foods that serve as a meal-archetype component do. See dish_families
  // below and CLAUDE.md-adjacent design doc "Meal Archetype + Dish
  // Composition layer". Postgres enforces at write time (a trigger) that
  // this can only reference a dish_family whose own exchange_type matches
  // this food's exchangeType.
  dishFamilyId: uuid("dish_family_id").references(() => dishFamilies.id),
})

export type Food = typeof foods.$inferSelect
export type NewFood = typeof foods.$inferInsert

/**
 * A small, closed vocabulary identifying a specific dish identity (e.g.
 * "sambar"), same pattern as exchangeTypes. archetype_components point at
 * a SET of these — never a raw exchange type, never a free-text tag — so
 * the eligible pool for one archetype's role can never silently admit an
 * unrelated dish of the same exchange type (Idli-Sambar's pulse role
 * pointing at the "sambar" family excludes Masoor Dal/Kala Chana/Moong Dal
 * structurally, not by curation discipline alone).
 */
export const dishFamilies = pgTable("dish_families", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  exchangeType: text("exchange_type")
    .notNull()
    .references(() => exchangeTypes.code),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DishFamily = typeof dishFamilies.$inferSelect

/**
 * A named, curator-approved COMPLETE meal (e.g. "Idli-Sambar"), not a
 * single dish — see the "Complete Meal Identity" design decision. Region-
 * and slot-scoped; meal_templates (the exchange-count skeleton shape)
 * stays completely untouched by this — an archetype only narrows which
 * foods are eligible to fill a slot the existing pipeline already solved.
 */
export const mealArchetypes = pgTable("meal_archetypes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  slot: text("slot").notNull(),
  dietTypes: text("diet_types").array().notNull().default([]),
  // 0-1, curator-assigned — weights rotation frequency only, never a hard
  // eligibility filter. See archetype-selector.ts.
  authenticityScore: numeric("authenticity_score", { mode: "number" }).notNull().default(1.0),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type MealArchetype = typeof mealArchetypes.$inferSelect

/** The named roles within an archetype (e.g. "lentil curry"), each pointing at one or more dish_families. */
export const archetypeComponents = pgTable("archetype_components", {
  id: uuid("id").primaryKey().defaultRandom(),
  archetypeId: uuid("archetype_id")
    .notNull()
    .references(() => mealArchetypes.id, { onDelete: "cascade" }),
  // Display label only (e.g. "Lentil curry") — NOT the matching key.
  componentRole: text("component_role").notNull(),
  // A SET of acceptable families, not one — lets one archetype (e.g.
  // "Everyday North Indian Thali") accept any of several dals for its
  // pulse role, while rigid-pairing cuisines keep this to a single family.
  dishFamilyIds: uuid("dish_family_ids").array().notNull().default([]),
  // Redundant with dishFamilies.exchangeType by construction — a second,
  // cheap integrity check at archetype-authoring time.
  exchangeType: text("exchange_type")
    .notNull()
    .references(() => exchangeTypes.code),
  componentOrder: integer("component_order").notNull().default(0),
  isRequired: boolean("is_required").notNull().default(true),
  notes: text("notes"),
})

export type ArchetypeComponent = typeof archetypeComponents.$inferSelect

/**
 * Dish Composition Layer, stage 2 — combines an already-composed cereal
 * group with an already-composed pulse dish into one named combo (e.g.
 * "Rajma Chawal") for meals with no meal_archetype driving the pairing.
 * Reuses dish_families as its matching key, same pattern as
 * archetype_components. See src/lib/plan/dish-combination.ts.
 */
export const dishCombinations = pgTable("dish_combinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull(),
  primaryDishFamilyId: uuid("primary_dish_family_id")
    .notNull()
    .references(() => dishFamilies.id),
  secondaryDishFamilyId: uuid("secondary_dish_family_id")
    .notNull()
    .references(() => dishFamilies.id),
  region: text("region"),
  isActive: boolean("is_active").notNull().default(true),
})

export type DishCombination = typeof dishCombinations.$inferSelect

/**
 * Dish Composition Layer, stage 3 — names a curated SET of 2+ vegetables
 * (e.g. Drumstick + Ash gourd + Yam -> "Avial") that meal-composition.ts's
 * vegetable pooling would otherwise always render as the generic "Mixed
 * Vegetable {RegionWord}". Unlike dish_combinations (a fixed cereal+pulse
 * PAIR, two FK columns), a vegetable dish can have 2-4 members and the
 * pool of candidate vegetables varies day to day, so membership is a
 * separate join table (vegetable_dish_combination_members) rather than
 * fixed columns. See src/lib/plan/vegetable-dish-naming.ts.
 */
export const vegetableDishCombinations = pgTable("vegetable_dish_combinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull(),
  region: text("region"),
  isActive: boolean("is_active").notNull().default(true),
})

export type VegetableDishCombination = typeof vegetableDishCombinations.$inferSelect

export const vegetableDishCombinationMembers = pgTable("vegetable_dish_combination_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  vegetableDishCombinationId: uuid("vegetable_dish_combination_id")
    .notNull()
    .references(() => vegetableDishCombinations.id, { onDelete: "cascade" }),
  dishFamilyId: uuid("dish_family_id")
    .notNull()
    .references(() => dishFamilies.id),
})

export type VegetableDishCombinationMember = typeof vegetableDishCombinationMembers.$inferSelect

export const mealTemplates = pgTable("meal_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  region: text("region").notNull(),
  mealCount: integer("meal_count").notNull(),
  slot: text("slot").notNull(),
  slotOrder: integer("slot_order").notNull(),
  timeHint: text("time_hint"),
  kcalShare: numeric("kcal_share", { mode: "number" }).notNull(),
  allowedExchangeTypes: text("allowed_exchange_types").array().notNull().default([]),
  minItems: integer("min_items").notNull().default(1),
  maxItems: integer("max_items").notNull().default(4),
})

export type MealTemplate = typeof mealTemplates.$inferSelect

/**
 * The AI (Prompt 7) only ever picks which food fills a slot — every number
 * here (exchange counts, grams, macros) is computed in code, never trusted
 * from the model.
 */
export const dietPlans = pgTable("diet_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  roadmapId: uuid("roadmap_id")
    .notNull()
    .references(() => roadmaps.id),
  weekNumber: integer("week_number").notNull(),
  weekStart: text("week_start").notNull(), // date, stored as ISO string
  weekEnd: text("week_end").notNull(),
  // Snapshotted, not re-derived: region has no other source (a dietitian
  // choice made at generation time), and dietType — though re-derivable from
  // counselling_sessions.answers — must not silently change if the client's
  // answers are edited after this plan was generated.
  region: text("region").notNull(),
  dietType: text("diet_type").notNull(),
  targets: jsonb("targets").notNull(),
  achieved: jsonb("achieved").notNull(),
  deviation: jsonb("deviation").notNull(),
  // The supplement in force when this plan was generated, snapshotted as
  // {name, servingLabel, servingsPerDay, proteinGPerServing, kcalPerServing}.
  // NOT a live join to roadmap_supplements: editing or removing the
  // prescription later must never retroactively change what an approved plan
  // told the client to take, the same reasoning diet_plan_recipe_items'
  // macro snapshots already follow. Null = none prescribed.
  supplement: jsonb("supplement"),
  // Every reason this plan is not a clean pass, as a string[]: per-day macro
  // misses, plausibility problems, variety breaches, serving-limit hits.
  // Nullable so every historical row backfills as "nothing recorded" rather
  // than "nothing wrong".
  //
  // Exists because the recipe engine's best-of-N path now SAVES its nearest
  // week instead of rejecting it (a confirmed decision — see CLAUDE.md). That
  // is only safe if the dietitian can see what is off, so these are persisted
  // and rendered on the plan page rather than returned once in an API
  // response nothing reads.
  warnings: jsonb("warnings").$type<string[]>(),
  // Discriminates which generation pipeline produced this plan, and
  // therefore which item table (diet_plan_items vs diet_plan_recipe_items)
  // its meals' children live in. Defaults "exchange" so every historical
  // row backfills correctly — see CLAUDE.md "The recipe engine". The
  // dish-gram engine's own "dish" value was retired and every such row
  // deleted (20260819100000_recipe_engine_pipeline.sql) — it never
  // reappears in this enum.
  engine: text("engine", { enum: ["exchange", "recipe"] }).notNull().default("exchange"),
  generationMode: text("generation_mode", { enum: ["ai", "fallback"] }).notNull(),
  modelUsed: text("model_used"),
  preparedBy: uuid("prepared_by").references(() => profiles.id),
  status: text("status", { enum: ["draft", "approved"] })
    .notNull()
    .default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietPlan = typeof dietPlans.$inferSelect
export type NewDietPlan = typeof dietPlans.$inferInsert

export const dietPlanDays = pgTable("diet_plan_days", {
  id: uuid("id").primaryKey().defaultRandom(),
  dietPlanId: uuid("diet_plan_id")
    .notNull()
    .references(() => dietPlans.id, { onDelete: "cascade" }),
  dayIndex: integer("day_index").notNull(),
  date: text("date").notNull(),
  achieved: jsonb("achieved").notNull(),
})

export type DietPlanDay = typeof dietPlanDays.$inferSelect
export type NewDietPlanDay = typeof dietPlanDays.$inferInsert

export const dietPlanMeals = pgTable("diet_plan_meals", {
  id: uuid("id").primaryKey().defaultRandom(),
  dietPlanDayId: uuid("diet_plan_day_id")
    .notNull()
    .references(() => dietPlanDays.id, { onDelete: "cascade" }),
  slot: text("slot").notNull(),
  slotOrder: integer("slot_order").notNull(),
  // Observability only — never read by nutrition math. Nullable, set null
  // on archetype deletion so retiring an archetype can't corrupt history.
  archetypeId: uuid("archetype_id").references(() => mealArchetypes.id, { onDelete: "set null" }),
})

export type DietPlanMeal = typeof dietPlanMeals.$inferSelect
export type NewDietPlanMeal = typeof dietPlanMeals.$inferInsert

export const dietPlanItems = pgTable("diet_plan_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  dietPlanMealId: uuid("diet_plan_meal_id")
    .notNull()
    .references(() => dietPlanMeals.id, { onDelete: "cascade" }),
  foodId: uuid("food_id")
    .notNull()
    .references(() => foods.id),
  exchangeType: text("exchange_type")
    .notNull()
    .references(() => exchangeTypes.code),
  exchangeCount: numeric("exchange_count", { mode: "number" }).notNull(),
  /** Null for fruit — Table 4.1 defines fruit's raw amount as variable. */
  servingRawG: numeric("serving_raw_g", { mode: "number" }),
})

export type DietPlanItem = typeof dietPlanItems.$inferSelect
export type NewDietPlanItem = typeof dietPlanItems.$inferInsert

/**
 * One row per recipe_database.csv recipe (1222 real rows after dropping 1
 * garbage row and deduping 2 true-duplicate name groups — see
 * recipe-csv-parser.ts) — the recipe engine's food data, sibling to `foods`
 * but structurally different: a recipe carries its OWN per-100g macros
 * directly (no shared exchange_type table), because the LLM only ever names
 * a recipe — every gram is computed and rebalanced in code afterward,
 * never proposed by the model at all. See CLAUDE.md "The recipe engine".
 * Replaces the deleted dish-gram engine's `dishes` table.
 */
export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  // CSV RECIPE ID — audit only, NOT unique (2 real raw duplicate ids exist
  // in the source file, both resolved to a single kept row at ingestion).
  recipeId: text("recipe_id").notNull(),
  // Grounding resolver's exact-match key — see recipe-csv-parser.ts's dedup policy.
  name: text("name").notNull().unique(),
  dietTypes: text("diet_types").array().notNull().default([]),
  // Normalized onto RECIPE_CUISINES — non-Indian/low-count cuisines are
  // relabeled "General" at ingestion (recipe-cuisine-mapping.ts), a
  // deliberate one-way transformation confirmed with the user.
  cuisine: text("cuisine").notNull(),
  category: text("category").notNull(), // raw CSV category, verbatim (~69 real values)
  macroCategory: text("macro_category"), // nullable, ~44% blank — real signal: prompt table column + fallback tie-breaker, see recipe-prompt.ts
  heavyLight: text("heavy_light").notNull(), // light | medium | heavy
  // 'liquid' | 'solid' | null (blank/unrecognized source value) — see
  // recipe-consistency-normalize.ts. Used by recipe-plausibility-validate.ts
  // to stop a liquid dish (soup/tea/shake) from anchoring lunch or dinner.
  consistency: text("consistency"),
  mainOrMid: text("main_or_mid").notNull(), // 'main' | 'mid' — prompt-only hint, never LLM-enforced
  commonality: integer("commonality").notNull(), // raw 0/1/2 — prompt bias + fallback rotation weight
  priority: text("priority"), // real values are "Primary"/"Secondary" text (verified against the real column, NOT an integer as first assumed)
  // Dietitian-authored pairing data from the CSV's own "Must/Good to have
  // Category/Recipe" columns — real values are Category strings (e.g.
  // "Pulao, Khichdi, Biryani") or literal recipe names (e.g. "Mint Chutney,
  // Coriander Chutney"), never IDs — matched case-insensitively at use time
  // (recipe-pairing.ts), not resolved/grounded at ingestion. "Must have" is
  // a hard plausibility gate (recipe-plausibility-validate.ts); "good to
  // have" is prompt-visible guidance only, never enforced.
  mustHaveCategories: text("must_have_categories").array().notNull().default([]),
  goodToHaveCategories: text("good_to_have_categories").array().notNull().default([]),
  mustHaveRecipeNames: text("must_have_recipe_names").array().notNull().default([]),
  goodToHaveRecipeNames: text("good_to_have_recipe_names").array().notNull().default([]),
  season: text("season").notNull(), // winter | summer | all_year — no monsoon signal in this data
  allergenTags: text("allergen_tags").array().notNull().default([]),
  minGrams: numeric("min_grams", { mode: "number" }).notNull(),
  maxGrams: numeric("max_grams", { mode: "number" }).notNull(),
  idealGrams: numeric("ideal_grams", { mode: "number" }).notNull(), // balancer's starting point (x0) — real authored typical portion, not an LLM guess
  servingLimitsSource: text("serving_limits_source", { enum: ["computed", "fallback_category_default"] })
    .notNull()
    .default("computed"),
  // Natural serving unit ("roti", "cup", "katori", "piece") derived from
  // `Quantity per serving` + `Wt.of Measured Amt.` — see
  // recipe-unit-label.ts. Null when the recipe is genuinely gram-measured
  // (e.g. grilled chicken) or the source text has no derivable noun; the
  // display layer falls back to a gram figure in that case.
  unitLabel: text("unit_label"),
  // Grams that ONE of unitLabel corresponds to — null iff unitLabel is null.
  perUnitGrams: numeric("per_unit_grams", { mode: "number" }),
  proteinPer100G: numeric("protein_per_100g", { mode: "number" }).notNull(),
  carbsPer100G: numeric("carbs_per_100g", { mode: "number" }).notNull(),
  fatPer100G: numeric("fat_per_100g", { mode: "number" }).notNull(),
  fiberPer100G: numeric("fiber_per_100g", { mode: "number" }).notNull(),
  // Postgres-generated column (Atwater) — never the CSV's own Energy/100gm
  // column, which mixes clean numbers with literal "#VALUE!" Excel errors.
  // Never actually null (its inputs are all NOT NULL) — annotated notNull so
  // downstream code (recipe-balancer.ts etc.) isn't forced to null-check a
  // value that can never be null in practice.
  kcalPer100G: numeric("kcal_per_100g", { mode: "number" })
    .notNull()
    .generatedAlwaysAs(sql`round(protein_per_100g * 4 + carbs_per_100g * 4 + fat_per_100g * 9, 1)`),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  rawCsvRow: jsonb("raw_csv_row").notNull(), // full raw row, audit trail only, never read for macros
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Recipe = typeof recipes.$inferSelect
export type NewRecipe = typeof recipes.$inferInsert

/**
 * Grounding tier 2 (exact -> alias -> fuzzy). alias is NOT globally unique
 * across recipes — recipe-alias-generation.ts's collision handling drops an
 * ambiguous alias entirely rather than guessing which recipe it belongs to.
 */
export const recipeAliases = pgTable("recipe_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeId: uuid("recipe_id")
    .notNull()
    .references(() => recipes.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
  source: text("source", { enum: ["generated", "manual"] }).notNull().default("generated"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type RecipeAlias = typeof recipeAliases.$inferSelect
export type NewRecipeAlias = typeof recipeAliases.$inferInsert

/**
 * The recipe engine's leaf item, sibling to diet_plan_items — hangs off the
 * SAME diet_plan_meals row the exchange engine uses (dietPlans/
 * dietPlanDays/dietPlanMeals stay 100% shared between engines; only the leaf
 * item table forks on dietPlans.engine). grams is the code-optimized final
 * value (see recipe-balancer.ts) — the LLM never proposes one at all.
 */
export const dietPlanRecipeItems = pgTable("diet_plan_recipe_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  dietPlanMealId: uuid("diet_plan_meal_id")
    .notNull()
    .references(() => dietPlanMeals.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id")
    .notNull()
    .references(() => recipes.id),
  grams: numeric("grams", { mode: "number" }).notNull(),
  // Snapshotted at generation time, NOT a live join to recipes — a later CSV
  // re-ingestion that corrects a recipe's macros must never retroactively
  // rewrite an already-approved historical plan's displayed numbers.
  proteinPer100GSnapshot: numeric("protein_per_100g_snapshot", { mode: "number" }).notNull(),
  carbsPer100GSnapshot: numeric("carbs_per_100g_snapshot", { mode: "number" }).notNull(),
  fatPer100GSnapshot: numeric("fat_per_100g_snapshot", { mode: "number" }).notNull(),
  fiberPer100GSnapshot: numeric("fiber_per_100g_snapshot", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietPlanRecipeItem = typeof dietPlanRecipeItems.$inferSelect
export type NewDietPlanRecipeItem = typeof dietPlanRecipeItems.$inferInsert

/**
 * Placeholder for the deferred v2 embedding-search grounding tier — created
 * now, unpopulated and unindexed, so v2 has a ready landing spot instead of
 * a fresh migration. Not wired into recipe-grounding.ts at all in v1. The
 * 1536 dimension is a placeholder (OpenAI-ada-002-shaped) — TBD once a real
 * embedding model is chosen; no ivfflat/hnsw index is built until then.
 */
export const recipeEmbeddings = pgTable("recipe_embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeId: uuid("recipe_id")
    .notNull()
    .unique()
    .references(() => recipes.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type RecipeEmbedding = typeof recipeEmbeddings.$inferSelect
export type NewRecipeEmbedding = typeof recipeEmbeddings.$inferInsert

/**
 * Dietitian Knowledge RAG layer (see CLAUDE.md "Dietitian knowledge
 * layer") — a SEPARATE knowledge base from `recipes`: dietitian domain
 * reasoning (regional identity, meal-slot patterns, combination rules,
 * serving norms, goal-construction principles), never recipes or
 * nutrition numbers. Retrieved and injected as descriptive prompt text
 * only — the LLM's output contract (recipe-schema.ts) is untouched.
 *
 * One row per source markdown file under
 * src/db/seed-data/dietitian-knowledge/. `regions`/`dietTypes`/`goals`/
 * `mealSlots` are v1's deterministic retrieval filter — an EMPTY array
 * means "applies universally", the same wildcard convention `foods.seasons`
 * already uses for "all_year". `regions` values reuse the exact
 * `RecipeCuisine` strings flowing through RecipeSelectorInput.cuisine, not
 * a second region vocabulary.
 */
export const dietitianKnowledgeDocs = pgTable("dietitian_knowledge_docs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  category: text("category", {
    enum: [
      "meal_pattern",
      "meal_slot",
      "region",
      "goal",
      "combination",
      "serving_norm",
      "protein",
      "variety",
      "adherence",
      "reasoning_example",
    ],
  }).notNull(),
  status: text("status", { enum: ["draft", "confirmed"] }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  confirmedBy: text("confirmed_by"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  regions: text("regions").array().notNull().default([]),
  dietTypes: text("diet_types").array().notNull().default([]),
  goals: text("goals").array().notNull().default([]),
  mealSlots: text("meal_slots").array().notNull().default([]),
  // Author-assigned relevance, 1-10 — mirrors recipes.commonality/priority's
  // existing precedent as a retrieval-ranking tie-breaker.
  weight: integer("weight").notNull().default(5),
  sourceFile: text("source_file").notNull(),
  rawMarkdown: text("raw_markdown").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietitianKnowledgeDoc = typeof dietitianKnowledgeDocs.$inferSelect
export type NewDietitianKnowledgeDoc = typeof dietitianKnowledgeDocs.$inferInsert

/** One row per markdown H2 section — the actual retrieval/injection unit. Doc-level frontmatter filters apply to every chunk of that doc; there is no per-chunk filter override (see knowledge-markdown-parser.ts). */
export const dietitianKnowledgeChunks = pgTable("dietitian_knowledge_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  docId: uuid("doc_id")
    .notNull()
    .references(() => dietitianKnowledgeDocs.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  heading: text("heading").notNull(),
  chunkOrder: integer("chunk_order").notNull(),
  content: text("content").notNull(),
  // Math.ceil(content.length / 4) at ingestion — no tokenizer dependency
  // exists in this stack; used for prompt-budget selection at retrieval.
  estimatedTokens: integer("estimated_tokens").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietitianKnowledgeChunk = typeof dietitianKnowledgeChunks.$inferSelect
export type NewDietitianKnowledgeChunk = typeof dietitianKnowledgeChunks.$inferInsert

/**
 * Placeholder for a deferred v2 semantic-retrieval tier — exact mirror of
 * recipeEmbeddings above (same 1536-dim placeholder, same "unpopulated, no
 * ANN index until a model is chosen" posture). Not wired into
 * knowledge-retrieval.ts at all in v1, which is deterministic tag-filtering
 * only.
 */
export const dietitianKnowledgeEmbeddings = pgTable("dietitian_knowledge_embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  chunkId: uuid("chunk_id")
    .notNull()
    .unique()
    .references(() => dietitianKnowledgeChunks.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietitianKnowledgeEmbedding = typeof dietitianKnowledgeEmbeddings.$inferSelect
export type NewDietitianKnowledgeEmbedding = typeof dietitianKnowledgeEmbeddings.$inferInsert

/**
 * Diet Plan Examples RAG layer (see CLAUDE.md "Diet plan examples layer")
 * — a SECOND, independent RAG layer from dietitianKnowledgeDocs/Chunks
 * above: not principles ("how dietitians think") but complete real example
 * days ("what dietitians actually build"), injected as few-shot precedent
 * ranked ABOVE the knowledge-chunk guidance. One row = one complete day,
 * never chunked — chunking a day the way knowledge docs are chunked would
 * destroy the "complete day" signal this layer exists to preserve.
 *
 * Two-tier content model: `sourceType = 'real'` rows are adapted from real,
 * credentialed public sources (source_url/source_credibility populated,
 * status starts 'draft' pending dietitian review); `sourceType =
 * 'synthetic'` rows are explicitly fabricated filler (source_url/
 * source_credibility null), used ONLY to cover combinations the real set
 * doesn't reach — retrieval never lets a synthetic row outrank an eligible
 * real one. Neither tier is ever presented to the LLM as anything other
 * than "a real example day" in framing text — the real/synthetic
 * distinction is an internal ranking/audit concern, not something exposed
 * in the prompt itself.
 */
export const dietPlanExamples = pgTable("diet_plan_examples", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  goal: text("goal", { enum: ["fat_loss", "muscle_gain", "maintenance"] }).notNull(),
  // Positive-list, NOT empty-means-universal — mirrors recipes.dietTypes'
  // existing convention exactly (r.dietTypes.includes(ctx.dietType)). An
  // example is never diet-type-universal; every compatible DietType must
  // be listed explicitly, authored by hand at ingestion same as recipes.
  dietTypes: text("diet_types").array().notNull().default([]),
  // Reuses RecipeCuisine's 9 values ("General" = pan-Indian), singular —
  // a real example was built for one region.
  region: text("region").notNull(),
  gender: text("gender", { enum: ["male", "female", "any"] }).notNull().default("any"),
  calorieMin: numeric("calorie_min", { mode: "number" }).notNull(),
  calorieMax: numeric("calorie_max", { mode: "number" }).notNull(),
  mealCount: integer("meal_count").notNull(),
  // Array of {slot, timeHint, items} — structured, not pre-formatted text,
  // so the row stays queryable/auditable and recipe-prompt.ts's formatter
  // owns rendering, same separation RecipeForPrompt/RetrievedKnowledgeChunk
  // already use. `items` are free-text strings, never grounded recipe
  // references — this layer never touches recipe-grounding.ts.
  mealStructure: jsonb("meal_structure").notNull(),
  reasoning: text("reasoning"),
  // v1 no-op at retrieval — no client-condition signal exists anywhere in
  // this pipeline yet (same class of gap goal-inference.ts closed for
  // "goal"). Ingested and stored now, ready for a v2 retrieval dimension.
  condition: text("condition").array().notNull().default([]),
  sourceType: text("source_type", { enum: ["real", "synthetic"] }).notNull().default("real"),
  // Required for sourceType='real' rows, null for 'synthetic' — enforced
  // at ingestion (seed-diet-plan-examples.ts), not a DB constraint.
  sourceUrl: text("source_url"),
  sourceCredibility: text("source_credibility"),
  status: text("status", { enum: ["draft", "confirmed"] }).notNull().default("draft"),
  weight: integer("weight").notNull().default(5),
  dayLabel: text("day_label"),
  sourceFile: text("source_file").notNull(),
  rawMarkdown: text("raw_markdown").notNull(),
  estimatedTokens: integer("estimated_tokens").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietPlanExample = typeof dietPlanExamples.$inferSelect
export type NewDietPlanExample = typeof dietPlanExamples.$inferInsert

/** Placeholder for a deferred v2 semantic-retrieval tier — mirrors recipeEmbeddings/dietitianKnowledgeEmbeddings exactly. Lower priority than even the knowledge layer's own placeholder: v1's entire similarity surface (goal/dietType/region/calories/mealCount) is literal structured columns, nothing here benefits from embeddings without also changing what's matched. */
export const dietPlanExampleEmbeddings = pgTable("diet_plan_example_embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  exampleId: uuid("example_id")
    .notNull()
    .unique()
    .references(() => dietPlanExamples.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type DietPlanExampleEmbedding = typeof dietPlanExampleEmbeddings.$inferSelect
export type NewDietPlanExampleEmbedding = typeof dietPlanExampleEmbeddings.$inferInsert

/** Every generation attempt — you will need this the first time a dietitian says "the plan looks wrong". */
export const planGenerationRuns = pgTable("plan_generation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  roadmapId: uuid("roadmap_id")
    .notNull()
    .references(() => roadmaps.id),
  weekNumber: integer("week_number").notNull(),
  dietPlanId: uuid("diet_plan_id").references(() => dietPlans.id, { onDelete: "set null" }),
  attemptNumber: integer("attempt_number").notNull(),
  // Null = a whole-week attempt. Set = a single-day retry attempt (recipe
  // engine only) — lets /settings/generation-log distinguish the two.
  dayIndex: integer("day_index"),
  model: text("model"),
  promptHash: text("prompt_hash").notNull(),
  rawResponse: text("raw_response"),
  validationResult: jsonb("validation_result").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  // Dietitian Knowledge RAG audit trail — {injected: [...], droppedForBudget:
  // [...]} chunk slugs. Null for every exchange-engine run and any
  // recipe-engine run predating DIETITIAN_KNOWLEDGE_ENABLED, not backfilled.
  knowledgeChunksInjected: jsonb("knowledge_chunks_injected"),
  // Diet Plan Examples RAG audit trail — same {injected, droppedForBudget}
  // shape, a sibling column (not merged into knowledgeChunksInjected) so
  // the two RAG layers stay independently queryable. Null for every run
  // predating DIET_PLAN_EXAMPLES_ENABLED.
  dietPlanExamplesInjected: jsonb("diet_plan_examples_injected"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type PlanGenerationRun = typeof planGenerationRuns.$inferSelect
export type NewPlanGenerationRun = typeof planGenerationRuns.$inferInsert

/** One row per POST /api/plan/generate call (not per LLM attempt) — backs the Postgres-counter rate limit. See rate-limit.ts. */
export const planGenerationRequests = pgTable("plan_generation_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => profiles.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type PlanGenerationRequest = typeof planGenerationRequests.$inferSelect
