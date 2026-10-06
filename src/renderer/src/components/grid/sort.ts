// Client-side, type-aware, stable sorting (uncontrolled DataGrid) and the header click cycle.
import type { CellValue, ColumnMeta, Dialect, SortSpec } from '@shared/types'
import { inferColumnKind, type ColumnKind } from './column-types'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Sorts a decimal string by value: sign, integer digits, then fraction. Inputs must be numeric text. */
export function compareDecimalStrings(a: string, b: string): number {
  const pa = parseDecimal(a)
  const pb = parseDecimal(b)
  if (pa.negative !== pb.negative) return pa.negative ? -1 : 1
  const sign = pa.negative ? -1 : 1
  if (pa.int.length !== pb.int.length) return (pa.int.length < pb.int.length ? -1 : 1) * sign
  if (pa.int !== pb.int) return (pa.int < pb.int ? -1 : 1) * sign
  const len = Math.max(pa.frac.length, pb.frac.length)
  const fa = pa.frac.padEnd(len, '0')
  const fb = pb.frac.padEnd(len, '0')
  if (fa === fb) return 0
  return (fa < fb ? -1 : 1) * sign
}

function parseDecimal(text: string): { negative: boolean; int: string; frac: string } {
  let s = text.trim()
  let negative = false
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  const [i = '', f = ''] = s.split('.')
  const int = i.replace(/^0+/, '')
  const frac = f.replace(/0+$/, '')
  // -0 sorts with 0
  if (int === '' && frac === '') negative = false
  return { negative, int, frac }
}

/** Numeric key of a value; NaN for non-numeric text (sorted after every number). */
function numericKey(value: CellValue): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const t = value.trim()
    if (t === '') return Number.NaN
    // money on SQL Server is plain digits; PostgreSQL money carries a currency symbol and separators
    if (/^[-+]?infinity$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
    const cleaned = /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(t) ? t : t.replace(/[^\d.eE+-]/g, '')
    return /\d/.test(cleaned) ? Number(cleaned) : Number.NaN
  }
  return Number.NaN
}

const TYPE_RANK: Record<string, number> = { boolean: 0, number: 1, string: 2 }

// --- temporal keys -------------------------------------------------------------------------------
// The 'date' kind covers dates, times, timestamps and intervals. ISO text in a single UTC offset
// orders correctly by code point, but intervals ('10 days' vs '2 days') and values carrying
// different offsets ('10:00 +05:00' vs '06:00 +00:00') do not: those get a comparable key.

/** PostgreSQL interval arithmetic: a month is 30 days, a year 12 months. */
const SECONDS: Record<string, number> = {
  millennium: 360 * 86400 * 1000,
  century: 360 * 86400 * 100,
  decade: 360 * 86400 * 10,
  year: 360 * 86400,
  mon: 30 * 86400,
  week: 7 * 86400,
  day: 86400,
  hour: 3600,
  min: 60,
  sec: 1,
  millisecond: 1e-3,
  microsecond: 1e-6,
}

function unitSeconds(unit: string): number | undefined {
  const u = unit.toLowerCase()
  if (u.startsWith('millisecond') || u === 'ms' || u === 'msec' || u === 'msecs') return SECONDS.millisecond
  if (u.startsWith('microsecond') || u === 'us' || u === 'usec' || u === 'usecs') return SECONDS.microsecond
  if (u.startsWith('millenni')) return SECONDS.millennium
  if (u.startsWith('centur')) return SECONDS.century
  if (u.startsWith('decade')) return SECONDS.decade
  if (u === 'y' || u.startsWith('year')) return SECONDS.year
  if (u.startsWith('mon')) return SECONDS.mon
  if (u === 'w' || u.startsWith('week')) return SECONDS.week
  if (u === 'd' || u.startsWith('day')) return SECONDS.day
  if (u === 'h' || u.startsWith('hour')) return SECONDS.hour
  if (u === 'm' || u.startsWith('min')) return SECONDS.min
  if (u === 's' || u.startsWith('sec')) return SECONDS.sec
  return undefined
}

