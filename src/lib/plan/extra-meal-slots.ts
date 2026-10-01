/**
 * Optional meals a dietitian can add to a client's day: a wake-up drink and a
 * bedtime snack/drink.
 *
 * They are NOT part of meal_templates and are never shown to the model. A
 * ticked one is written to the plan as an EMPTY meal on every day — a slot in
 * the skeleton — and the dietitian fills it on the plan page with "+ add",
 * which re-balances the day like any other edit. In "Same food on all days"
 * the dietitian can also choose its dishes up front (fixed-menu.ts).
 *
 * Pure, zero I/O.
 */

import { z } from "zod"

import type { MealSlotInfo } from "./recipe-types"

export const EXTRA_MEAL_SLOTS = [
  // slotOrder sits outside every meal_templates range (1..5): wake-up before
  // breakfast, bedtime after dinner, whatever the client's meal count.
  { slot: "wake_up", label: "Wake-up drink", slotOrder: 0 },
  { slot: "bedtime", label: "Bedtime", slotOrder: 99 },
] as const

export type ExtraMealSlot = (typeof EXTRA_MEAL_SLOTS)[number]["slot"]

const EXTRA_SLOT_VALUES = EXTRA_MEAL_SLOTS.map((s) => s.slot) as [ExtraMealSlot, ...ExtraMealSlot[]]

export const extraMealSlotsSchema = z.array(z.enum(EXTRA_SLOT_VALUES)).max(EXTRA_MEAL_SLOTS.length)

const EXTRA_SLOT_SET: ReadonlySet<string> = new Set(EXTRA_SLOT_VALUES)

export function isExtraMealSlot(slot: string): boolean {
  return EXTRA_SLOT_SET.has(slot)
}

/** Slot info for the ticked extras, in day order. Unknown values are ignored. */
export function extraMealSlotInfos(slots: readonly string[]): MealSlotInfo[] {
  return EXTRA_MEAL_SLOTS.filter((s) => slots.includes(s.slot)).map((s) => ({ slot: s.slot, slotOrder: s.slotOrder, timeHint: null }))
}
