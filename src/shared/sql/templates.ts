// Script templates for explorer context menus (DataGrip-style "SQL scripts" actions).
// Placeholders are valid SQL: NULL (or DEFAULT when the column has one) followed by a comment with the
// column name and type, so the script runs as-is and is easy to fill in.

import type { ColumnInfo, Dialect } from '../types'
import { qualifiedName, quoteIdent } from './quote'

const INDENT = '    '
/** Above this many columns, lists are written one item per line. */
const INLINE_MAX = 3

/** Comment text that cannot close (or, in nested-comment dialects, open) a block comment. */
function commentText(text: string): string {
  return text.replaceAll('*/', '* /').replaceAll('/*', '/ *')
}

function placeholder(column: ColumnInfo, withName: boolean, allowDefault: boolean): string {
  const value = allowDefault && column.defaultValue !== null ? 'DEFAULT' : 'NULL'
  const label = withName ? `${column.name} ${column.dataType}` : column.dataType
  return `${value} /* ${commentText(label)} */`
}

function list(items: string[]): string {
  return items.length > INLINE_MAX ? `\n${items.map((i) => INDENT + i).join(',\n')}\n` : items.join(', ')
}

function condition(columns: ColumnInfo[], dialect: Dialect): string {
  return columns
    .map((c, i) => `${i === 0 ? 'WHERE' : '  AND'} ${quoteIdent(c.name, dialect)} = ${placeholder(c, false, false)}`)
    .join('\n')
}

function keyColumns(columns: ColumnInfo[]): ColumnInfo[] {
  const pk = columns.filter((c) => c.isPrimaryKey)
  return pk.length > 0 ? pk : columns
}

function sorted(columns: ColumnInfo[]): ColumnInfo[] {
  return [...columns].sort((a, b) => a.ordinal - b.ordinal)
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : undefined
}

export function generateSelect(schema: string, table: string, columns: string[], dialect: Dialect, limit?: number): string {
  const n = normalizeLimit(limit)
  const names = columns.map((c) => quoteIdent(c, dialect))
  const top = dialect === 'mssql' && n !== undefined ? ` TOP (${n})` : ''
  let select: string
  if (names.length === 0) select = `SELECT${top} *`
  else if (names.length > INLINE_MAX) select = `SELECT${top}\n${names.map((c) => INDENT + c).join(',\n')}`
  else select = `SELECT${top} ${names.join(', ')}`
  const lines = [select, `FROM ${qualifiedName(schema, table, dialect)}`]
  if (dialect === 'postgres' && n !== undefined) lines.push(`LIMIT ${n}`)
  return `${lines.join('\n')};`
}

export function generateInsert(schema: string, table: string, columns: ColumnInfo[], dialect: Dialect): string {
  const target = qualifiedName(schema, table, dialect)
  const insertable = sorted(columns).filter((c) => !c.isIdentity && !c.isGenerated)
  if (insertable.length === 0) return `INSERT INTO ${target} DEFAULT VALUES;`
  const names = insertable.map((c) => quoteIdent(c.name, dialect))
  const values = insertable.map((c) => placeholder(c, true, true))
  return `INSERT INTO ${target} (${list(names)})\nVALUES (${list(values)});`
}

export function generateUpdate(schema: string, table: string, columns: ColumnInfo[], dialect: Dialect): string {
  const target = qualifiedName(schema, table, dialect)
  const ordered = sorted(columns)
  if (ordered.length === 0) return `-- ${target} has no columns to update`
  const writable = ordered.filter((c) => !c.isGenerated && !c.isIdentity)
  const nonKey = writable.filter((c) => !c.isPrimaryKey)
  const assigned = nonKey.length > 0 ? nonKey : writable.length > 0 ? writable : ordered
  const set = assigned
    .map((c, i) => `${i === 0 ? 'SET ' : INDENT}${quoteIdent(c.name, dialect)} = ${placeholder(c, false, false)}`)
    .join(',\n')
  return `UPDATE ${target}\n${set}\n${condition(keyColumns(ordered), dialect)};`
}

export function generateDelete(schema: string, table: string, columns: ColumnInfo[], dialect: Dialect): string {
  const target = qualifiedName(schema, table, dialect)
  const ordered = sorted(columns)
  if (ordered.length === 0) return `DELETE FROM ${target}\nWHERE ${dialect === 'mssql' ? '1 = 0' : 'FALSE'};`
  return `DELETE FROM ${target}\n${condition(keyColumns(ordered), dialect)};`
}
