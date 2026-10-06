// Find in a grid's loaded rows and client-side value filters (pure helpers of DataGrid).
import type { CellValue } from '@shared/types'
import { valueText } from './cell-format'

/** Text a cell is searched by: what it displays (NULL never matches). */
function searchText(value: CellValue): string | null {
  return value === null ? null : valueText(value)
}

export type CellMatcher = (value: CellValue) => boolean

/** Case-insensitive (unless asked) substring matcher, or null for an empty query. */
export function makeMatcher(query: string, caseSensitive = false): CellMatcher | null {
  if (query === '') return null
  if (caseSensitive) {
    return (value) => {
      const text = searchText(value)
      return text !== null && text.includes(query)
    }
  }
  const q = query.toLocaleLowerCase()
  return (value) => {
    const text = searchText(value)
    return text !== null && text.toLocaleLowerCase().includes(q)
  }
}

export function rowMatches(row: readonly CellValue[] | undefined, columns: number, matcher: CellMatcher): boolean {
  if (!row) return false
  for (let c = 0; c < columns; c++) if (matcher(row[c] ?? null)) return true
  return false
}

/** "Filter by this value" / "Exclude this value" on one column (client-side, loaded rows). */
export interface ValueFilter {
  col: number
  value: CellValue
  exclude: boolean
}

export function sameCellValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b
  return valueText(a) === valueText(b)
}

export function passesFilters(row: readonly CellValue[] | undefined, filters: readonly ValueFilter[]): boolean {
  if (!row) return false
  for (const f of filters) {
    const same = sameCellValue(row[f.col] ?? null, f.value)
    if (same === f.exclude) return false
  }
  return true
}

/**
 * View order after filtering: `base` (a sort order, or null for source order) restricted to the rows
 * that pass the value filters and, with `onlyMatching`, contain a match.
 */
export function filteredOrder(
  rows: readonly CellValue[][],
  base: readonly number[] | null,
  columns: number,
  filters: readonly ValueFilter[],
  matcher: CellMatcher | null,
): number[] {
  const out: number[] = []
  const n = base ? base.length : rows.length
  for (let v = 0; v < n; v++) {
    const src = base ? base[v]! : v
    const row = rows[src]
    if (filters.length > 0 && !passesFilters(row, filters)) continue
    if (matcher && !rowMatches(row, columns, matcher)) continue
    out.push(src)
  }
  return out
}

/** Matches counted at most (the counter then reads "10 000+"). */
export const MATCH_COUNT_CAP = 10_000

export interface MatchPos {
  row: number
  col: number
}

/**
 * Matching cells in view order (row-major), at most `cap`. `columns` lists the source column of each
 * view column; matches report view columns.
 */
export function collectMatches(
  rows: readonly CellValue[][],
  viewCount: number,
  sourceRow: (view: number) => number,
  columns: readonly number[],
  matcher: CellMatcher,
  cap = MATCH_COUNT_CAP,
): { matches: MatchPos[]; capped: boolean } {
  const matches: MatchPos[] = []
  for (let v = 0; v < viewCount; v++) {
    const row = rows[sourceRow(v)]
    if (!row) continue
    for (let c = 0; c < columns.length; c++) {
      if (!matcher(row[columns[c]!] ?? null)) continue
      if (matches.length >= cap) return { matches, capped: true }
      matches.push({ row: v, col: c })
    }
  }
  return { matches, capped: false }
}

function before(a: MatchPos, b: MatchPos): boolean {
  return a.row < b.row || (a.row === b.row && a.col < b.col)
}

/**
 * Index of the next match after `pos` (backwards: the previous one before it), wrapping around.
 * With `inclusive`, a match at `pos` itself is returned.
 */
export function nearestMatch(matches: readonly MatchPos[], pos: MatchPos | null, backwards: boolean, inclusive = false): number {
  if (matches.length === 0) return -1
  if (!pos) return backwards ? matches.length - 1 : 0
  if (inclusive) {
    const at = matches.findIndex((m) => m.row === pos.row && m.col === pos.col)
    if (at >= 0) return at
  }
  if (!backwards) {
    for (let i = 0; i < matches.length; i++) if (before(pos, matches[i]!)) return i
    return 0
  }
  for (let i = matches.length - 1; i >= 0; i--) if (before(matches[i]!, pos)) return i
  return matches.length - 1
}
