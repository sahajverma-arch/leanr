import { describe, expect, it } from "vitest"

import { extractJson } from "./llm-json"

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"days":[]}')).toEqual({ days: [] })
  })

  it("parses an object wrapped in a markdown code fence", () => {
    expect(extractJson('```json\n{"days":[{"dayIndex":0}]}\n```')).toEqual({ days: [{ dayIndex: 0 }] })
  })

  it("parses an object with prose before and after it", () => {
    expect(extractJson('Here is the week:\n{"a":{"b":1}}\nLet me know if you want changes.')).toEqual({ a: { b: 1 } })
  })

  it("throws when the reply has no JSON object", () => {
    expect(() => extractJson("I could not build a plan.")).toThrow("No JSON object found")
  })

  it("throws when the braces are the wrong way round", () => {
    expect(() => extractJson("} nothing {")).toThrow("No JSON object found")
  })

  it("throws when the object is cut off", () => {
    expect(() => extractJson('{"days":[{"dayIndex":0}')).toThrow()
  })
})
