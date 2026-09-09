/**
 * The recipe engine's LLM contract, deliberately narrower than the deleted
 * dish engine's: the model only ever names real recipes for a sensible
 * day's meals. No per-meal kcal/macro targets, no meal-percentage split, no
 * fat/carb-balance micromanagement — that entire class of rule existed only
 * because the old LLM ALSO picked grams. This one never does (spec point 3:
 * "Output ONLY recipe names. Never calculate calories, macros, or grams.").
 */

import type { RetrievedDietPlanExample } from "./diet-plan-example-retrieval"
import type { RetrievedKnowledgeChunk } from "./knowledge-retrieval"
import { formatSlotStructureRules } from "./recipe-meal-structure"
import type { DailyRecipeTarget, GroundedRecipeDay, RecipeForPrompt, RecipeSelectorInput } from "./recipe-types"

export const SYSTEM_PROMPT = `You are an expert Indian dietitian composing a realistic weekly meal plan for a client.

Rules:
- You ONLY choose which named recipes go in which meal slot, on which day. You NEVER calculate, estimate, or output a calorie, macro, or gram figure for anything — a separate program computes every quantity from the recipes you name.
- Copy each recipe's Name EXACTLY as it appears in the table you're given — do not paraphrase, abbreviate, translate, or invent a recipe name.
- Choose ONLY from the recipe table provided in the user message. Never invent a dish that isn't listed.
- A real meal usually centers on one MAIN dish, optionally with 1-2 lighter MID accompaniments (side, chutney, salad) — use the Main/Mid column as a guide for realistic composition, not a rigid rule.
- Some recipes list a "[needs: ...]" or "[goes well with: ...]" tag after their row — real dietitian pairing data. "needs" is a hard requirement checked automatically (a day missing it gets sent back for a redo): if you choose that recipe, include a matching category or recipe from its "needs" list elsewhere in the same meal. "goes well with" is a soft preference, not required.
- Lunch and dinner MUST each be built around a substantial dish (Category like Rice, Roti/Paratha/Bread, Dal Curry, Heavy Meal, Light Meal, Pulao/Biryani, Sabzi) that meaningfully contributes real calories and macros — never build lunch or dinner entirely out of tea, coffee, soup, salad, raita, or a smoothie/shake. Those are appropriate for breakfast/mid_morning/evening accompaniments, not as the whole of a main meal.
- PROTEIN IS THE TARGET THAT GETS MISSED, every time, and it is missed LOW. A normal-looking Indian day of roti, rice, sabzi, fruit and tea lands well under the protein target while overshooting carbs — measured repeatedly, not hypothetical. Every lunch and dinner must include at least one genuinely protein-dense dish (dal, chana, rajma, sprouts, paneer, tofu, soya, egg, curd, chicken or fish — read the Protein/100g column and prefer the higher numbers), and breakfast should usually include one too. Cereals, vegetables and fruit cannot reach the protein total no matter how much of them is served, so do not rely on them for it.
- If a choice is between two otherwise-equally-realistic dishes, take the one with more protein per 100g and less carbohydrate per 100g. Carbs are the easiest macro to overshoot: rice, roti, paratha, poha, upma and potato add up faster than they look.
- The day's targets are a whole-day total across every meal, not just one meal — a day built mostly from light snacks and beverages will fall far short of EVERY target even if each individual item looks reasonable. Weigh a lunch/dinner choice by how much it actually contributes toward the day's total, not just whether it's a plausible thing to eat.
- Avoid using the same recipe more than twice across the 7 days — vary the week the way a real household would.
- Commonality is a tie-breaker between otherwise-similar choices, not a reason to fill every meal with the simplest, most common snack or drink — hitting the day's calorie/macro totals with a substantial lunch and dinner matters more than commonality.
- You may be given a short "Dietitian guidance" section for this client's region and goal — treat it as an experienced Indian dietitian's real judgment about realistic combinations, alongside (never instead of) the recipe table and targets above.
- You may also be given "Real example day(s)" — actual complete days built by real dietitians for a similar client. These carry MORE weight than the general Dietitian guidance bullets above: when an example's specific structure conflicts with a general guidance bullet, follow the example. Neither ever overrides the recipe table or the numeric daily targets.
- Respond with valid JSON only, matching the schema you are shown, with no commentary outside the JSON.`

