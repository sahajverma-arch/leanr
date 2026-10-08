/**
 * Dietitian-level corrections applied to the source recipe CSV at INGESTION
 * time — never by patching the DB, which the next `npm run seed:recipes`
 * would silently undo (a lesson CLAUDE.md already records for the Milk /
 * milk_cow mealSlots regression). Same shape as the hardcoded duplicate-row
 * exception in recipe-csv-parser.ts: a small, explicit, reasoned table
 * rather than a blanket rule.
 *
 * Nothing here invents a recipe or a nutrition figure. Every row keeps its
 * own verified per-100g macros and its own authored serving range; only two
 * classification fields are corrected, and the untouched source row is
 * still preserved verbatim in `recipes.raw_csv_row` for audit.
 *
 * WHY THIS EXISTS — found by profiling the real ingested data, not assumed:
 * a generated North Indian vegetarian week could not put a dal next to rice
 * on any day. The cause was two independent gaps, neither of them a missing
 * recipe:
 *
 *   1. Of 52 recipes whose Category is literally "Dal" or "Curry", 43 are
 *      tagged Season="Winter" in the source. Only ONE (Lentil Soup) is
 *      both all-year AND in the General/North Indian cuisine pool — so an
 *      all-year plan had exactly one dal to choose from.
 *   2. Several everyday dals and legume curries carry Category="Sabzi" or
 *      "High Protein Sabzi". recipe-pairing.ts matches a "must have"
 *      requirement against that literal category TEXT, so a dish's
 *      structural bucket being dal_curry is not enough — Rice's
 *      [Curry/Dal] requirement could never be satisfied by them.
 */

import type { Season } from "./vocab"

export interface CurationOverride<T> {
  value: T
  reason: string
}

/**
 * Category corrections, keyed by exact recipe name.
 *
 * Scoped deliberately to dishes that are genuinely the DAL/CURRY course of
 * a meal — a lentil or legume preparation, or a besan/yogurt kadhi. Plain
 * vegetable gravies keep Category="Sabzi" on purpose (Aloo Tamatar Sabzi
 * With Gravy, Pumpkin Sabzi With Gravy, and the other "... With Gravy"
 * rows): they are the sabzi of a thali, not its dal, and promoting them
 * would let the lunch/dinner "needs a Dal/Curry" structural check be
 * satisfied by a potato gravy — weakening the exact rule it exists to
 * enforce. Cauliflower Curry is likewise left alone: it is a vegetable
 * dish, and recipe-category.ts already buckets it as dal_curry off its own
 * name, so it needs no help here.
 */
export const CATEGORY_OVERRIDES: Record<string, CurationOverride<string>> = {
  // Legume gravies — the protein course, not a vegetable side.
  "Rajma Curry": { value: "Curry", reason: "Kidney-bean gravy: the meal's protein/curry course, mislabelled Sabzi." },
  "Kala Chana Curry": { value: "Curry", reason: "Black-chana gravy: legume curry course, mislabelled Sabzi." },
  "White Chana Curry": { value: "Curry", reason: "Chole: legume curry course, mislabelled Sabzi." },
  "Mixed Sprouts Usal": { value: "Curry", reason: "Sprouted-legume usal is a gravy curry course, mislabelled Sabzi." },
  "Kadhi Without Pakoda": { value: "Curry", reason: "Besan-and-yogurt kadhi is the canonical curry course, mislabelled Sabzi." },

  // Lentil preparations that are literally dal.
  Sambhar: { value: "Dal", reason: "Toor-dal-and-vegetable preparation — the South Indian dal course, mislabelled Sabzi." },
  Rasam: { value: "Dal", reason: "Tamarind-and-lentil broth served as the dal course with rice, mislabelled Sabzi." },
  "Tomato Rasam": { value: "Dal", reason: "Rasam variant; same dal course, mislabelled Sabzi." },
  "Ginger Lemon Rasam": { value: "Dal", reason: "Rasam variant; same dal course, mislabelled Sabzi." },
  "Dal Palak": { value: "Dal", reason: "Spinach dal — a dal by name and composition, mislabelled High Protein Sabzi." },
  "Palak Moong Dal": { value: "Dal", reason: "Moong dal with spinach — a dal, mislabelled High Protein Sabzi." },
}

/**
 * Season corrections, keyed by exact recipe name. All of these are
 * Season="Winter" in the source; every one is a year-round Indian staple,
 * which is a culinary fact rather than a preference — a household does not
 * stop eating plain arhar dal in July.
 *
 * Genuinely seasonal dishes are deliberately NOT corrected, so this table
 * stays a correction rather than a blanket unlock: the palak (spinach) dals
 * — Dal Palak, Palak Moong Dal, Haryali Palak Shorba — stay winter because
 * spinach really is a North Indian winter crop, and Bajra Kadi stays winter
 * because bajra is a winter millet. They remain fully available to a winter
 * plan, and their Category corrections above still apply there.
 */
