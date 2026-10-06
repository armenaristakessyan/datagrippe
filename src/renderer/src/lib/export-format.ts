// Text serializations of grid data for the clipboard and "Save as…": TSV, CSV, JSON, Markdown,
// SQL INSERT and SQL IN lists. Pure functions; values are CellValue (see @shared/types).
import { qualifiedName, quoteIdent, sqlLiteral } from '@shared/sql'
import { cellText, csvField, tsvField, uniqueColumnNames as sharedUniqueColumnNames } from '@shared/export-format'
import type { CellValue, ColumnMeta, Dialect, ExportFormat } from '@shared/types'
import { columnKind, isNumericText } from '@/components/grid/column-types'
import { reindentJson } from '@/components/grid/json-text'

type Columns = readonly Pick<ColumnMeta, 'name' | 'dataType'>[]
type Rows = readonly (readonly CellValue[])[]

export interface TextExportOptions {
  /** Include the column names as the first line (default true). */
  header?: boolean
  /** Text written for NULL (default empty). */
  nullText?: string
}

const plain = (value: CellValue, nullText: string): string => cellText(value, nullText)

/**
 * Tab-separated values as spreadsheets copy them: only fields with tabs or line breaks (or a leading
 * quote, which would otherwise read as a quoted field) are quoted, so JSON and prose paste verbatim.
 * Field rules are shared with main's streaming "Export all rows" (@shared/export-format).
 */
export function toTSV(columns: Columns, rows: Rows, { header = true, nullText = '' }: TextExportOptions = {}): string {
  const lines: string[] = []
  if (header) lines.push(columns.map((c) => tsvField(c.name)).join('\t'))
  for (const row of rows) lines.push(columns.map((_, i) => tsvField(plain(row[i] ?? null, nullText))).join('\t'))
  return lines.join('\n')
}

/** RFC 4180: CRLF line breaks; fields with the delimiter, quotes, line breaks or edge spaces are quoted. */
export function toCSV(columns: Columns, rows: Rows, { header = true, nullText = '', delimiter = ',' }: TextExportOptions & { delimiter?: string } = {}): string {
  const field = (text: string) => csvField(text, delimiter)
  const lines: string[] = []
  if (header) lines.push(columns.map((c) => field(c.name)).join(delimiter))
  for (const row of rows) lines.push(columns.map((_, i) => field(plain(row[i] ?? null, nullText))).join(delimiter))
  return lines.length === 0 ? '' : lines.join('\r\n') + '\r\n'
}

/** Unique keys for duplicate column names: id, id_2, id_3… */
export function uniqueColumnNames(columns: Columns): string[] {
  return sharedUniqueColumnNames(columns)
}

/**
 * Array of objects keyed by column name. Numbers, booleans and null are kept; string-encoded
 * numerics stay strings (no precision loss); json / jsonb values are embedded as JSON. The embedded
 * documents are spliced in as text (re-indented, never parsed into JS numbers), so integers above
 * 2^53 and decimal text inside them are kept exactly. `indent` 0 gives compact output.
 */
export function toJSON(columns: Columns, rows: Rows, { indent = 2 }: { indent?: number } = {}): string {
  const names = uniqueColumnNames(columns)
  const json = columns.map((c) => columnKind(c.dataType) === 'json')
  const keys = names.map((name) => JSON.stringify(name))
  const unit = ' '.repeat(Math.max(0, Math.min(10, Math.floor(indent))))
  const pretty = unit !== ''
  const colon = pretty ? ': ' : ':'
  const entrySep = pretty ? `,\n${unit}${unit}` : ','
  const rowSep = pretty ? `,\n${unit}` : ','
  const value = (v: CellValue, i: number): string => {
    if (json[i] && typeof v === 'string') {
      const embedded = reindentJson(v.trim(), unit, 2)
      if (embedded !== null) return embedded
      // not valid JSON text: keep the string
    }
    return JSON.stringify(typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)
  }
  const objects = rows.map((row) => {
    if (names.length === 0) return '{}'
    const entries = names.map((_, i) => `${keys[i]}${colon}${value(row[i] ?? null, i)}`).join(entrySep)
    return pretty ? `{\n${unit}${unit}${entries}\n${unit}}` : `{${entries}}`
  })
  if (objects.length === 0) return '[]'
  return pretty ? `[\n${unit}${objects.join(rowSep)}\n]` : `[${objects.join(rowSep)}]`
}

