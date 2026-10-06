// Streaming CSV / TSV reader (RFC 4180): quoted fields with "" escapes and embedded line breaks, CRLF / LF /
// CR line endings, any one-character delimiter. Fields are text; an unquoted field equal to `nullText` is
// NULL, a quoted one never is (so "" stays an empty string).
import type { CsvParseOptions } from '@shared/types'

export type CsvRecord = (string | null)[]

export const DEFAULT_CSV_OPTIONS: Required<CsvParseOptions> = { delimiter: ',', header: true, nullText: '', skipLines: 0 }

/** Normalized options: one-character delimiter, defaults filled in. */
export function csvOptions(options: CsvParseOptions = {}): Required<CsvParseOptions> {
  const delimiter = options.delimiter === '\\t' ? '\t' : (options.delimiter ?? DEFAULT_CSV_OPTIONS.delimiter)
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new Error('The delimiter must be a single character other than a quote or a line break.')
  }
  return {
    delimiter,
    header: options.header ?? DEFAULT_CSV_OPTIONS.header,
    nullText: options.nullText ?? DEFAULT_CSV_OPTIONS.nullText,
    skipLines: Math.max(0, Math.floor(options.skipLines ?? 0)),
  }
}

export class CsvParser {
  private readonly delimiter: string
  private readonly nullText: string
  private field = ''
  /** The current field started with a quote. */
  private quoted = false
  /** Inside a quoted field. */
  private inQuotes = false
  /** Just read a quote inside a quoted field: either an escaped quote ("") or the closing quote. */
  private quotePending = false
  /** Previous chunk ended with CR: a leading LF in the next chunk belongs to the same line break. */
  private pendingCr = false
  private record: CsvRecord = []
  /** Something (text, a quote, a delimiter) was read on the current line. */
  private lineHasContent = false
  private skip: number

  constructor(options: CsvParseOptions = {}) {
    const o = csvOptions(options)
    this.delimiter = o.delimiter
    this.nullText = o.nullText
    this.skip = o.skipLines
  }

  private endField(): void {
    this.record.push(!this.quoted && this.field === this.nullText ? null : this.field)
    this.field = ''
    this.quoted = false
  }

  private endLine(out: CsvRecord[]): void {
    if (this.skip > 0) {
      this.skip--
    } else if (this.lineHasContent) {
      this.endField()
      out.push(this.record)
    }
    // Blank lines are not records.
    this.record = []
    this.field = ''
    this.quoted = false
    this.lineHasContent = false
  }

  /** Parse a chunk of text; returns the records completed by it. */
  feed(chunk: string): CsvRecord[] {
    const out: CsvRecord[] = []
    const d = this.delimiter
    const n = chunk.length
    let i = 0
    if (this.pendingCr) {
      this.pendingCr = false
      if (chunk.startsWith('\n')) i = 1
    }
    while (i < n) {
      const ch = chunk[i]
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false
          if (ch === '"') {
            this.field += '"'
            i++
            continue
          }
          // The quote closed the field: `ch` is read below as text after it.
          this.inQuotes = false
        } else if (ch === '"') {
          this.quotePending = true
          i++
          continue
        } else {
          let j = chunk.indexOf('"', i)
          if (j === -1) j = n
          this.field += chunk.slice(i, j)
          i = j
          continue
        }
      }
      if (ch === '"' && this.field === '' && !this.quoted) {
        this.inQuotes = true
        this.quoted = true
        this.lineHasContent = true
        i++
        continue
      }
      if (ch === d) {
        this.endField()
        this.lineHasContent = true
        i++
        continue
      }
      if (ch === '\r' || ch === '\n') {
        this.endLine(out)
        if (ch === '\r') {
          if (i + 1 < n) {
            if (chunk[i + 1] === '\n') i++
          } else {
            this.pendingCr = true
          }
        }
        i++
        continue
      }
      this.field += ch
      this.lineHasContent = true
      i++
    }
    return out
  }

  /** Flush the last record (file without a trailing line break). */
  end(): CsvRecord[] {
    if (this.quotePending) {
      this.quotePending = false
      this.inQuotes = false
    }
    if (this.inQuotes) throw new Error('The file ends inside a quoted field (a closing quote is missing).')
    const out: CsvRecord[] = []
    if (this.lineHasContent) this.endLine(out)
    return out
  }
}

/** Parse a whole string (tests, previews). */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvRecord[] {
  const parser = new CsvParser(options)
  return [...parser.feed(text), ...parser.end()]
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|']

/** Count delimiter occurrences per line (outside quotes) over the first lines of a sample. */
function delimiterCounts(sample: string, delimiter: string, maxLines = 20): number[] {
  const counts: number[] = []
  let count = 0
  let inQuotes = false
  for (let i = 0; i < sample.length && counts.length < maxLines; i++) {
    const ch = sample[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch === delimiter) count++
    else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && sample[i + 1] === '\n') i++
      counts.push(count)
      count = 0
    }
  }
  if (count > 0) counts.push(count)
  return counts
}

/** Pick the delimiter that appears the same (non-zero) number of times on the most lines. */
export function detectDelimiter(sample: string): string {
  let best = ','
  let bestScore = 0
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = delimiterCounts(sample, d).filter((_, i, all) => i < all.length - 1 || all.length === 1)
    if (counts.length === 0 || counts[0] === 0) continue
    const consistent = counts.filter((c) => c === counts[0]).length
    const score = consistent * 1000 + counts[0]
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** Strip a UTF-8 BOM. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
