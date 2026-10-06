// Field / row serializations shared by "Save rows as…" (renderer, lib/export-format.ts) and the streaming
// "Export all rows" (main, src/main/export/format.ts), so both menu entries produce the same files.
import type { CellValue, ColumnMeta } from './types'

/** Text of a cell (NULL → nullText). */
export function cellText(value: CellValue, nullText = ''): string {
  if (value === null) return nullText
  return typeof value === 'string' ? value : String(value)
}

/**
 * TSV field as spreadsheets copy it: only fields with tabs or line breaks (or a leading quote, which
 * would otherwise read as a quoted field) are quoted, so JSON and prose paste verbatim.
 */
export function tsvField(text: string): string {
  return /[\t\r\n]/.test(text) || text.startsWith('"') ? `"${text.replaceAll('"', '""')}"` : text
}

/** RFC 4180 field: quoted when it holds the delimiter, a quote, a line break or edge spaces. */
export function csvField(text: string, delimiter = ','): string {
  const special = /["\r\n]|^\s|\s$/.test(text) || (delimiter !== '' && text.includes(delimiter))
  return special ? `"${text.replaceAll('"', '""')}"` : text
}

/** Unique keys for duplicate column names: id, id_2, id_3… */
export function uniqueColumnNames(columns: readonly Pick<ColumnMeta, 'name'>[]): string[] {
  const used = new Set<string>()
  return columns.map((c) => {
    const base = c.name || 'column'
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`
    used.add(name)
    return name
  })
}

export function isJsonType(dataType: string): boolean {
  const t = dataType.trim().toLowerCase()
  return t === 'json' || t === 'jsonb'
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * JSON text of a cell. json / jsonb values are embedded as JSON (the server's text is spliced in, never
 * parsed into JS numbers, so big integers and decimals stay exact); everything else is a JSON value.
 */
export function jsonCell(value: CellValue, embedJson: boolean): string {
  if (embedJson && typeof value === 'string') {
    const text = value.trim()
    if (text !== '' && isValidJson(text)) return text.replace(/\r?\n\s*/g, ' ')
  }
  return JSON.stringify(typeof value === 'number' && !Number.isFinite(value) ? String(value) : value)
}

/**
 * One row as a JSON object, serialized by hand so any column name (including "__proto__") becomes a key.
 * `keys` are uniqueColumnNames(columns); `embedJson[i]` is isJsonType(columns[i].dataType).
 */
export function jsonObject(keys: readonly string[], embedJson: readonly boolean[], row: readonly CellValue[]): string {
  return `{${keys.map((key, i) => `${JSON.stringify(key)}:${jsonCell(row[i] ?? null, embedJson[i] === true)}`).join(',')}}`
}
