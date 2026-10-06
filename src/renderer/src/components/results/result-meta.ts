// Pure helpers of the results panel: tab labels, table inference, error locations, row counts.
import { classifyStatement } from '@shared/sql'
import type { DbErrorInfo, Dialect, StatementResult } from '@shared/types'
import { formatCount } from '@/lib/format'

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\[(?:[^\]]|\]\])+\]|[A-Za-z_À-￿][\w$#@À-￿]*)`
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`
const CLAUSE_END = String.raw`(?:$|;|\b(?:where|order|group|limit|offset|fetch|having|window|for|option)\b)`
const SIMPLE_FROM = new RegExp(String.raw`^(?:select|table)\b[\s\S]*?\bfrom\s+(${QUALIFIED})(?:\s+(?:as\s+)?${IDENT})?\s*${CLAUSE_END}`, 'i')
const TABLE_STMT = new RegExp(String.raw`^table\s+(?:only\s+)?(${QUALIFIED})\s*(?:$|;)`, 'i')

/** Remove comments and string literal contents so keywords inside them do not count. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim()
}

function unquote(part: string): string {
  const p = part.trim()
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replaceAll('""', '"')
  if (p.startsWith('[') && p.endsWith(']')) return p.slice(1, -1).replaceAll(']]', ']')
  return p
}

function splitQualified(name: string): string[] {
  return (name.match(new RegExp(IDENT, 'g')) ?? []).map(unquote)
}

/**
 * Source table of a result: every column reports the same table, or the statement is a plain
 * single-table SELECT (no join, subquery or set operation). Returns "schema.table" / "table".
 * Drivers may report the bare table name in ColumnMeta.table; when the statement names the same
 * table with its schema ("SELECT * FROM sales.orders"), the qualified name wins so generated SQL
 * (Copy as SQL INSERT, exports) targets the right table whatever the search_path.
 */
export function inferTableName(result: Pick<StatementResult, 'columns' | 'sql'>): string | undefined {
  const tables = new Set(result.columns.map((c) => c.table))
  const fromColumns = result.columns.length > 0 && tables.size === 1 ? [...tables][0] || undefined : undefined
  if (fromColumns?.includes('.')) return fromColumns
  const parsed = tableFromSql(result.sql)
  if (!fromColumns) return parsed
  if (parsed && parsed.includes('.') && sameIdentifier(shortName(parsed), fromColumns)) return parsed
  return fromColumns
}

function sameIdentifier(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase()
}

/** Table of a plain single-table SELECT / TABLE statement, from its text. */
function tableFromSql(text: string): string | undefined {
  const sql = stripNoise(text)
  const table = TABLE_STMT.exec(sql)
  if (table) return splitQualified(table[1]!).join('.')
  if (/\b(join|union|intersect|except)\b/i.test(sql)) return undefined
  if ((sql.match(/\bfrom\b/gi) ?? []).length !== 1) return undefined
  if (/\(\s*select\b/i.test(sql)) return undefined
  // FROM a, b is a cross join
  const fromClause = sql.slice(sql.search(/\bfrom\b/i) + 4).split(/\b(?:where|order|group|limit|offset|fetch|having|window|for|option)\b|;/i)[0] ?? ''
  if (fromClause.includes(',')) return undefined
  const m = SIMPLE_FROM.exec(sql)
  if (!m) return undefined
  return splitQualified(m[1]!).join('.')
}

/** Last part of a qualified name ("public.orders" → "orders"). */
export function shortName(qualified: string): string {
  const parts = qualified.split('.')
  return parts[parts.length - 1] ?? qualified
}

export interface ResultLabel {
  label: string
  title: string
}

export function resultLabel(result: StatementResult, dialect: Dialect | undefined): ResultLabel {
  const n = `Result ${result.index + 1}`
  const preview = result.sql.replace(/\s+/g, ' ').trim().slice(0, 140)
  if (result.kind === 'error') return { label: n, title: `${n} — failed: ${result.error?.message ?? 'error'}\n${preview}` }
  if (result.kind === 'command') {
    const command = result.command || (dialect ? classifyStatement(result.sql, dialect).command : '') || 'Command'
    const label = result.rowCount !== null ? `${command} · ${formatCount(result.rowCount)}` : command
    return { label, title: `${label}\n${preview}` }
  }
  const table = inferTableName(result)
  return { label: table ? shortName(table) : n, title: `${table ? `${table} — ` : ''}${n}\n${preview}` }
}

/** "500 rows", "500+ rows" (more fetchable), "First 500 rows" (truncated at maxRows). */
export function rowCountLabel(result: Pick<StatementResult, 'rows' | 'hasMore' | 'cursorId'>): { text: string; truncated: boolean; more: boolean } {
  const n = result.rows.length
  const count = formatCount(n)
  if (result.hasMore && result.cursorId) return { text: `${count}+ rows`, truncated: false, more: true }
  if (result.hasMore) return { text: `First ${count} rows`, truncated: true, more: false }
  return { text: `${count} ${n === 1 ? 'row' : 'rows'}`, truncated: false, more: false }
}

/** "3 rows affected" / "CREATE TABLE completed". */
export function commandSummary(result: Pick<StatementResult, 'rowCount' | 'command' | 'sql'>, dialect?: Dialect): string {
  if (result.rowCount !== null) return `${formatCount(result.rowCount)} ${result.rowCount === 1 ? 'row' : 'rows'} affected`
  const command = result.command || (dialect ? classifyStatement(result.sql, dialect).command : '') || 'Statement'
  return `${command} completed`
}

export interface ErrorLocation {
  /** Offsets inside the statement text (UTF-16 code units, like String#slice). */
  start: number
  end: number
  /** 1-based line; 1-based column counted in characters (code points). */
  line: number
  column: number
  /** Text of the failing line. */
  lineText: string
  /** Offset of the error inside `lineText` (UTF-16 code units), for drawing the caret. */
  caretOffset: number
}

/**
 * UTF-16 index of the character at code-point index `codePoints` (0-based) of `text`. PostgreSQL
 * reports error positions in characters; JS strings index UTF-16 units, so every astral character
 * (emoji, some CJK) before the position shifts a naive index by one. Clamped to the text length.
 */
export function codePointToIndex(text: string, codePoints: number): number {
  if (codePoints <= 0) return 0
  let index = 0
  let seen = 0
  while (index < text.length && seen < codePoints) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1
    seen++
  }
  return index
}

/** Number of characters (code points) in `text`. */
function codePointLength(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

/** Location of an error inside its statement: PostgreSQL `position` (1-based char) or SQL Server `line`. */
export function errorLocation(sql: string, error: Pick<DbErrorInfo, 'position' | 'line'>): ErrorLocation | null {
  if (error.position !== undefined && error.position > 0) {
    const start = Math.min(codePointToIndex(sql, error.position - 1), Math.max(sql.length - 1, 0))
    const word = /^[\w$#@."]+/.exec(sql.slice(start))
    const end = Math.max(start + 1, start + (word?.[0].length ?? 1))
    const lineStart = sql.lastIndexOf('\n', start - 1) + 1
    const lineEndRaw = sql.indexOf('\n', start)
    const lineEnd = lineEndRaw < 0 ? sql.length : lineEndRaw
    const line = sql.slice(0, lineStart).split('\n').length
    return {
      start,
      end: Math.min(end, Math.max(lineEnd, start + 1)),
      line,
      column: codePointLength(sql.slice(lineStart, start)) + 1,
      lineText: sql.slice(lineStart, lineEnd).replace(/\r$/, ''),
      caretOffset: start - lineStart,
    }
  }
  if (error.line !== undefined && error.line > 0) {
    const lines = sql.split('\n')
    const index = Math.min(error.line, lines.length) - 1
    let lineStart = 0
    for (let i = 0; i < index; i++) lineStart += lines[i]!.length + 1
    const text = (lines[index] ?? '').replace(/\r$/, '')
    const indent = text.length - text.trimStart().length
    const start = lineStart + indent
    const end = Math.max(start + 1, lineStart + text.trimEnd().length)
    return { start, end, line: index + 1, column: codePointLength(text.slice(0, indent)) + 1, lineText: text, caretOffset: indent }
  }
  return null
}

/**
 * Where `sql` (a statement of a past run) now starts in the editor `text`: at the recorded offset
 * when the text there is unchanged, else at the closest copy of the statement. Null when the
 * statement no longer exists in the text (it was edited after the run).
 */
export function locateStatement(text: string, sql: string, expected: number): number | null {
  if (sql === '') return null
  if (expected >= 0 && text.startsWith(sql, expected)) return expected
  let best: number | null = null
  for (let i = text.indexOf(sql); i !== -1; i = text.indexOf(sql, i + 1)) {
    if (best === null || Math.abs(i - expected) < Math.abs(best - expected)) best = i
  }
  return best
}

/** SQL Server reports a numeric severity class ("16"), PostgreSQL a word ("ERROR"). */
export function severityLabel(severity: string): string {
  const t = severity.trim()
  return /^\d+$/.test(t) ? `Severity ${t}` : t
}

/** Plain-text report of an error for "Copy error". */
export function errorReport(error: DbErrorInfo, sql?: string, dialect?: Dialect): string {
  const lines = [error.message]
  if (error.code) lines.push(`${dialect === 'mssql' ? 'Error number' : 'SQLSTATE'}: ${error.code}`)
  if (error.severity) lines.push(`Severity: ${error.severity}`)
  if (error.detail) lines.push(`Detail: ${error.detail}`)
  if (error.hint) lines.push(`Hint: ${error.hint}`)
  if (error.context) lines.push(`Context: ${error.context}`)
  if (sql) {
    const loc = errorLocation(sql, error)
    if (loc) lines.push(`Line ${loc.line}, column ${loc.column}`)
    lines.push('', sql)
  }
  return lines.join('\n')
}

/** The statement failed only because the user cancelled it (shown as a neutral state, not an error). */
export function isCancelledResult(result: Pick<StatementResult, 'kind' | 'error' | 'index'>, execution?: { cancelled: boolean; results: unknown[] }): boolean {
  if (result.kind !== 'error') return false
  if (result.error?.kind === 'cancelled' || result.error?.code === '57014') return true
  return !!execution?.cancelled && result.index === execution.results.length - 1
}
