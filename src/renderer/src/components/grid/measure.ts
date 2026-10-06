// Column width computation: header label + a sample of rendered values, measured with canvas.
import type { CellValue, ColumnMeta } from '@shared/types'
import { CELL_TEXT_CAP } from './cell-format'
import type { ColumnKind } from './column-types'

export const MIN_COLUMN_WIDTH = 48
export const INITIAL_MIN_WIDTH = 64
export const INITIAL_MAX_WIDTH = 420
export const AUTOFIT_MAX_WIDTH = 900

/** Horizontal padding of a cell (px-2 on both sides), the 1px hairline and sub-pixel slack. */
export const CELL_PADDING = 20
/** Header: padding + sort button + resize affordance. */
const HEADER_EXTRA = 40
/** Primary-key glyph (11px) and its gap in front of the header name. */
const KEY_ICON_WIDTH = 15
/** The "{}" / "<>" badge in front of JSON / XML values: 2 glyphs at 11px mono, px-1, mr-1.5, slack. */
export const STRUCTURED_BADGE_WIDTH = 30

export const CELL_FONT = '12px "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace'
export const HEADER_FONT = '500 12px "Inter Variable", ui-sans-serif, system-ui, -apple-system, sans-serif'
const TYPE_FONT = '11px "Inter Variable", ui-sans-serif, system-ui, -apple-system, sans-serif'

export type MeasureText = (text: string, font: string) => number

let context: CanvasRenderingContext2D | null | undefined

/** Canvas measurement; falls back to a character estimate where canvas is unavailable (tests). */
export const canvasMeasure: MeasureText = (text, font) => {
  if (context === undefined) {
    context = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  }
  if (!context) return text.length * (font.includes('Mono') ? 7.25 : 6.6)
  if (context.font !== font) context.font = font
  return context.measureText(text).width
}

/** Text a cell renders for width purposes (one line, capped). */
function sampleText(value: CellValue, kind: ColumnKind, nullDisplay: string): string {
  if (value === null) return nullDisplay
  if (typeof value === 'boolean') return value ? 'true ' : 'false '
  const text = typeof value === 'string' ? value : String(value)
  const first = text.length > 160 ? text.slice(0, 160) : text
  const line = first.replace(/\r\n|\r|\n/g, ' ↵ ')
  if (kind === 'binary' && line.length > 50) return `${line.slice(0, 50)}… 999 KB`
  return line.length > CELL_TEXT_CAP ? line.slice(0, CELL_TEXT_CAP) : line
}

/** Evenly spread sample of row indices (always includes the first rows). */
export function sampleRows(rowCount: number, size: number): number[] {
  if (rowCount <= size) return Array.from({ length: rowCount }, (_, i) => i)
  const head = Math.min(rowCount, Math.ceil(size / 2))
  const out = Array.from({ length: head }, (_, i) => i)
  const rest = size - head
  const step = (rowCount - head) / rest
  for (let i = 0; i < rest; i++) out.push(head + Math.floor(i * step))
  return out
}

export interface WidthOptions {
  nullDisplay: string
  measure?: MeasureText
  sampleSize?: number
  min?: number
  max?: number
  /** Column indices whose header shows the primary-key glyph. */
  keyColumns?: ReadonlySet<number>
}

export function headerWidth(column: ColumnMeta, measure: MeasureText = canvasMeasure, hasKeyIcon = false): number {
  const name = measure(column.name || ' ', HEADER_FONT) + (hasKeyIcon ? KEY_ICON_WIDTH : 0)
  const type = measure(column.dataType, TYPE_FONT)
  return Math.ceil(Math.max(name, type) + HEADER_EXTRA)
}

/** Width that fits the header and the sampled values of one column. */
export function columnWidth(
  column: ColumnMeta,
  col: number,
  kind: ColumnKind,
  rows: readonly CellValue[][],
  { nullDisplay, measure = canvasMeasure, sampleSize = 120, min = INITIAL_MIN_WIDTH, max = INITIAL_MAX_WIDTH, keyColumns }: WidthOptions,
): number {
  let widest = headerWidth(column, measure, keyColumns?.has(col) ?? false)
  for (const r of sampleRows(rows.length, sampleSize)) {
    const value = rows[r]?.[col] ?? null
    const text = sampleText(value, kind, nullDisplay)
    const badge = (kind === 'json' || kind === 'xml') && typeof value === 'string' && value !== '' ? STRUCTURED_BADGE_WIDTH : 0
    // cheap upper bound first (no glyph is wider than ~12.5px at 12px, CJK included)
    if (text.length * 12.5 + CELL_PADDING + badge <= widest) continue
    const w = measure(text, CELL_FONT) + CELL_PADDING + badge
    if (w > widest) widest = w
    if (widest >= max) break
  }
  return Math.round(Math.min(max, Math.max(min, widest)))
}

export function initialWidths(columns: readonly ColumnMeta[], kinds: readonly ColumnKind[], rows: readonly CellValue[][], options: WidthOptions): number[] {
  return columns.map((c, i) => columnWidth(c, i, kinds[i] ?? 'text', rows, options))
}