export const SEASON_OVERRIDES: Record<string, CurationOverride<Season>> = {
  // Plain everyday dals.
  "Arhar Dal Without Tadka": { value: "all_year", reason: "Plain toor dal is the everyday year-round Indian dal." },
  "Urad Dal Without Tadka": { value: "all_year", reason: "Plain urad dal is eaten year-round." },
  "Chana Dal": { value: "all_year", reason: "Dried split chana keeps and is cooked year-round." },
  "Mixed Dal (Moong Masoor Dal)": { value: "all_year", reason: "Everyday mixed dal, not seasonal." },
  "Moong Dal Shorba": { value: "all_year", reason: "Light moong dal preparation, eaten year-round." },
  "High Protein Dal": { value: "all_year", reason: "Generic high-protein dal blend, not tied to a season." },

  // Legume curries built on dried pulses — available and eaten all year.
  "Rajma Curry": { value: "all_year", reason: "Dried kidney beans are a year-round pantry staple." },
  "Kala Chana Curry": { value: "all_year", reason: "Dried black chana is a year-round pantry staple." },
  "White Chana Curry": { value: "all_year", reason: "Chole is eaten year-round." },
  "Mixed Sprouts Usal": { value: "all_year", reason: "Sprouted pulses are made year-round." },

  // Yogurt/besan and non-seasonal-protein curries.
  "Kadhi Without Pakoda": { value: "all_year", reason: "Besan and yogurt are year-round; kadhi is if anything a hot-weather dish." },
  "Non-Dairy Kadhi": { value: "all_year", reason: "Same as kadhi above; no seasonal ingredient." },
  "Tofu Curry": { value: "all_year", reason: "Tofu is not a seasonal ingredient." },

  // Year-round South Indian staples.
  Sambhar: { value: "all_year", reason: "Sambhar is an everyday year-round South Indian staple." },
  Rasam: { value: "all_year", reason: "Rasam is served year-round." },
  "Ginger Lemon Rasam": { value: "all_year", reason: "Rasam variant; served year-round." },

  // Year-round vegetable curry.
  "Dum Aloo": { value: "all_year", reason: "Potato is available and cooked year-round." },
}

/**
 * Recipes a dietitian has removed from use, keyed by exact recipe name.
 *
 * Seeded with `is_active = false` rather than deleted: saved plans still
 * reference the row (and snapshot its macros), so deleting it would break
 * them. An inactive recipe is never offered to generation, the swap/add
 * pickers or the fixed menu. Listed here, not patched in the DB, because
 * the next `npm run seed:recipes` would otherwise bring it back.
 */
export const RETIRED_RECIPES: Record<string, { reason: string }> = {
  "Sprout Chilla": {
    reason:
      "Same dish as Moong Dal Chilla (dietitian, 2026-10-08). Its own row also claimed only 1.5 g protein / 100 g.",
  },
}

/**
 * Tracks which override keys actually matched a real recipe during a run,
 * so a name drifting in a future CSV refresh surfaces as a warning instead
 * of silently disabling a correction — the same "never silent" discipline
 * seed-recipes.ts already applies to unrecognized seasons and "other"
 * category buckets.
 */
export class CurationOverrideTracker {
  private readonly usedCategory = new Set<string>()
  private readonly usedSeason = new Set<string>()
  private readonly usedRetired = new Set<string>()

  isRetired(recipeName: string): boolean {
    if (!RETIRED_RECIPES[recipeName]) return false
    this.usedRetired.add(recipeName)
    return true
  }

  applyCategory(recipeName: string, sourceCategory: string): string {
    const override = CATEGORY_OVERRIDES[recipeName]
    if (!override) return sourceCategory
    this.usedCategory.add(recipeName)
    return override.value
  }

  applySeason(recipeName: string, sourceSeason: Season): Season {
    const override = SEASON_OVERRIDES[recipeName]
    if (!override) return sourceSeason
    this.usedSeason.add(recipeName)
    return override.value
  }

  get appliedCategoryCount(): number {
    return this.usedCategory.size
  }

  get appliedSeasonCount(): number {
    return this.usedSeason.size
  }

  /** Override keys that never matched a recipe — a stale table entry, or a renamed source row. */
  unmatched(): { category: string[]; season: string[]; retired: string[] } {
    return {
      retired: Object.keys(RETIRED_RECIPES).filter((n) => !this.usedRetired.has(n)),
      category: Object.keys(CATEGORY_OVERRIDES).filter((n) => !this.usedCategory.has(n)),
      season: Object.keys(SEASON_OVERRIDES).filter((n) => !this.usedSeason.has(n)),
    }
  }
}