// Only appended for the recipes that actually declare pairing data (a
// minority — see seed-recipes.ts's own "Recipes with pairing data" run
// diagnostics) — keeps the table's other rows exactly as before this layer
// existed, rather than adding two mostly-empty columns to every row.
function formatPairingSuffix(r: RecipeForPrompt): string {
  const needs = [...r.mustHaveCategories, ...r.mustHaveRecipeNames]
  const goodWith = [...r.goodToHaveCategories, ...r.goodToHaveRecipeNames]
  const parts: string[] = []
  if (needs.length > 0) parts.push(`needs: ${needs.join("/")}`)
  if (goodWith.length > 0) parts.push(`goes well with: ${goodWith.join("/")}`)
  return parts.length > 0 ? ` [${parts.join("; ")}]` : ""
}

function formatRecipeTable(recipesForPrompt: RecipeForPrompt[]): string {
  const header = "Name | Category | Main/Mid | Consistency | Cuisine | Macro Category | Commonality | Protein/100g | Carbs/100g | Fat/100g | Fiber/100g | Kcal/100g"
  const rows = recipesForPrompt.map(
    (r) =>
      `${r.name} | ${r.category} | ${r.mainOrMid} | ${r.consistency ?? "-"} | ${r.cuisine} | ${r.macroCategory ?? "-"} | ${r.commonality} | ${r.proteinPer100G} | ${r.carbsPer100G} | ${r.fatPer100G} | ${r.fiberPer100G} | ${r.kcalPer100G}${formatPairingSuffix(r)}`
  )
  return [header, ...rows].join("\n")
}

/**
 * Absolute grams AND the share of calories each macro should supply.
 *
 * The shares are descriptive framing, not arithmetic the model performs —
 * it still only ever outputs recipe names, and every quantity is computed in
 * code afterwards (see CLAUDE.md "THE ONE RULE THAT MATTERS"). They exist
 * because absolute grams alone gave the model no sense of BALANCE: measured
 * across five independent samples for one real client, every single one came
 * back protein ~11% under and carbs ~19% over. A gram total says how much;
 * a share says what the day should be made of.
 */
function formatDailyTarget(target: DailyRecipeTarget): string {
  const pct = (grams: number, kcalPerG: number) =>
    target.kcal > 0 ? Math.round(((grams * kcalPerG) / target.kcal) * 100) : 0
  return (
    `Calories: ${Math.round(target.kcal)} kcal, Protein: ${Math.round(target.proteinG)} g, ` +
    `Carbs: ${Math.round(target.carbsG)} g, Fat: ${Math.round(target.fatG)} g, Fiber: ${Math.round(target.fiberG)} g` +
    ` (roughly ${pct(target.proteinG, 4)}% of calories from protein, ${pct(target.carbsG, 4)}% carbs, ${pct(target.fatG, 9)}% fat)`
  )
}

/** Empty/absent (DIETITIAN_KNOWLEDGE_ENABLED off, or nothing retrieved) returns "" — the prompt is byte-identical to before this layer existed. */
function formatKnowledgeSection(chunks?: RetrievedKnowledgeChunk[]): string {
  if (!chunks || chunks.length === 0) return ""
  const lines = chunks.map((c) => `- [${c.heading}] ${c.content}`)
  return `\nDietitian guidance for this client (an experienced Indian dietitian's real judgment about how to combine the recipes above — it never overrides the recipe list or the daily targets):\n${lines.join("\n")}\n`
}

