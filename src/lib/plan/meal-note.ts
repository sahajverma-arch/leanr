/**
 * A dietitian's free-text note on one meal of a plan — "soak the rajma
 * overnight", "add a pinch of hing and jeera tadka", "have with 1 glass of
 * lukewarm water". Printed under that meal's foods on the plan page and in
 * the downloaded PDF.
 *
 * Display text only. Nothing here is ever read by the balancer, a
 * validator, a target or any macro figure, and no model sees it — a note
 * that says "add 1 tsp ghee" does not change the meal's numbers. The note
 * dialog says so, because a dietitian could reasonably expect otherwise.
 */

/** Long enough for a few instructions, short enough that one day still fits on a PDF page. */
export const MEAL_NOTE_MAX_LENGTH = 300

/**
 * The PDF is set in react-pdf's built-in Helvetica, a standard-14 font with
 * WinAnsi (Windows-1252) encoding. It does not error on a character outside
 * that set — it silently prints the wrong glyph (see pdfSafeText in
 * plan-pdf-document.tsx, which found this with "→"). A note is typed for
 * the client to read, so printing Hindi or an emoji as garbage on their PDF
 * is worse than refusing it at save time with a clear message.
 *
 * Allowed: printable ASCII, Latin-1 (U+00A0-U+00FF), the Windows-1252
 * extras in 0x80-0x9F (smart quotes, dashes, ellipsis, bullet, euro...),
 * and newlines.
 */
const WIN_ANSI_EXTRAS = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split("")
)

function isPdfPrintable(ch: string): boolean {
  if (ch === "\n") return true
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x20 && code <= 0x7e) return true
  if (code >= 0xa0 && code <= 0xff) return true
  return WIN_ANSI_EXTRAS.has(ch)
}

/** Common characters people type that the PDF font lacks, with a faithful plain equivalent. */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/→/g, "->"],
  [/←/g, "<-"],
  [/₹/g, "Rs "],
  [/\t/g, " "],
]

export class MealNoteValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MealNoteValidationError"
  }
}

/**
 * Cleans a note as typed and returns what should be stored — or null when
 * the note is empty, which clears it. Throws MealNoteValidationError for a
 * note that is too long or that the PDF cannot print.
 */
export function normalizeMealNote(raw: string): string | null {
  let text = raw.replace(/\r\n?/g, "\n")
  for (const [pattern, replacement] of SUBSTITUTIONS) text = text.replace(pattern, replacement)
  text = text
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trimEnd())
    .join("\n")
    // No more than one blank line in a row — it is a table cell, not a document.
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (text.length === 0) return null

  if (text.length > MEAL_NOTE_MAX_LENGTH) {
    throw new MealNoteValidationError(
      `Keep the note under ${MEAL_NOTE_MAX_LENGTH} characters (it is ${text.length}).`
    )
  }

  const unprintable = [...new Set([...text].filter((ch) => !isPdfPrintable(ch)))]
  if (unprintable.length > 0) {
    throw new MealNoteValidationError(
      `The PDF can't print ${unprintable.map((c) => `"${c}"`).join(", ")}. Please write the note in English letters, without emoji.`
    )
  }

  return text
}
