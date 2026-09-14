import { Fragment } from "react"

import { AddItemButton } from "./add-item-button"
import { PlanItemButton } from "./plan-item-button"
import { formatItemQuantity } from "@/lib/plan/format-item"
import { composeMealDisplay } from "@/lib/plan/meal-composition"
import { combineDishGroups } from "@/lib/plan/dish-combination"
import { applyVegetableDishNames } from "@/lib/plan/vegetable-dish-naming"
import { isMixedVegDay } from "@/lib/plan/mixed-veg-day"
import type { PlanViewItem } from "@/lib/plan/plan-view-model"
import type { ExchangeCode } from "@/lib/plan/table-4-1"
import type { DishCombination, VegetableDishCombination, VegetableDishCombinationMember } from "@/db/schema"

/**
 * Renders one meal's items grouped into human-readable dishes (see
 * meal-composition.ts, then dish-combination.ts, then
 * vegetable-dish-naming.ts) while keeping every underlying food
 * individually editable — grouping only changes the surrounding
 * label/brackets, never which item a click targets or what it's swapped
 * against.
 *
 * What a click opens depends on the engine, and PlanItemButton decides that
 * from the item itself: a recipe item gets the full edit dialog (quantity,
 * swap, remove), an exchange item the older swap-only one. The "+ add"
 * affordance is recipe-engine only for the same reason — an exchange meal's
 * contents are fixed by the solved exchange counts, not chosen dish by dish.
 */
export function ComposedMealCell({
  items,
  mealId,
  slotLabel,
  region,
  editable,
  canAddItems,
  archetypeName,
  archetypeDishFamilyIdsByExchangeType,
  dishCombinations,
  vegetableDishCombinations,
  vegetableDishCombinationMembers,
  rotationDay,
}: {
  items: PlanViewItem[]
  /** diet_plan_meals.id — where an added dish goes. */
  mealId: string
  /** "Breakfast", "Lunch" … — only to name the meal in the add dialog's title. */
  slotLabel: string
  region: string
  editable: boolean
  /** Recipe-engine plans only — an exchange meal's contents are fixed by the solved exchange counts, not chosen dish by dish. */
  canAddItems: boolean
  /** Meal's archetypeName from PlanViewMeal — null for meals not generated from a meal_archetype. */
  archetypeName: string | null
  /** Meal's archetypeDishFamilyIdsByExchangeType from PlanViewMeal — see dish-combination.ts's merge gate. */
  archetypeDishFamilyIdsByExchangeType: Partial<Record<ExchangeCode, string[]>>
  dishCombinations: DishCombination[]
  vegetableDishCombinations: VegetableDishCombination[]
  vegetableDishCombinationMembers: VegetableDishCombinationMember[]
  /** day.dayIndex + (plan.weekNumber - 1) * 7 — same rotationDay concept the generator used, so the "one mixed-veg day a week" display gate (see vegetable-dish-naming.ts) lands on the SAME day the selector treated as special. */
  rotationDay: number
}) {
  const groups = applyVegetableDishNames(
    combineDishGroups(
      composeMealDisplay(items, region),
      archetypeName,
      archetypeDishFamilyIdsByExchangeType,
      dishCombinations,
      region
    ),
    vegetableDishCombinations,
    vegetableDishCombinationMembers,
    region,
    isMixedVegDay(rotationDay)
  )

  return (
    <>
      {groups.map((group, gi) => (
        <Fragment key={group.items[0].id}>
          {group.kind === "plain" && <PlanItemButton item={group.items[0]} editable={editable} />}

          {group.kind === "single_dish" && (
            <PlanItemButton
              item={group.items[0]}
              editable={editable}
              label={`${group.dishName} (${formatItemQuantity(group.items[0])})`}
            />
          )}

          {group.kind === "mixed_dish" && (
            <>
              {group.dishName} (
              {group.items.map((item, i) => (
                <Fragment key={item.id}>
                  <PlanItemButton item={item} editable={editable} label={`${item.nameEn} ${formatItemQuantity(item)}`} />
                  {i < group.items.length - 1 ? ", " : ""}
                </Fragment>
              ))}
              )
            </>
          )}

          {gi < groups.length - 1 ? ", " : ""}
        </Fragment>
      ))}
      {/* Shown on an empty meal too — that is precisely when it is needed,
          since a meal can be emptied by deleting its last item. */}
      {editable && canAddItems && (
        <>
          {groups.length > 0 && " "}
          <AddItemButton mealId={mealId} slotLabel={slotLabel} />
        </>
      )}
    </>
  )
}
