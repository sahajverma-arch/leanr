/**
 * Dev tool: converts the dietitian-maintained "recipe hyperlink" workbook
 * into src/db/seed-data/recipe_links.csv, the committed source of truth the
 * seed reads.
 *
 *   npx tsx scripts/extract-recipe-links.ts "<path to recipe hyperlink.xlsx>"
 *
 * The workbook itself is NOT committed and is never read at seed time — the
 * same discipline recipe_database.csv already establishes: an ingestion
 * pipeline must not depend on a file sitting in someone's Downloads folder.
 * Re-run this whenever the workbook is updated, then re-run
 * `npm run seed:recipes`.
 *
 * .xlsx is a zip of XML, so this reads it directly (stored + deflate
 * entries, which is all Excel emits) rather than adding a spreadsheet
 * dependency for a one-off conversion — the same hand-rolled-parser
 * preference as csv-parser.ts's own quoted-CSV state machine.
 *
 * Never imported by production code.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"

/** Minimal zip reader: central directory -> { path: contents }. */
function readZip(buf: Buffer): Map<string, string> {
  // End-of-central-directory record, scanned backwards past any comment.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("extract-recipe-links: not a zip file (no end-of-central-directory record)")

  const entryCount = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, string>()

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("extract-recipe-links: corrupt central directory entry")
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    // The local header repeats the name/extra with its OWN lengths — the
    // central directory's extra-field length does not apply here.
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) out.set(name, raw.toString("utf8"))
    else if (method === 8) out.set(name, inflateRawSync(raw).toString("utf8"))
    else throw new Error(`extract-recipe-links: unsupported zip compression method ${method} for ${name}`)
  }
  return out
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
}

/** Shared strings, in index order — one <si> can be split across several <t> runs. */
function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = ""
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1]
    out.push(unescapeXml(text))
  }
  return out
}

/** Path of the first worksheet, resolved through the workbook's own relationships. */
function firstSheetPath(files: Map<string, string>): string {
  const workbook = files.get("xl/workbook.xml")
  const rels = files.get("xl/_rels/workbook.xml.rels")
  if (!workbook || !rels) throw new Error("extract-recipe-links: workbook.xml or its relationships are missing")
  const rid = /<sheet[^>]*r:id="([^"]+)"/.exec(workbook)?.[1]
  if (!rid) throw new Error("extract-recipe-links: workbook.xml declares no sheet")
  const target = new RegExp(`<Relationship Id="${rid}"[^>]*Target="([^"]*)"`).exec(rels)?.[1]
  if (!target) throw new Error(`extract-recipe-links: no relationship for sheet ${rid}`)
  return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`
}

interface SheetCell {
  text: string
  /** The cell's real click target, reconstructed from its hyperlink relationship (Target + #location). */
  hyperlink: string | null
}

function readSheet(
  files: Map<string, string>,
  sheetPath: string,
  shared: string[]
): Map<number, Record<string, SheetCell>> {
  const xml = files.get(sheetPath)
  if (!xml) throw new Error(`extract-recipe-links: ${sheetPath} is missing`)
  const relsXml = files.get(sheetPath.replace(/([^/]+)$/, "_rels/$1.rels")) ?? ""

  const relTargets = new Map<string, string>()
  for (const m of relsXml.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]*)"/g)) {
    relTargets.set(m[1], unescapeXml(m[2]))
  }

  // Excel stores a URL fragment separately from the page it hangs off, so a
  // cell's real click target is Target + "#" + location. Dropping the
  // fragment would silently change where a link goes.
  const hyperlinks = new Map<string, string>()
  for (const m of xml.matchAll(/<hyperlink ([^>]*?)\/>/g)) {
    const attrs = m[1]
    const ref = /ref="([^"]+)"/.exec(attrs)?.[1]
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1]
    const location = /location="([^"]*)"/.exec(attrs)?.[1]
    const target = rid ? relTargets.get(rid) : undefined
    if (!ref || !target) continue
    hyperlinks.set(ref, location ? `${target}#${unescapeXml(location)}` : target)
  }

  const rows = new Map<number, Record<string, SheetCell>>()
  // `[^>]*?` is lazy on purpose: a greedy match swallows a self-closing
  // cell's own "/" and then runs on into the NEXT cell's contents.
  for (const m of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, rowNumRaw, attrs, inner = ""] = m
    const rowNum = Number(rowNumRaw)
    const type = /t="([^"]+)"/.exec(attrs)?.[1]
    let text = ""
    if (type === "s") {
      const idx = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      if (idx !== undefined) text = shared[Number(idx)] ?? ""
    } else if (type === "inlineStr") {
      for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1]
      text = unescapeXml(text)
    } else {
      text = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "")
    }
    const cells = rows.get(rowNum) ?? {}
    cells[col] = { text: text.trim(), hyperlink: hyperlinks.get(`${col}${rowNum}`) ?? null }
    rows.set(rowNum, cells)
  }
  return rows
}

/** Escapes one field for the CSV this writes — the same quoting rules csv-parser.ts reads back. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function main() {
  const source = process.argv[2]
  if (!source) {
    console.error('Usage: npx tsx scripts/extract-recipe-links.ts "<path to recipe hyperlink.xlsx>"')
    process.exit(1)
  }

  const files = readZip(readFileSync(source))
  const shared = readSharedStrings(files.get("xl/sharedStrings.xml"))
  const rows = readSheet(files, firstSheetPath(files), shared)

  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0])
  const out: { name: string; url: string }[] = []
  let noPageMarker = 0
  let blankName = 0
  let nonUrl = 0

  for (const [rowNum, cells] of ordered) {
    const name = cells.A?.text ?? ""
    // The header row names its own columns; skip it rather than hardcoding "row 1".
    if (rowNum === 1 && name.toLowerCase() === "name") continue
    const cell = cells.B
    if (!cell) continue
    // The display text carries the full URL including any fragment; the
    // relationship is the fallback for a cell whose text was shortened
    // (e.g. a pasted link with its scheme stripped off).
    const url = /^https?:\/\//i.test(cell.text) ? cell.text : (cell.hyperlink ?? "")
    if (!url) {
      // "-" is the dietitian's own marker for "checked, no recipe page
      // exists" — a real answer rather than a gap, and identical in effect
      // to an absent row, so it is not written out.
      if (cell.text === "-") noPageMarker++
      else if (cell.text) nonUrl++
      continue
    }
    if (!name) {
      blankName++
      continue
    }
    out.push({ name, url })
  }

  const csv = ["Recipe Name,Recipe Link", ...out.map((r) => `${csvField(r.name)},${csvField(r.url)}`)].join("\n") + "\n"
  const dest = join(process.cwd(), "src/db/seed-data/recipe_links.csv")
  writeFileSync(dest, csv)

  console.log(`Read ${ordered.length} sheet rows from ${source}`)
  console.log(`  wrote ${out.length} name -> link rows to ${dest}`)
  console.log(`  skipped ${noPageMarker} rows marked "-" (no recipe page exists)`)
  if (nonUrl) console.log(`  skipped ${nonUrl} rows whose link cell is neither a URL nor "-"`)
  if (blankName) console.log(`  skipped ${blankName} rows carrying a link but no recipe name`)
}

main()