/** Empty/absent (DIET_PLAN_EXAMPLES_ENABLED off, or nothing retrieved) returns "" — the prompt is byte-identical to before this layer existed. Injected AFTER formatKnowledgeSection (knowledge-first-then-examples) and framed as carrying MORE weight than it, per CLAUDE.md "Diet plan examples layer". */
function formatExamplesSection(examples?: RetrievedDietPlanExample[]): string {
  if (!examples || examples.length === 0) return ""
  const blocks = examples.map((ex) => {
    const mealLines = ex.mealStructure
      .map((m) => `  ${m.slot}${m.timeHint ? ` (${m.timeHint})` : ""}: ${m.items.join("; ")}`)
      .join("\n")
    const reasoningLine = ex.reasoning ? `\n  Why: ${ex.reasoning}` : ""
    return `[${ex.region}, ${ex.goal.replace("_", " ")}, ~${Math.round((ex.calorieMin + ex.calorieMax) / 2)} kcal]\n${mealLines}${reasoningLine}`
  })
  return `\nReal example day(s) built by experienced dietitians for a similar client (these carry MORE weight than the guidance above — when a specific example's structure and the guidance above would suggest different choices, follow the example; it never overrides the recipe list or the daily targets):\n${blocks.join("\n\n")}\n`
}

export function buildDaySchemaExample(): string {
  return JSON.stringify({ dayIndex: 0, meals: [{ slot: "breakfast", items: [{ name: "Exact Recipe Name" }] }] }, null, 2)
}

function buildFullWeekSchemaExample(): string {
  return JSON.stringify({ days: [{ dayIndex: 0, meals: [{ slot: "breakfast", items: [{ name: "Exact Recipe Name" }] }] }] }, null, 2)
}

export interface PromptMessage {
  role: "system" | "user"
  content: string
}

export function buildInitialMessages(input: RecipeSelectorInput): PromptMessage[] {
  const slotsLine = input.slots.map((s) => `${s.slot}${s.timeHint ? ` (${s.timeHint})` : ""}`).join(", ")
  const previousDayNote = input.previousWeekLastDayRecipeNames
    ? `\nAvoid repeating these recipes from the previous week's final day where possible: ${Object.values(input.previousWeekLastDayRecipeNames).flat().join(", ")}.`
    : ""

  const userContent = `Client profile: diet type "${input.dietType}", cuisine "${input.cuisine}", ${input.mealCount} meals/day.
Meal slots, in order: ${slotsLine}.
Daily targets (average across the week): ${formatDailyTarget(input.dailyTarget)}.${previousDayNote}
${formatSlotStructureRules(input.slots.map((s) => s.slot))}
Available recipes (choose ONLY from this list, copying the Name column EXACTLY):
${formatRecipeTable(input.eligibleRecipesForPrompt)}
${formatKnowledgeSection(input.knowledgeChunks)}
${formatExamplesSection(input.dietPlanExamples)}
Compose a full 7-day plan (dayIndex 0 through 6). For each day, assign recipes to every meal slot listed above.

Respond with JSON matching this schema exactly:
${buildFullWeekSchemaExample()}`

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]
}

export function buildDayRetryMessages(input: RecipeSelectorInput, day: GroundedRecipeDay, diagnoses: string[]): PromptMessage[] {
  const slotsLine = input.slots.map((s) => s.slot).join(", ")
  const currentDayDescription = day.meals
    .map((m) => `  ${m.slot}: ${m.items.map((i) => i.recipe.name).join(", ") || "(empty)"}`)
    .join("\n")

  const userContent = `Day ${day.dayIndex} of the plan needs to be regenerated. Here is what was chosen last time and what's wrong with it:
${currentDayDescription}

Problems:
${diagnoses.map((d) => `- ${d}`).join("\n")}

Daily targets: ${formatDailyTarget(input.dailyTarget)}
Meal slots, in order: ${slotsLine}.
${formatSlotStructureRules(input.slots.map((s) => s.slot))}
Available recipes (choose ONLY from this list, copying the Name column EXACTLY):
${formatRecipeTable(input.eligibleRecipesForPrompt)}
${formatKnowledgeSection(input.knowledgeChunks)}
${formatExamplesSection(input.dietPlanExamples)}
Choose DIFFERENT recipes for day ${day.dayIndex} that address the problems above — a different dish, not a different amount (you never specify amounts).

Respond with JSON matching this schema exactly:
${buildDaySchemaExample()}`

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]
}
