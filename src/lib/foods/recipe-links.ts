/**
 * Maps each ingested recipe to the public Fitelo recipe page a client can
 * open from their downloaded plan PDF.
 *
 * Source: src/db/seed-data/recipe_links.csv, a committed export of the
 * dietitian-maintained "recipe hyperlink" workbook (see
 * scripts/extract-recipe-links.ts). The workbook itself is never read at
 * seed time — same discipline recipe_database.csv already establishes.
 *
 * This layer carries NO nutrition meaning whatsoever. A link is
 * presentation metadata: it never reaches the balancer, the validator, a
 * target, or any macro figure, and a recipe with no link is displayed
 * exactly as it is today. Only 666 of the workbook's rows carry a URL at
 * all, and the workbook explicitly marks 145 more with "-" ("checked, no
 * recipe page exists"), so an unlinked recipe is the normal case, not a
 * failure.
 *
 * Matching is deliberately shallow — exact, then case/punctuation-
 * insensitive, then a small hand-audited override table — and never fuzzy.
 * recipe-grounding.ts can afford a Levenshtein tier because a wrong
 * resolution there still produces a real, verified recipe row; a wrong
 * resolution HERE would print a link to the wrong dish on a clinical
 * document, which is worse than printing no link at all. Anything that
 * does not match is reported by the seed, never guessed at.
 */

import { parseCsvRows } from "./csv-parser"

export interface RecipeLink {
  /** The recipe name exactly as the workbook spells it. */
  name: string
  url: string
}

export interface ParsedRecipeLinks {
  links: RecipeLink[]
  /** Rows dropped at parse time, with the reason — printed by seed-recipes.ts, never silently swallowed. */
  warnings: string[]
}

/**
 * Hand-audited corrections, keyed by the RECIPE name, valued with the exact
 * workbook name whose link it should take. Same shape and spirit as
 * recipe-curation-overrides.ts: a small, explicit, reasoned table rather
 * than a blanket rule loose enough to mislabel something.
 *
 * Every entry here is a case where the workbook and the recipe CSV name the
 * same dish differently in a way normalization alone cannot close. Nothing
 * here invents a link: the URL still comes from the workbook row named
 * below.
 */
export const RECIPE_LINK_NAME_OVERRIDES: Record<string, { sheetName: string; reason: string }> = {
  "Fitelo Deep Sleep Chamomile Tea": {
    sheetName: "Fitelo Deep Sleep Chamomile Tea or any other chamomile tea (caffeine free)",
    reason:
      "Same dish; the workbook name appends a substitution note ('or any other chamomile tea') that is guidance for the dietitian, not part of the dish name.",
  },
}

/**
 * Case-, punctuation- and spacing-insensitive form of a dish name. The
 * recipe CSV is title-cased at the source ("Mac Singh'S Chana Soup",
 * "Aloo Tikki") while the workbook is typed by hand ("Mac Singh's Chana
 * Soup", "Aloo tikki") — six real recipes differ from their workbook row by
 * nothing but that.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function parseRecipeLinksCsv(text: string): ParsedRecipeLinks {
  const rows = parseCsvRows(text)
  const warnings: string[] = []
  const links: RecipeLink[] = []
  const seen = new Map<string, string>()

  for (const [index, row] of rows.entries()) {
    // The header row names its own columns.
    if (index === 0 && row[0]?.trim().toLowerCase() === "recipe name") continue
    const name = (row[0] ?? "").trim()
    const url = (row[1] ?? "").trim()
    if (!name && !url) continue

    if (!name) {
      warnings.push(`row ${index + 1}: link "${url}" has no recipe name — skipped.`)
      continue
    }
    if (!/^https?:\/\//i.test(url)) {
      warnings.push(`row ${index + 1}: "${name}" has no usable URL (${url || "empty"}) — skipped.`)
      continue
    }

    const previous = seen.get(name)
    if (previous !== undefined) {
      // Two rows naming the same dish is harmless when they agree; when
      // they disagree there is no way to tell which page is current, so the
      // first is kept and the conflict is reported rather than guessed at.
      if (previous !== url) warnings.push(`row ${index + 1}: "${name}" repeats with a different URL (kept ${previous}, ignored ${url}).`)
      continue
    }
    seen.set(name, url)
    links.push({ name, url })
  }

  return { links, warnings }
}

export interface RecipeLinkMatch {
  /** Recipe name -> URL. A recipe absent from this map simply has no link. */
  urlByRecipeName: Map<string, string>
  /** Workbook rows that matched no ingested recipe — a real signal that a name drifted, printed by the seed. */
  unmatchedLinks: RecipeLink[]
  /** Workbook names that collapse onto the same normalized key with DIFFERENT URLs; dropped rather than guessed at. */
  ambiguous: { normalized: string; names: string[] }[]
  /** Override entries whose named workbook row does not exist — a stale override, surfaced rather than ignored. */
  unusedOverrides: string[]
  matchedExact: number
  matchedNormalized: number
  matchedOverride: number
}

/**
 * Resolves every ingested recipe name against the workbook's links. Pure —
 * no I/O — so the whole matching policy is unit-testable without a CSV or a
 * database.
 */
export function matchRecipeLinks(recipeNames: string[], links: RecipeLink[]): RecipeLinkMatch {
  const byExactName = new Map<string, RecipeLink>()
  for (const link of links) if (!byExactName.has(link.name)) byExactName.set(link.name, link)

  // Build the normalized index, dropping any key two differently-spelled
  // workbook rows disagree on — the same "an ambiguous alias is dropped
  // entirely, never guessed" rule recipe-alias-generation.ts already uses.
  const normalizedCandidates = new Map<string, RecipeLink[]>()
  for (const link of links) {
    const key = normalizeName(link.name)
    if (!key) continue
    const list = normalizedCandidates.get(key) ?? []
    list.push(link)
    normalizedCandidates.set(key, list)
  }
  const byNormalizedName = new Map<string, RecipeLink>()
  const ambiguous: { normalized: string; names: string[] }[] = []
  for (const [key, candidates] of normalizedCandidates) {
    const urls = new Set(candidates.map((c) => c.url))
    if (urls.size > 1) {
      ambiguous.push({ normalized: key, names: candidates.map((c) => c.name) })
      continue
    }
    byNormalizedName.set(key, candidates[0])
  }

  const urlByRecipeName = new Map<string, string>()
  const used = new Set<RecipeLink>()
  const unusedOverrides: string[] = []
  let matchedExact = 0
  let matchedNormalized = 0
  let matchedOverride = 0

  for (const recipeName of recipeNames) {
    const override = RECIPE_LINK_NAME_OVERRIDES[recipeName]
    if (override) {
      const link = byExactName.get(override.sheetName)
      if (link) {
        urlByRecipeName.set(recipeName, link.url)
        used.add(link)
        matchedOverride++
        continue
      }
      unusedOverrides.push(recipeName)
      // Fall through: an override naming a row that no longer exists must
      // not also suppress a link the ordinary tiers can still find.
    }

    const exact = byExactName.get(recipeName)
    if (exact) {
      urlByRecipeName.set(recipeName, exact.url)
      used.add(exact)
      matchedExact++
      continue
    }

    const normalized = byNormalizedName.get(normalizeName(recipeName))
    if (normalized) {
      urlByRecipeName.set(recipeName, normalized.url)
      used.add(normalized)
      matchedNormalized++
    }
  }

  return {
    urlByRecipeName,
    unmatchedLinks: links.filter((link) => !used.has(link)),
    ambiguous,
    unusedOverrides,
    matchedExact,
    matchedNormalized,
    matchedOverride,
  }
}
