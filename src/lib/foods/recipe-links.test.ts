import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { parseRecipeCsv } from "./recipe-csv-parser"
import { matchRecipeLinks, parseRecipeLinksCsv, RECIPE_LINK_NAME_OVERRIDES } from "./recipe-links"

function csv(...lines: string[]): string {
  return ["Recipe Name,Recipe Link", ...lines].join("\n") + "\n"
}

describe("parseRecipeLinksCsv", () => {
  it("reads name/URL pairs and skips the header", () => {
    const { links, warnings } = parseRecipeLinksCsv(
      csv("Mango Smoothie,https://fitelo.co/mango-smoothie/", "Aloo Tikki,https://fitelo.co/aloo-patty-recipe/")
    )
    expect(links).toEqual([
      { name: "Mango Smoothie", url: "https://fitelo.co/mango-smoothie/" },
      { name: "Aloo Tikki", url: "https://fitelo.co/aloo-patty-recipe/" },
    ])
    expect(warnings).toEqual([])
  })

  it("keeps a quoted URL containing a comma intact", () => {
    const { links } = parseRecipeLinksCsv(csv('Soyabean Chaat,"https://fitelo.co/soybean-chaat/#:~:text=add%20soya,coriander"'))
    expect(links[0].url).toBe("https://fitelo.co/soybean-chaat/#:~:text=add%20soya,coriander")
  })

  it("skips and reports a row whose link is not a URL", () => {
    const { links, warnings } = parseRecipeLinksCsv(csv("Shorshe Ilish,-", "Mango Smoothie,https://fitelo.co/mango-smoothie/"))
    expect(links).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Shorshe Ilish")
  })

  it("skips and reports a link with no recipe name", () => {
    const { links, warnings } = parseRecipeLinksCsv(csv(",https://fitelo.co/orphan/"))
    expect(links).toEqual([])
    expect(warnings[0]).toContain("no recipe name")
  })

  it("keeps the first of a repeated name and reports only a genuine conflict", () => {
    const agreeing = parseRecipeLinksCsv(csv("Dal,https://fitelo.co/dal/", "Dal,https://fitelo.co/dal/"))
    expect(agreeing.links).toHaveLength(1)
    expect(agreeing.warnings).toEqual([])

    const conflicting = parseRecipeLinksCsv(csv("Dal,https://fitelo.co/dal/", "Dal,https://fitelo.co/dal-tadka/"))
    expect(conflicting.links).toEqual([{ name: "Dal", url: "https://fitelo.co/dal/" }])
    expect(conflicting.warnings[0]).toContain("different URL")
  })
})

