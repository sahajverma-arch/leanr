import { describe, expect, it } from "vitest"

import {
  CHECKIN_QUESTIONS,
  MENSTRUAL_ID,
  WEIGHT_ID,
  checkinQuestionsFor,
  checkinSubmitErrors,
  describeCheckinAnswers,
  sanitizeCheckinAnswers,
} from "./checkin-questions"

describe("checkinQuestionsFor", () => {
  it("asks about the menstrual cycle only for female clients", () => {
    expect(checkinQuestionsFor({ female: true }).some((q) => q.id === MENSTRUAL_ID)).toBe(true)
    expect(checkinQuestionsFor({ female: false }).some((q) => q.id === MENSTRUAL_ID)).toBe(false)
  })

  it("has unique ids", () => {
    const ids = CHECKIN_QUESTIONS.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("sanitizeCheckinAnswers", () => {
  const questions = checkinQuestionsFor({ female: true })

  it("drops unknown ids, blanks, and notes whose trigger no longer applies", () => {
    const out = sanitizeCheckinAnswers(
      {
        [WEIGHT_ID]: 76.4,
        fu_outing: "No",
        fu_outing_note: "wedding Saturday", // hidden once outing is "No"
        fu_sleep: "",
        fu_digestion: [],
        hacker: "x",
      },
      questions
    )
    expect(out).toEqual({ [WEIGHT_ID]: 76.4, fu_outing: "No" })
  })

  it("keeps a note while its trigger applies", () => {
    const out = sanitizeCheckinAnswers({ fu_outing: "Yes", fu_outing_note: "  wedding Saturday " }, questions)
    expect(out.fu_outing_note).toBe("wedding Saturday")
  })

  it("drops the menstrual answer for a client not asked it", () => {
    const out = sanitizeCheckinAnswers({ [MENSTRUAL_ID]: "On period now" }, checkinQuestionsFor({ female: false }))
    expect(out[MENSTRUAL_ID]).toBeUndefined()
  })

  it("rejects non-plain values at the boundary", () => {
    expect(() => sanitizeCheckinAnswers({ fu_sleep: { nested: true } }, questions)).toThrow()
  })
})

describe("checkinSubmitErrors", () => {
  it("requires a plausible weight", () => {
    expect(checkinSubmitErrors({})[WEIGHT_ID]).toBeDefined()
    expect(checkinSubmitErrors({ [WEIGHT_ID]: 764 })[WEIGHT_ID]).toMatch(/slipped digit/)
    expect(checkinSubmitErrors({ [WEIGHT_ID]: 76.4 })).toEqual({})
  })
})

describe("describeCheckinAnswers", () => {
  it("lists answered questions in question order", () => {
    expect(describeCheckinAnswers({ fu_digestion: ["Bloating", "Gas"], [WEIGHT_ID]: 76.4 })).toEqual([
      { label: "Current weight (kg)", value: "76.4 kg" },
      { label: "Digestive issues", value: "Bloating, Gas" },
    ])
  })
})
