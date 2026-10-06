// Query parameters / placeholders in console SQL (`:name`, `$1`, `?`, `@name`, `${name}`), found outside
// strings, comments and quoted identifiers, and their substitution by SQL literals before execution.
import type { Dialect } from '@shared/types'
import { sqlLiteral } from '@shared/sql'
import { isSignificant, tokenize, type Token } from '@shared/sql/lexer'

export type ParameterStyle = 'named' | 'positional' | 'question' | 'variable' | 'template'

/** One placeholder occurrence in the SQL text. */
export interface ParameterOccurrence {
  /** Key shared by the occurrences of the same parameter (`:id` twice → one value). */
  key: string
  style: ParameterStyle
  start: number
  end: number
}

/** A distinct parameter, in order of first appearance. */
export interface SqlParameter {
  key: string
  /** How it is spelled in the SQL (`:customer_id`, `$1`, `?` #2, `@tenant`, `${tenant}`). */
  label: string
  style: ParameterStyle
  occurrences: number
}

export interface ParameterScan {
  parameters: SqlParameter[]
  occurrences: ParameterOccurrence[]
}

export type ParameterMode = 'value' | 'sql' | 'null'

export interface ParameterValue {
  /** value: a literal (numbers as-is, anything else quoted); sql: inserted verbatim; null: NULL. */
  mode: ParameterMode
  text: string
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** Words before which `?` is an operand position (… = ?, IN (?), LIMIT ?). */
const OPERAND_KEYWORDS = new Set([
  'SELECT', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'SET', 'VALUES', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'LIMIT', 'OFFSET',
  'TOP', 'WHEN', 'THEN', 'ELSE', 'CASE', 'IS', 'RETURN', 'HAVING', 'BY', 'FETCH', 'ANY', 'ALL', 'SOME', 'EXISTS',
])

const ch = (sql: string, token: Token | undefined): string => (token ? sql.slice(token.start, token.end) : '')

/** A punct token is exactly this character. */
const isChar = (sql: string, token: Token | undefined, c: string): boolean => !!token && token.kind === 'punct' && sql[token.start] === c

/** `?` stands for a value when it follows an operator, '(' / ',' or a keyword — not an expression (jsonb `col ? 'key'`). */
function questionIsParameter(sql: string, prev: Token | undefined): boolean {
  if (!prev) return true
  if (prev.kind === 'punct') {
    const c = sql[prev.start]
    return c !== ')' && c !== ']' && c !== '?'
  }
  if (prev.kind === 'word') return OPERAND_KEYWORDS.has(prev.upper)
  return false
}

/** Words that start the next T-SQL statement (a DECLARE list ends there). */
const STATEMENT_WORDS = new Set(['SELECT', 'SET', 'IF', 'WHILE', 'BEGIN', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXEC', 'EXECUTE', 'PRINT', 'DECLARE', 'RETURN', 'WITH'])

/** Names declared in the batch (DECLARE @x …, table variables, cursor targets): not parameters. */
function declaredVariables(sql: string, tokens: Token[]): Set<string> {
  const declared = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'word' || t.upper !== 'DECLARE') continue
    // DECLARE @a int = 1, @b varchar(10): every @name up to the end of the statement at depth 0
    let depth = 0
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j]!
      if (isChar(sql, u, '(')) depth++
      else if (isChar(sql, u, ')')) depth--
      else if (isChar(sql, u, ';')) break
      else if (u.kind === 'word' && depth === 0) {
        if (u.upper.startsWith('@')) {
          const prev = tokens[j - 1]
          if (prev === t || isChar(sql, prev, ',')) declared.add(u.upper)
        } else if (STATEMENT_WORDS.has(u.upper)) {
          break
        }
      }
    }
  }
  return declared
}

const ROUTINE_DEFINITION = /\b(?:CREATE|ALTER)\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i

/**
 * Find the placeholders of `sql`. Strings, comments, quoted identifiers and dollar-quoted bodies are
 * ignored, as are casts (`::int`), assignments (`:=`), array slices (`a[1:n]`), routine definitions
 * (whose `$1` / `@p` are their own arguments), PREPARE statements and declared T-SQL variables.
 */