const ISO_INTERVAL = /^(-)?P(?:(-?\d+(?:\.\d+)?)Y)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)W)?(?:(-?\d+(?:\.\d+)?)D)?(?:T(?:(-?\d+(?:\.\d+)?)H)?(?:(-?\d+(?:\.\d+)?)M)?(?:(-?\d+(?:\.\d+)?)S)?)?$/i
const INTERVAL_PART = /\s*(?:([-+]?)(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?|([-+]?\d+(?:\.\d+)?)\s*([a-z]+))/iy

/** Seconds of an interval ('1 year 2 mons 3 days 04:05:06', '@ 3 days ago', 'P1Y2M'), or null. */
export function intervalSeconds(text: string): number | null {
  let t = text.trim()
  if (t === '') return null
  const iso = ISO_INTERVAL.exec(t)
  if (iso && t.length > 1 && !/^-?PT?$/i.test(t)) {
    const f = (i: number) => (iso[i] ? Number(iso[i]) : 0)
    const total =
      f(2) * SECONDS.year! + f(3) * SECONDS.mon! + f(4) * SECONDS.week! + f(5) * SECONDS.day! + f(6) * 3600 + f(7) * 60 + f(8)
    return iso[1] ? -total : total
  }
  let sign = 1
  if (t.startsWith('@')) t = t.slice(1).trim()
  if (/\s+ago$/i.test(t)) {
    sign = -1
    t = t.replace(/\s+ago$/i, '')
  }
  INTERVAL_PART.lastIndex = 0
  let total = 0
  let parts = 0
  let pos = 0
  while (pos < t.length) {
    INTERVAL_PART.lastIndex = pos
    const m = INTERVAL_PART.exec(t)
    if (!m) return null
    if (m[2] !== undefined) {
      const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60 + (m[4] ? Number(m[4]) : 0)
      total += m[1] === '-' ? -seconds : seconds
    } else {
      const unit = unitSeconds(m[6]!)
      if (unit === undefined) return null
      total += Number(m[5]) * unit
    }
    parts++
    pos = INTERVAL_PART.lastIndex
    while (pos < t.length && /[\s,]/.test(t[pos]!)) pos++
  }
  return parts > 0 ? total * sign : null
}

const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})$/i
/** Seconds from 0001-01-01 to 1970-01-01, so instant keys are never negative. */
const EPOCH_SHIFT = 62135596800

/** Sortable UTC key of a timestamp that carries an offset ('2024-01-01 10:00:00 +05:00'), or null. */
export function instantKey(text: string): string | null {
  const m = OFFSET_TIMESTAMP.exec(text.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, sec = '0', frac = '', zone = 'Z'] = m
  let offset = 0
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replaceAll(':', '')
    offset = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || '0') * 60 + Number(digits.slice(4, 6) || '0')
    if (zone.startsWith('-')) offset = -offset
  }
  const date = new Date(0)
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d))
  date.setUTCHours(Number(h), Number(mi), Number(sec), 0)
  const seconds = Math.floor(date.getTime() / 1000) - offset + EPOCH_SHIFT
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return `${String(seconds).padStart(13, '0')}.${frac.padEnd(9, '0').slice(0, 9)}`
}

/** Comparable key of a 'date'-kind value: seconds for intervals, a UTC key for offset timestamps. */
export function temporalKey(value: CellValue): number | string | null {
  if (typeof value !== 'string') return null
  return instantKey(value) ?? intervalSeconds(value)
}

function compareTemporalKeys(a: number | string | null, b: number | string | null): number | null {
  if (a === null || b === null || typeof a !== typeof b) return null
  return a === b ? 0 : a < b ? -1 : 1
}

/** Ascending comparison of two non-null values of a column. */
export function compareValues(a: Exclude<CellValue, null>, b: Exclude<CellValue, null>, kind: ColumnKind): number {
  if (kind === 'date') {
    const c = compareTemporalKeys(temporalKey(a), temporalKey(b))
    if (c !== null) return c
  }
  return compareBase(a, b, kind)
}

/** compareValues without the temporal keys (callers that precomputed them). */
function compareBase(a: Exclude<CellValue, null>, b: Exclude<CellValue, null>, kind: ColumnKind): number {
  if (kind === 'number') {
    const na = numericKey(a)
    const nb = numericKey(b)
    const aNaN = Number.isNaN(na)
    const bNaN = Number.isNaN(nb)
    if (aNaN || bNaN) {
      if (aNaN && bNaN) return collator.compare(String(a), String(b))
      return aNaN ? 1 : -1
    }
    if (na !== nb) return na < nb ? -1 : 1
    // equal as doubles: settle exactly for long string-encoded numerics
    if (typeof a === 'string' && typeof b === 'string' && a !== b && NUMERIC.test(a) && NUMERIC.test(b)) {
      return compareDecimalStrings(a, b)
    }
    return 0
  }
  if (typeof a !== typeof b) return (TYPE_RANK[typeof a] ?? 3) - (TYPE_RANK[typeof b] ?? 3)
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const sa = String(a)
  const sb = String(b)
  // Dates, uuids and hex compare by code point (ISO text orders chronologically); text by locale.
  if (kind === 'date' || kind === 'uuid' || kind === 'binary') return sa === sb ? 0 : sa < sb ? -1 : 1
  return collator.compare(sa, sb)
}

