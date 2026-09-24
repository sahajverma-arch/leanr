import { describe, expect, it } from "vitest"

import { MEAL_NOTE_MAX_LENGTH, MealNoteValidationError, normalizeMealNote } from "./meal-note"

describe("normalizeMealNote", () => {
  it("keeps an ordinary note as typed", () => {
    expect(normalizeMealNote("Soak rajma overnight. Add jeera tadka.")).toBe("Soak rajma overnight. Add jeera tadka.")
  })

  it("treats an empty or whitespace-only note as clearing it", () => {
    expect(normalizeMealNote("")).toBeNull()
    expect(normalizeMealNote("   \n\n  ")).toBeNull()
  })

  it("trims, collapses runs of spaces, and limits blank lines", () => {
    expect(normalizeMealNote("  Add   hing  \r\n\r\n\r\n\r\nServe  hot  ")).toBe("Add hing\n\nServe hot")
  })

  it("keeps line breaks the dietitian typed", () => {
    expect(normalizeMealNote("1. Soak dal\n2. Pressure cook")).toBe("1. Soak dal\n2. Pressure cook")
  })

  it("replaces characters the PDF font lacks when there is a faithful plain equivalent", () => {
    expect(normalizeMealNote("Dal → tadka, costs ₹20")).toBe("Dal -> tadka, costs Rs 20")
  })

  it("accepts smart quotes, dashes and accented letters, which the PDF font has", () => {
    expect(normalizeMealNote("“Crème” — don’t skip… • ½ tsp")).toBe("“Crème” — don’t skip… • ½ tsp")
  })

  it("refuses Hindi and emoji rather than printing them as garbage", () => {
    expect(() => normalizeMealNote("हींग डालें")).toThrow(MealNoteValidationError)
    expect(() => normalizeMealNote("Add lemon 🍋")).toThrow(/can't print "🍋"/)
  })

  it("refuses a note over the length limit", () => {
    expect(() => normalizeMealNote("a".repeat(MEAL_NOTE_MAX_LENGTH + 1))).toThrow(MealNoteValidationError)
    expect(normalizeMealNote("a".repeat(MEAL_NOTE_MAX_LENGTH))).toHaveLength(MEAL_NOTE_MAX_LENGTH)
  })
})