describe("matchRecipeLinks", () => {
  const link = (name: string, url: string) => ({ name, url })

  it("matches an exact name", () => {
    const result = matchRecipeLinks(["Mango Smoothie"], [link("Mango Smoothie", "https://fitelo.co/mango-smoothie/")])
    expect(result.urlByRecipeName.get("Mango Smoothie")).toBe("https://fitelo.co/mango-smoothie/")
    expect(result.matchedExact).toBe(1)
    expect(result.unmatchedLinks).toEqual([])
  })

  it("matches across case and punctuation drift between the two sources", () => {
    const result = matchRecipeLinks(
      ["Mac Singh'S Chana Soup", "Aloo Tikki"],
      [link("Mac Singh's Chana Soup", "https://example.test/soup"), link("Aloo tikki", "https://example.test/tikki")]
    )
    expect(result.matchedNormalized).toBe(2)
    expect(result.urlByRecipeName.get("Mac Singh'S Chana Soup")).toBe("https://example.test/soup")
    expect(result.urlByRecipeName.get("Aloo Tikki")).toBe("https://example.test/tikki")
  })

  it("leaves a recipe with no workbook row unlinked rather than approximating one", () => {
    const result = matchRecipeLinks(["Palak Paneer"], [link("Paneer Bhurji", "https://example.test/bhurji")])
    expect(result.urlByRecipeName.size).toBe(0)
    expect(result.unmatchedLinks).toEqual([link("Paneer Bhurji", "https://example.test/bhurji")])
  })

  it("drops a normalized key two workbook rows disagree on, instead of picking one", () => {
    const result = matchRecipeLinks(
      ["Dal Tadka"],
      [link("Dal Tadka", "https://example.test/a"), link("dal-tadka", "https://example.test/b")]
    )
    // The exact tier still resolves; the ambiguous normalized key is reported and never used.
    expect(result.urlByRecipeName.get("Dal Tadka")).toBe("https://example.test/a")
    expect(result.ambiguous).toEqual([{ normalized: "dal tadka", names: ["Dal Tadka", "dal-tadka"] }])
  })

  it("does not resolve a normalized-only name when its key was dropped as ambiguous", () => {
    const result = matchRecipeLinks(
      ["Dal Tadka"],
      [link("Dal  Tadka", "https://example.test/a"), link("dal-tadka", "https://example.test/b")]
    )
    expect(result.urlByRecipeName.size).toBe(0)
    expect(result.ambiguous).toHaveLength(1)
  })

  it("applies an override whose workbook name normalization alone cannot reach", () => {
    const result = matchRecipeLinks(
      ["Fitelo Deep Sleep Chamomile Tea"],
      [link(RECIPE_LINK_NAME_OVERRIDES["Fitelo Deep Sleep Chamomile Tea"].sheetName, "https://fitelo.co/chamomile-tea/")]
    )
    expect(result.urlByRecipeName.get("Fitelo Deep Sleep Chamomile Tea")).toBe("https://fitelo.co/chamomile-tea/")
    expect(result.matchedOverride).toBe(1)
    expect(result.unmatchedLinks).toEqual([])
  })

  it("reports a stale override without suppressing a link the ordinary tiers still find", () => {
    const result = matchRecipeLinks(
      ["Fitelo Deep Sleep Chamomile Tea"],
      [link("Fitelo Deep Sleep Chamomile Tea", "https://fitelo.co/chamomile-tea/")]
    )
    expect(result.unusedOverrides).toEqual(["Fitelo Deep Sleep Chamomile Tea"])
    expect(result.urlByRecipeName.get("Fitelo Deep Sleep Chamomile Tea")).toBe("https://fitelo.co/chamomile-tea/")
    expect(result.matchedExact).toBe(1)
  })
})

/**
 * Guards the two committed files against each other. A workbook re-export
 * that silently stops matching — a renamed column, a changed name
 * convention — would otherwise show up only as recipe links quietly
 * vanishing from generated PDFs.
 */
describe("the committed recipe_links.csv against the committed recipe CSV", () => {
  const seedDir = join(process.cwd(), "src/db/seed-data")
  const parsed = parseRecipeLinksCsv(readFileSync(join(seedDir, "recipe_links.csv"), "utf8"))
  const recipes = parseRecipeCsv(readFileSync(join(seedDir, "recipe_database.csv"), "utf8"))
  const match = matchRecipeLinks(
    recipes.rows.map((r) => r.name),
    parsed.links
  )

  it("parses every committed row without a warning", () => {
    expect(parsed.warnings).toEqual([])
    expect(parsed.links.length).toBeGreaterThan(600)
  })

  it("resolves no ambiguous names", () => {
    expect(match.ambiguous).toEqual([])
  })

  it("carries no stale override", () => {
    expect(match.unusedOverrides).toEqual([])
  })

  it("links more than half the recipe catalogue", () => {
    expect(match.urlByRecipeName.size).toBeGreaterThan(recipes.rows.length / 2)
  })

  it("leaves only the known handful of workbook rows unmatched", () => {
    // Real, reviewed leftovers: a workbook test row, and two dishes whose
    // names differ from anything in the recipe CSV by more than spelling.
    // Kept as an assertion so a re-export that starts dropping real matches
    // fails loudly instead of quietly shedding links.
    expect(match.unmatchedLinks.map((l) => l.name).sort()).toEqual([
      "Thyroid Weight Loss Tea",
      "Weightloss Alkaline Water",
      "test",
    ])
  })
})