const NUMERIC = /^[-+]?\d+(\.\d*)?$/

export interface SortKey {
  col: number
  direction: 'asc' | 'desc'
  kind: ColumnKind
}

/**
 * View order for `rows` under `keys` (source indices). NULLs always sort last; ties keep source
 * order (stable). Returns null when there is nothing to sort.
 */
export function sortedOrder(rows: readonly CellValue[][], keys: readonly SortKey[]): number[] | null {
  if (keys.length === 0) return null
  // Numeric and temporal keys are parsed once per row rather than on every comparison.
  const prepared = keys.map((key) => {
    let nums: Float64Array | null = null
    let temporal: (number | string | null)[] | null = null
    if (key.kind === 'number') {
      nums = new Float64Array(rows.length)
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i]![key.col] ?? null
        nums[i] = v === null ? Number.NaN : numericKey(v)
      }
    } else if (key.kind === 'date') {
      temporal = new Array<number | string | null>(rows.length)
      for (let i = 0; i < rows.length; i++) temporal[i] = temporalKey(rows[i]![key.col] ?? null)
    }
    return { ...key, nums, temporal, sign: key.direction === 'asc' ? 1 : -1 }
  })
  const order = Array.from({ length: rows.length }, (_, i) => i)
  order.sort((ia, ib) => {
    for (const key of prepared) {
      const a = rows[ia]![key.col] ?? null
      const b = rows[ib]![key.col] ?? null
      if (a === null || b === null) {
        if (a === b) continue
        return a === null ? 1 : -1
      }
      let c: number
      if (key.nums) {
        const na = key.nums[ia]!
        const nb = key.nums[ib]!
        c = !Number.isNaN(na) && !Number.isNaN(nb) && na !== nb ? (na < nb ? -1 : 1) : compareBase(a, b, key.kind)
      } else if (key.temporal) {
        c = compareTemporalKeys(key.temporal[ia]!, key.temporal[ib]!) ?? compareBase(a, b, key.kind)
      } else {
        c = compareBase(a, b, key.kind)
      }
      if (c !== 0) return c * key.sign
    }
    return ia - ib
  })
  return order
}

/**
 * Header click: cycles the column asc → desc → none. Without `multi` the column becomes the only
 * sort; with `multi` (shift) it is added / cycled in place, keeping the other columns.
 */
export function nextSort(current: readonly SortSpec[], column: string, multi: boolean): SortSpec[] {
  const existing = current.find((s) => s.column === column)
  const next: SortSpec | null = !existing
    ? { column, direction: 'asc' }
    : existing.direction === 'asc'
      ? { column, direction: 'desc' }
      : null
  if (!multi) return next ? [next] : []
  if (!existing) return [...current, next!]
  return next ? current.map((s) => (s.column === column ? next : s)) : current.filter((s) => s.column !== column)
}

/** Explicitly set (or clear) a column's direction from a menu. */
export function setSort(current: readonly SortSpec[], column: string, direction: 'asc' | 'desc' | null, multi = false): SortSpec[] {
  if (!multi) return direction ? [{ column, direction }] : current.filter((s) => s.column !== column)
  if (!direction) return current.filter((s) => s.column !== column)
  return current.some((s) => s.column === column)
    ? current.map((s) => (s.column === column ? { column, direction } : s))
    : [...current, { column, direction }]
}

/**
 * The rows in the order the uncontrolled / client-sorted DataGrid shows them for `sort` (same
 * column kinds, same comparison), e.g. for exporting what is on screen.
 */
export function sortRowsForView(
  columns: readonly ColumnMeta[],
  rows: readonly CellValue[][],
  sort: readonly SortSpec[],
  dialect?: Dialect,
): CellValue[][] {
  const keys: SortKey[] = sort.flatMap((s) => {
    const col = columns.findIndex((c) => c.name === s.column)
    return col >= 0 ? [{ col, direction: s.direction, kind: inferColumnKind(columns[col]!, rows, col, dialect) }] : []
  })
  const order = sortedOrder(rows, keys)
  return order ? order.map((i) => rows[i]!) : [...rows]
}
