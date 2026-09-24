/**
 * Substring-match bucketing of a recipe's raw `Category` column (~69 real
 * distinct values, not fully enumerable in advance) into a small fixed set —
 * used by the deterministic fallback selector's meal-role pooling, the
 * serving-limit fallback table (recipe-quantity-normalize.ts), and
 * recipe-plausibility-validate.ts's lunch/dinner staple+dal structural
 * check. Still NOT used to filter what the LLM sees (the LLM gets the full
 * eligible pool, unfiltered by bucket — see recipe-prompt.ts).
 *
 * Every category landing on "other" must be printed by seed-recipes.ts so
 * this table gets extended against real ingestion output, not guessed.
 *
 * `name` is optional but should be passed whenever available: "Sabzi" is
 * this dataset's catch-all Category for BOTH dry vegetable dishes (Karela
 * Sabzi, Bhindi Masala) and genuine gravy-based curries — including
 * legume/pulse curries functionally equivalent to a dal (Rajma Curry, Kala
 * Chana Curry, White Chana Curry) — the Category column alone can't tell
 * them apart, only the dish's own name can. Found on a real live-generation
 * run: the "lunch/dinner needs a Dal/Curry dish" structural rule was
 * starving on an artificially thin 6-recipe dal_curry pool because these 6
 * genuine curries were invisible to it, sabzi-bucketed by Category alone —
 * confirmed by checking the real seeded data, not guessed.
 */

export type RecipeCategoryBucket =
  | "heavy_meal"
  | "light_meal"
  | "sabzi"
  | "dal_curry"
  | "rice_pulao"
  | "bread"
  | "snack"
  | "dessert"
  | "salad"
  | "soup"
  | "beverage"
  | "fruit"
  | "other"

export function recipeCategoryBucket(category: string, name?: string): RecipeCategoryBucket {
  const c = category.toLowerCase()
  if (c.includes("heavy meal")) return "heavy_meal"
  if (c.includes("light meal")) return "light_meal"
  if (c.includes("sabzi")) return name && /curry/i.test(name) ? "dal_curry" : "sabzi"
  if (c.includes("curry") || c.includes("dal") || c.includes("khichdi") || c.includes("khichuri")) return "dal_curry"
  if (c.includes("rice") || c.includes("pulao") || c.includes("biryani")) return "rice_pulao"
  // "Thepla" is a Gujarati flatbread — a roti in every structural sense. Left
  // out, all 9 thepla recipes fell to "other" and could never stand in for a
  // chilla or roti. "Tikki" is a patty snack (Aloo Tikki, Dhebra).
  if (c.includes("roti") || c.includes("paratha") || c.includes("chila") || c.includes("thepla") || c.includes("wrap") || c.includes("sandwich")) return "bread"
  if (c.includes("snack") || c.includes("chaat") || c.includes("tikki")) return "snack"
  if (c.includes("dessert")) return "dessert"
  if (c.includes("salad") || c.includes("raita")) return "salad"
  if (c.includes("soup")) return "soup"
  if (c.includes("smoothie") || c.includes("juice") || c.includes("water") || c.includes("cereal")) return "beverage"
  if (c.includes("fruit")) return "fruit"
  return "other"
}