export function findParameters(sql: string, dialect: Dialect): ParameterScan {
  const tokens = tokenize(sql, dialect).filter(isSignificant)
  const words = tokens.filter((t) => t.kind === 'word').map((t) => t.upper)
  const definesRoutine = ROUTINE_DEFINITION.test(words.join(' '))
  const prepares = words.includes('PREPARE')
  const declared = dialect === 'mssql' ? declaredVariables(sql, tokens) : new Set<string>()
  const occurrences: ParameterOccurrence[] = []
  let questions = 0

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    // `${name}` (both dialects; the lexer leaves `$` `{` word `}` as separate tokens)
    if (isChar(sql, t, '$') && isChar(sql, next, '{') && next!.start === t.end) {
      const name = tokens[i + 2]
      const close = tokens[i + 3]
      if (name && (name.kind === 'word' || name.kind === 'number') && name.start === next!.end && isChar(sql, close, '}') && close!.start === name.end) {
        const label = ch(sql, name)
        occurrences.push({ key: `\${${label}}`, style: 'template', start: t.start, end: close!.end })
        i += 3
        continue
      }
    }
    // `:name` — not `::type`, not `:=`, not `a[1:n]` / `x:y` glued to the previous token
    if (isChar(sql, t, ':') && next?.kind === 'word' && next.start === t.end && !next.upper.startsWith('@')) {
      const glued = prev && prev.end === t.start && !(prev.kind === 'punct' && '(,=<>+-*/%|'.includes(sql[prev.start]!))
      if (!isChar(sql, prev, ':') && !glued) {
        occurrences.push({ key: `:${ch(sql, next)}`, style: 'named', start: t.start, end: next.end })
        i += 1
        continue
      }
    }
    // `$1` (PostgreSQL)
    if (t.kind === 'param' && dialect === 'postgres' && !definesRoutine && !prepares) {
      occurrences.push({ key: ch(sql, t), style: 'positional', start: t.start, end: t.end })
      continue
    }
    // `?` (JDBC style)
    if (isChar(sql, t, '?')) {
      // jsonb / geometric operators on PostgreSQL: ?| ?& ?- ?# ?-|
      const operator = dialect === 'postgres' && next !== undefined && next.start === t.end && next.kind === 'punct' && '|&-#'.includes(sql[next.start]!)
      if (!operator && questionIsParameter(sql, prev)) {
        questions += 1
        occurrences.push({ key: `?${questions}`, style: 'question', start: t.start, end: t.end })
      }
      continue
    }
    // `@name` (SQL Server) that the batch does not declare
    if (dialect === 'mssql' && t.kind === 'word' && t.upper.startsWith('@') && !t.upper.startsWith('@@') && t.upper.length > 1 && !definesRoutine) {
      if (declared.has(t.upper)) continue
      // EXEC proc @arg = value: `@arg` names the procedure's parameter
      const execStatement = execContext(sql, tokens, i)
      if (execStatement && isChar(sql, next, '=')) continue
      occurrences.push({ key: t.upper, style: 'variable', start: t.start, end: t.end })
    }
  }

  const byKey = new Map<string, SqlParameter>()
  for (const o of occurrences) {
    const existing = byKey.get(o.key)
    if (existing) existing.occurrences += 1
    else byKey.set(o.key, { key: o.key, label: o.style === 'question' ? '?' : sql.slice(o.start, o.end), style: o.style, occurrences: 1 })
  }
  return { parameters: [...byKey.values()], occurrences }
}

/** The statement around token `i` starts with EXEC / EXECUTE (SQL Server). */
function execContext(sql: string, tokens: Token[], i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const t = tokens[k]!
    if (isChar(sql, t, ';')) return false
    if (t.kind === 'word' && (t.upper === 'EXEC' || t.upper === 'EXECUTE')) return true
    if (t.kind === 'word' && ['SELECT', 'SET', 'WHERE', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'IF', 'WHILE', 'RETURN', 'PRINT'].includes(t.upper)) return false
  }
  return false
}

/** SQL text for a parameter value. */
export function renderParameter(value: ParameterValue | undefined, dialect: Dialect): string {
  if (!value || value.mode === 'null') return 'NULL'
  if (value.mode === 'sql') return value.text.trim() || 'NULL'
  const text = value.text
  return NUMBER.test(text.trim()) ? text.trim() : sqlLiteral(text, dialect)
}

/** `sql` with every placeholder replaced by its value. */
export function substituteParameters(sql: string, scan: ParameterScan, values: Record<string, ParameterValue>, dialect: Dialect): string {
  let out = ''
  let cursor = 0
  for (const o of [...scan.occurrences].sort((a, b) => a.start - b.start)) {
    out += sql.slice(cursor, o.start) + renderParameter(values[o.key], dialect)
    cursor = o.end
  }
  return out + sql.slice(cursor)
}