/** GitHub-flavoured table. Pipes are escaped, line breaks become <br>, numeric columns right-aligned. */
export function toMarkdown(columns: Columns, rows: Rows, { nullText = 'NULL' }: { nullText?: string } = {}): string {
  const esc = (text: string) => text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, '<br>')
  const cell = (text: string) => (text === '' ? ' ' : esc(text))
  const numeric = columns.map((c) => columnKind(c.dataType) === 'number')
  const lines = [
    `| ${columns.map((c) => cell(c.name)).join(' | ')} |`,
    `| ${columns.map((_, i) => (numeric[i] ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((_, i) => cell(plain(row[i] ?? null, nullText))).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** INSERT target: "orders" / "public.orders" / already-quoted names are kept as typed. */
export function insertTarget(tableName: string | undefined, dialect: Dialect): string {
  const raw = tableName?.trim() || 'table_name'
  if (/["[\]`]/.test(raw)) return raw
  const parts = raw.split('.').filter((p) => p !== '')
  if (parts.length === 2) return qualifiedName(parts[0]!, parts[1]!, dialect)
  return parts.map((p) => quoteIdent(p, dialect)).join('.')
}

/** SQL literal of a cell, using the column type for numerics and SQL Server binary. */
export function columnLiteral(value: CellValue, dataType: string, dialect: Dialect): string {
  if (typeof value === 'string') {
    const kind = columnKind(dataType, dialect)
    if (kind === 'number' && isNumericText(value)) return value.trim()
    if (kind === 'binary' && dialect === 'mssql' && /^0x[0-9a-f]*$/i.test(value)) return value
    if (kind === 'binary' && dialect === 'postgres' && /^\\x[0-9a-f]*$/i.test(value)) return `'${value}'::bytea`
  }
  return sqlLiteral(value, dialect)
}

/** SQL Server accepts at most 1000 row value expressions per INSERT … VALUES. */
export const MSSQL_MAX_VALUES_ROWS = 1000

/**
 * Multi-row INSERT statements, `chunkSize` rows per statement (default 100; SQL Server is capped at
 * 1000). Each statement ends with ";" and a blank line separates chunks.
 */
export function toSqlInsert(tableName: string | undefined, columns: Columns, rows: Rows, dialect: Dialect, { chunkSize = 100 }: { chunkSize?: number } = {}): string {
  if (rows.length === 0) return ''
  const size = Math.max(1, dialect === 'mssql' ? Math.min(chunkSize, MSSQL_MAX_VALUES_ROWS) : chunkSize)
  const target = insertTarget(tableName, dialect)
  const cols = columns.map((c) => quoteIdent(c.name, dialect)).join(', ')
  const tuple = (row: readonly CellValue[]) => `(${columns.map((c, i) => columnLiteral(row[i] ?? null, c.dataType, dialect)).join(', ')})`
  const statements: string[] = []
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    statements.push(`INSERT INTO ${target} (${cols}) VALUES\n  ${chunk.map(tuple).join(',\n  ')};`)
  }
  return statements.join('\n\n') + '\n'
}

/** "(1, 2, 3)" — distinct values of one column as an IN list, in first-seen order. */
export function toSqlInList(values: readonly CellValue[], dialect: Dialect, dataType = ''): string {
  const seen = new Set<string>()
  const literals: string[] = []
  for (const v of values) {
    const lit = columnLiteral(v, dataType, dialect)
    if (seen.has(lit)) continue
    seen.add(lit)
    literals.push(lit)
  }
  return `(${literals.join(', ')})`
}

export interface FormatOptions {
  tableName?: string
  dialect?: Dialect
  header?: boolean
  nullText?: string
  /** JSON indentation (default 2; 0 = compact). */
  jsonIndent?: number
}

/** One entry point for "Copy as…" and "Save as…". */
export function formatRows(format: ExportFormat, columns: Columns, rows: Rows, options: FormatOptions = {}): string {
  switch (format) {
    case 'tsv':
      return toTSV(columns, rows, { header: options.header, nullText: options.nullText })
    case 'csv':
      return toCSV(columns, rows, { header: options.header, nullText: options.nullText })
    case 'json':
      return toJSON(columns, rows, { indent: options.jsonIndent })
    case 'markdown':
      return toMarkdown(columns, rows)
    case 'sql':
      return toSqlInsert(options.tableName, columns, rows, options.dialect ?? 'postgres')
  }
}

export const EXPORT_FORMAT_META: Record<ExportFormat, { label: string; extension: string; filterName: string }> = {
  csv: { label: 'CSV', extension: 'csv', filterName: 'CSV' },
  tsv: { label: 'TSV', extension: 'tsv', filterName: 'TSV' },
  json: { label: 'JSON', extension: 'json', filterName: 'JSON' },
  sql: { label: 'SQL INSERT', extension: 'sql', filterName: 'SQL' },
  markdown: { label: 'Markdown', extension: 'md', filterName: 'Markdown' },
}
