// Lightweight, error-tolerant analysis of the statement under the caret for autocompletion and hover:
// which statement the caret is in, which relations (tables, aliases, CTEs, derived tables) are in
// scope, and what kind of token is expected at the caret. Pure: no Monaco, no stores.
import type { Dialect } from '@shared/types'
import { splitStatementsFine } from '@shared/sql'
import { MSSQL_RESERVED, POSTGRES_RESERVED } from '@shared/sql/keywords'
import { isSignificant, tokenize, type Token } from '@shared/sql/lexer'

export interface Tok extends Token {
  /** Raw source text of the token. */
  text: string
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type NameTok = Tok & { kind: 'word' | 'quoted-ident' }

export function isName(t: Tok | undefined): t is NameTok {
  return !!t && (t.kind === 'word' || t.kind === 'quoted-ident')
}

export function isPunctTok(t: Tok | undefined, ch: string): boolean {
  return !!t && t.kind === 'punct' && t.text === ch
}

/** Identifier value: quotes removed and doubled quotes unescaped. */
export function nameValue(t: Tok): string {
  if (t.kind !== 'quoted-ident') return t.text
  const open = t.text[0]
  const close = open === '[' ? ']' : '"'
  const closed = t.text.length >= 2 && t.text.endsWith(close)
  const inner = t.text.slice(1, closed ? -1 : undefined)
  return inner.replaceAll(close + close, close)
}

function lex(text: string, dialect: Dialect, base: number): Tok[] {
  return tokenize(text, dialect).map((t) => ({ ...t, start: t.start + base, end: t.end + base, text: text.slice(t.start, t.end) }))
}

// ---------------------------------------------------------------------------
// Statement region
// ---------------------------------------------------------------------------

export interface Region {
  start: number
  end: number
}

/** True when the gap between two statements contains a statement boundary (';', GO, blank line on mssql). */
function hasBoundary(gap: string, dialect: Dialect): boolean {
  const tokens = tokenize(gap, dialect)
  for (const t of tokens) {
    const text = gap.slice(t.start, t.end)
    if (t.kind === 'punct' && text === ';') return true
    if (dialect === 'mssql') {
      if (t.kind === 'word' && t.upper === 'GO') return true
      if (t.kind === 'whitespace' && /\n[ \t\r\f\v]*\n/.test(text)) return true
    }
  }
  return false
}

/**
 * The statement around `offset`: the statement containing it, else the statement it extends (typing at
 * the end of "SELECT * FROM t WHERE "), else the statement starting right after it, else an empty region.
 */
export function statementRegion(text: string, offset: number, dialect: Dialect): Region {
  let units: { start: number; end: number }[]
  try {
    units = splitStatementsFine(text, dialect)
  } catch {
    return { start: 0, end: text.length }
  }
  let previous: { start: number; end: number } | undefined
  let next: { start: number; end: number } | undefined
  for (const u of units) {
    if (u.start <= offset && offset <= u.end) return { start: u.start, end: u.end }
    if (u.end < offset) previous = u
    else if (u.start > offset && !next) next = u
  }
  if (previous && !hasBoundary(text.slice(previous.end, offset), dialect)) {
    // The caret extends `previous`; the statement may continue after the caret up to the next unit.
    const end = next && !hasBoundary(text.slice(offset, next.start), dialect) ? next.end : offset
    return { start: previous.start, end }
  }
  if (next && !hasBoundary(text.slice(offset, next.start), dialect)) return { start: offset, end: next.end }
  return { start: offset, end: offset }
}

// ---------------------------------------------------------------------------
// Scope: relations referenced by the statement
// ---------------------------------------------------------------------------

export interface RelationRef {
  kind: 'table' | 'cte' | 'derived' | 'function'
  schema?: string
  name: string
  alias?: string
  /** Column names known from the statement itself (CTEs, derived tables, column alias lists). */
  columns?: string[]
  /** Offsets of the relation's name (or derived table) in the source. */
  start: number
  end: number
  /** Bounds of the parenthesised query the reference belongs to; it is visible inside these bounds. */
  scopeStart: number
  scopeEnd: number
}

export interface Scope {
  relations: RelationRef[]
  ctes: RelationRef[]
}

/** Words that end a relation reference (never taken as an alias). */
const ALIAS_STOP = new Set([
  'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING', 'GROUP', 'ORDER',
  'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'SET', 'VALUES', 'RETURNING',
  'SELECT', 'FROM', 'INTO', 'WITH', 'AS', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE', 'END', 'CASE', 'LATERAL',
  'TABLESAMPLE', 'OUTPUT', 'OPTION', 'APPLY', 'PIVOT', 'UNPIVOT', 'DEFAULT', 'DO', 'GO', 'ONLY', 'OVERRIDING', 'QUALIFY',
  'MERGE', 'MATCHED', 'UPDATE', 'DELETE', 'INSERT', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'TOP', 'ADD', 'DROP', 'ALTER',
  'RENAME', 'OWNER', 'CONFLICT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'IF', 'WHILE', 'PRINT', 'DECLARE', 'EXEC', 'EXECUTE',
])

/** Keywords after which a relation name is expected. */
export const RELATION_INTRO = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'APPLY', 'TRUNCATE'])

interface Cursor {
  tokens: Tok[]
  /** Index of the matching close paren for each open paren (and vice versa). */
  match: Map<number, number>
}

function matchParens(tokens: Tok[]): Map<number, number> {
  const match = new Map<number, number>()
  const stack: number[] = []
  tokens.forEach((t, i) => {
    if (isPunctTok(t, '(')) stack.push(i)
    else if (isPunctTok(t, ')')) {
      const open = stack.pop()
      if (open !== undefined) {
        match.set(open, i)
        match.set(i, open)
      }
    }
  })
  return match
}

/** Index just after the group opened at `open` (or the end when unbalanced). */
function skipGroup(c: Cursor, open: number): number {
  const close = c.match.get(open)
  return close === undefined ? c.tokens.length : close + 1
}

/** Parse `name(.name)*` at `i`; returns the parts and the index after the chain. */
function parseChain(tokens: Tok[], i: number): { parts: Tok[]; next: number } {
  const parts: Tok[] = []
  let j = i
  while (isName(tokens[j]) && !(tokens[j]!.kind === 'word' && ALIAS_STOP.has(tokens[j]!.upper))) {
    parts.push(tokens[j]!)
    if (isPunctTok(tokens[j + 1], '.') && isName(tokens[j + 2])) j += 2
    else {
      j += 1
      break
    }
  }
  return { parts, next: j }
}

/** Optional `[AS] alias [(col, …)]` at `i`. */
function parseAlias(c: Cursor, i: number): { alias?: string; columns?: string[]; next: number } {
  let j = i
  const t = c.tokens[j]
  if (t?.kind === 'word' && t.upper === 'AS') j++
  const a = c.tokens[j]
  if (!isName(a) || (a.kind === 'word' && ALIAS_STOP.has(a.upper))) return { next: i }
  j++
  let columns: string[] | undefined
  if (isPunctTok(c.tokens[j], '(')) {
    const end = skipGroup(c, j)
    columns = c.tokens.slice(j + 1, end - 1).filter(isName).map(nameValue)
    j = end
  }
  return { alias: nameValue(a), columns, next: j }
}

/** Output column names of a SELECT (best effort): explicit aliases, bare / qualified column names, function names. */
export function selectListColumns(tokens: Tok[], dialect: Dialect): string[] {
  let depth = 0
  let i = tokens.findIndex((t) => t.kind === 'word' && t.upper === 'SELECT')
  if (i < 0) return []
  i++
  // modifiers
  for (;;) {
    const t = tokens[i]
    if (t?.kind === 'word' && (t.upper === 'DISTINCT' || t.upper === 'ALL')) {
      i++
      if (isPunctTok(tokens[i], '(') || (tokens[i]?.kind === 'word' && tokens[i]!.upper === 'ON')) {
        if (tokens[i]?.upper === 'ON') i++
        if (isPunctTok(tokens[i], '(')) {
          let d = 0
          for (; i < tokens.length; i++) {
            if (isPunctTok(tokens[i], '(')) d++
            else if (isPunctTok(tokens[i], ')') && --d === 0) {
              i++
              break
            }
          }
        }
      }
      continue
    }
    if (dialect === 'mssql' && t?.kind === 'word' && t.upper === 'TOP') {
      i++
      if (isPunctTok(tokens[i], '(')) {
        while (i < tokens.length && !isPunctTok(tokens[i], ')')) i++
      }
      i++
      if (tokens[i]?.upper === 'PERCENT') i++
      if (tokens[i]?.upper === 'WITH' && tokens[i + 1]?.upper === 'TIES') i += 2
      continue
    }
    break
  }
  const END = new Set(['FROM', 'INTO', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'LIMIT', 'WINDOW', 'OFFSET', 'FETCH'])
  const items: Tok[][] = [[]]
  for (; i < tokens.length; i++) {
    const t = tokens[i]!
    if (isPunctTok(t, '(')) depth++
    else if (isPunctTok(t, ')')) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && t.kind === 'word' && END.has(t.upper)) break
    else if (depth === 0 && isPunctTok(t, ',')) {
      items.push([])
      continue
    }
    items[items.length - 1]!.push(t)
  }
  const names: string[] = []
  for (const item of items) {
    const name = itemName(item)
    if (name) names.push(name)
  }
  return names
}

function itemName(item: Tok[]): string | undefined {
  if (item.length === 0) return undefined
  const last = item[item.length - 1]!
  const prev = item[item.length - 2]
  if (isName(last) && prev?.kind === 'word' && prev.upper === 'AS') return nameValue(last)
  // T-SQL `alias = expression`
  if (item.length > 2 && isName(item[0]) && isPunctTok(item[1], '=')) return nameValue(item[0]!)
  if (isName(last)) {
    if (item.length === 1) return nameValue(last)
    if (isPunctTok(prev, '.')) return nameValue(last)
    // implicit alias after an expression: `count(*) total`, `price p`
    if (prev && (isPunctTok(prev, ')') || isName(prev) || prev.kind === 'number' || prev.kind === 'string')) return nameValue(last)
    return undefined
  }
  // `fn(...)` without alias → PostgreSQL names the column after the function
  if (isName(item[0]) && isPunctTok(item[1], '(') && isPunctTok(last, ')')) return nameValue(item[0]!)
  return undefined
}

/** Relations of a statement. `tokens` are the significant tokens of the statement. */
export function parseScope(tokens: Tok[], dialect: Dialect, region: Region): Scope {
  const c: Cursor = { tokens, match: matchParens(tokens) }
  const relations: RelationRef[] = []
  const ctes: RelationRef[] = []

  const enclosing = (index: number): { start: number; end: number } => {
    // innermost open paren before `index` whose group contains it
    let depth = 0
    for (let k = index - 1; k >= 0; k--) {
      const t = tokens[k]!
      if (isPunctTok(t, ')')) depth++
      else if (isPunctTok(t, '(')) {
        if (depth === 0) {
          const close = c.match.get(k)
          return { start: t.end, end: close === undefined ? region.end : tokens[close]!.start }
        }
        depth--
      }
    }
    return { start: region.start, end: region.end }
  }

  // WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] ( body ) [, …]
  const withIndex = tokens.findIndex((t) => t.kind === 'word' && t.upper === 'WITH')
  if (withIndex >= 0 && (withIndex === 0 || isPunctTok(tokens[withIndex - 1], ';'))) {
    let i = withIndex + 1
    if (tokens[i]?.upper === 'RECURSIVE') i++
    while (isName(tokens[i])) {
      const nameTok = tokens[i]!
      i++
      let columns: string[] | undefined
      if (isPunctTok(tokens[i], '(')) {
        const end = skipGroup(c, i)
        columns = tokens.slice(i + 1, end - 1).filter(isName).map(nameValue)
        i = end
      }
      if (tokens[i]?.upper !== 'AS') break
      i++
      if (tokens[i]?.upper === 'NOT') i++
      if (tokens[i]?.upper === 'MATERIALIZED') i++
      if (!isPunctTok(tokens[i], '(')) break
      const end = skipGroup(c, i)
      const body = tokens.slice(i + 1, end - 1)
      ctes.push({
        kind: 'cte',
        name: nameValue(nameTok),
        columns: columns ?? selectListColumns(body, dialect),
        start: nameTok.start,
        end: nameTok.end,
        scopeStart: region.start,
        scopeEnd: region.end,
      })
      i = end
      if (!isPunctTok(tokens[i], ',')) break
      i++
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'word' || !RELATION_INTRO.has(t.upper)) continue
    // `TABLE` only introduces a relation in DDL / TRUNCATE TABLE / LOCK TABLE, not in `RETURNS TABLE (…)`.
    if (t.upper === 'TABLE' && isPunctTok(tokens[i + 1], '(')) continue
    const intro = t.upper
    const scope = enclosing(i)
    let j = i + 1
    for (;;) {
      while (tokens[j]?.kind === 'word' && (tokens[j]!.upper === 'ONLY' || tokens[j]!.upper === 'LATERAL' || tokens[j]!.upper === 'IF' || tokens[j]!.upper === 'EXISTS' || tokens[j]!.upper === 'NOT')) j++
      const head = tokens[j]
      if (isPunctTok(head, '(')) {
        const end = skipGroup(c, j)
        const inner = tokens.slice(j + 1, end - 1)
        const isQuery = inner[0]?.kind === 'word' && ['SELECT', 'WITH', 'VALUES'].includes(inner[0].upper)
        const alias = parseAlias(c, end)
        if (alias.alias) {
          relations.push({
            kind: 'derived',
            name: alias.alias,
            alias: alias.alias,
            columns: alias.columns ?? (isQuery ? selectListColumns(inner, dialect) : []),
            start: head!.start,
            end: tokens[end - 1]?.end ?? head!.end,
            scopeStart: scope.start,
            scopeEnd: scope.end,
          })
        }
        j = alias.next
      } else if (isName(head) && !(head.kind === 'word' && ALIAS_STOP.has(head.upper))) {
        const chain = parseChain(tokens, j)
        j = chain.next
        let kind: RelationRef['kind'] = 'table'
        if (isPunctTok(tokens[j], '(')) {
          // INTO t (col, …) is a column list; FROM fn(…) / APPLY fn(…) is a table function
          if (intro !== 'INTO' && intro !== 'TABLE') kind = 'function'
          j = skipGroup(c, j)
        }
        const parts = chain.parts.map(nameValue)
        const name = parts[parts.length - 1]!
        const schema = parts.length >= 2 ? parts[parts.length - 2] : undefined
        const alias = intro === 'TABLE' || intro === 'TRUNCATE' ? { next: j } : parseAlias(c, j)
        const last = chain.parts[chain.parts.length - 1]!
        relations.push({
          kind,
          name,
          schema,
          alias: alias.alias,
          columns: alias.columns,
          start: chain.parts[0]!.start,
          end: last.end,
          scopeStart: scope.start,
          scopeEnd: scope.end,
        })
        j = alias.next
      } else {
        break
      }
      // FROM a, b, c — comma-separated relation lists
      if ((intro === 'FROM' || intro === 'TRUNCATE') && isPunctTok(tokens[j], ',')) {
        j++
        continue
      }
      break
    }
    // Keep scanning from the next token: nested queries (derived tables, function arguments) have their
    // own FROM clauses, parsed with their own scope.
  }

  // A FROM reference to a CTE is a CTE, not a catalog table.
  for (const r of relations) {
    if (r.kind === 'table' && !r.schema) {
      const cte = ctes.find((x) => x.name.toLowerCase() === r.name.toLowerCase())
      if (cte) {
        r.kind = 'cte'
        r.columns = r.columns ?? cte.columns
      }
    }
  }
  return { relations, ctes }
}

/** Relations visible at `offset`, innermost scope first. */
export function visibleRelations(scope: Scope, offset: number): RelationRef[] {
  return scope.relations
    .filter((r) => r.scopeStart <= offset && offset <= r.scopeEnd)
    .sort((a, b) => a.scopeEnd - a.scopeStart - (b.scopeEnd - b.scopeStart))
}

/** The name that qualifies a relation's columns (`alias`, else the relation name). */
export function relationLabel(r: RelationRef): string {
  return r.alias ?? r.name
}

// ---------------------------------------------------------------------------
// Caret context
// ---------------------------------------------------------------------------

export type CaretContext =
  /** Inside a string or a comment: nothing to suggest. */
  | { kind: 'none' }
  /** A table / view name is expected (FROM, JOIN, INTO, UPDATE…), optionally after `schema.`. */
  | { kind: 'relation'; qualifier: string[] }
  /** A routine name is expected (EXEC, CALL). */
  | { kind: 'routine'; qualifier: string[] }
  /** `qualifier.` in an expression: columns of an alias / table, or objects of a schema. */
  | { kind: 'qualified'; qualifier: string[] }
  /** An expression is expected: columns of the relations in scope, functions, keywords. */
  | { kind: 'columns' }
  /** Column list of INSERT INTO t (…). */
  | { kind: 'insert-columns'; schema?: string; name: string }
  /** A data type is expected (after `::`, CAST(… AS). */
  | { kind: 'type' }
  /** A keyword is expected: at statement start, after an expression, or after another keyword. */
  | { kind: 'keyword'; after: 'start' | 'expression' | 'keyword' }

export interface CaretAnalysis {
  context: CaretContext
  /** Text typed so far for the current word (quotes included). */
  prefix: string
  /** The current word is a quoted identifier. */
  quoted: boolean
  /** Replace range of the current word. */
  from: number
  to: number
  region: Region
  scope: Scope
  /** Significant tokens of the statement. */
  tokens: Tok[]
}

const COLUMN_CLAUSE = new Set([
  'SELECT', 'WHERE', 'ON', 'BY', 'HAVING', 'SET', 'AND', 'OR', 'NOT', 'WHEN', 'THEN', 'ELSE', 'CASE', 'DISTINCT',
  'RETURNING', 'LIKE', 'ILIKE', 'BETWEEN', 'ALL', 'ANY', 'SOME', 'OUTPUT', 'RETURN', 'PRINT', 'IF', 'WHILE', 'ELSEIF',
])

const ROUTINE_INTRO = new Set(['EXEC', 'EXECUTE', 'CALL'])

const PG_EXTRA_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE', 'EXPLAIN', 'VACUUM', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SET',
  'SHOW', 'VALUES', 'BY', 'IF', 'EXISTS', 'REPLACE', 'INDEX', 'VIEW', 'SCHEMA', 'DATABASE', 'FUNCTION', 'PROCEDURE',
  'TRIGGER', 'SEQUENCE', 'TYPE', 'EXTENSION', 'MATERIALIZED', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'RECURSIVE', 'ADD',
  'RENAME', 'CASCADE', 'RESTRICT', 'GRANT', 'REVOKE', 'COPY', 'NULLS', 'FIRST', 'LAST', 'CONFLICT', 'NOTHING', 'OVER',
  'PARTITION', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'ROW',
])

/** A word that is (almost certainly) a keyword here rather than an identifier. */
export function isReservedWord(upper: string, dialect: Dialect): boolean {
  if (dialect === 'postgres') return POSTGRES_RESERVED.has(upper.toLowerCase()) || PG_EXTRA_KEYWORDS.has(upper)
  return MSSQL_RESERVED.has(upper)
}

const TYPE_CAST_FUNCTIONS = new Set(['CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT'])

function insideComment(t: Tok, offset: number, regionEnd: number): boolean {
  if (t.kind === 'line-comment') return offset > t.start && offset <= t.end
  if (t.kind === 'block-comment') {
    if (offset <= t.start) return false
    if (offset < t.end) return true
    // unterminated block comment running to the end of the text
    return offset === t.end && t.end === regionEnd && !t.text.endsWith('*/')
  }
  if (t.kind === 'string') {
    if (offset <= t.start) return false
    if (offset < t.end) return true
    return offset === t.end && t.end === regionEnd && !stringClosed(t.text)
  }
  return false
}

/** Whether a string token is terminated ('…', E'…', N'…', $tag$…$tag$). */
function stringClosed(text: string): boolean {
  if (text.startsWith('$')) {
    const tag = text.slice(0, text.indexOf('$', 1) + 1)
    return tag.length > 0 && text.length >= tag.length * 2 && text.endsWith(tag)
  }
  const open = text.indexOf("'")
  const backslash = open === 1 && (text[0] === 'E' || text[0] === 'e')
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]
    if (backslash && ch === '\\') {
      i++
      continue
    }
    if (ch === "'") {
      if (text[i + 1] === "'") {
        i++
        continue
      }
      return i === text.length - 1
    }
  }
  return false
}

/** Index of the innermost unclosed '(' among `before`, or -1. */
function openParenIndex(before: Tok[]): number {
  let depth = 0
  for (let k = before.length - 1; k >= 0; k--) {
    const t = before[k]!
    if (isPunctTok(t, ')')) depth++
    else if (isPunctTok(t, '(')) {
      if (depth === 0) return k
      depth--
    }
  }
  return -1
}

/** Nearest keyword in the same parenthesis group before index `k`, skipping nested groups. */
function governingKeyword(before: Tok[], k: number, dialect: Dialect): Tok | undefined {
  let depth = 0
  for (let i = k; i >= 0; i--) {
    const t = before[i]!
    if (isPunctTok(t, ')')) depth++
    else if (isPunctTok(t, '(')) {
      if (depth === 0) return undefined
      depth--
    } else if (depth === 0 && t.kind === 'word' && (isReservedWord(t.upper, dialect) || COLUMN_CLAUSE.has(t.upper) || RELATION_INTRO.has(t.upper))) {
      return t
    }
  }
  return undefined
}

/** Name chain ending at index `end` (inclusive) in `before`: returns the parts and the index before the chain. */
function chainBefore(before: Tok[], end: number): { parts: string[]; index: number } {
  const parts: string[] = []
  let k = end
  while (isName(before[k])) {
    parts.unshift(nameValue(before[k]!))
    if (isPunctTok(before[k - 1], '.')) k -= 2
    else {
      k -= 1
      break
    }
  }
  return { parts, index: k }
}

function contextAfterOpenParen(before: Tok[], k: number, dialect: Dialect): CaretContext {
  const prev = before[k - 1]
  if (!prev) return { kind: 'keyword', after: 'start' }
  if (prev.kind === 'word') {
    const up = prev.upper
    if (up === 'FROM' || up === 'JOIN' || up === 'AS' || up === 'APPLY' || up === 'LATERAL') return { kind: 'keyword', after: 'start' }
    if (up === 'OVER') return { kind: 'keyword', after: 'keyword' }
    if (up === 'VALUES' || up === 'IN' || up === 'EXISTS' || up === 'ANY' || up === 'ALL') return { kind: 'columns' }
  }
  if (isName(prev)) {
    const chain = chainBefore(before, k - 1)
    const intro = before[chain.index]
    if (intro?.kind === 'word' && intro.upper === 'INTO' && chain.parts.length > 0) {
      const name = chain.parts[chain.parts.length - 1]!
      return { kind: 'insert-columns', name, schema: chain.parts.length >= 2 ? chain.parts[chain.parts.length - 2] : undefined }
    }
    if (intro?.kind === 'word' && intro.upper === 'TABLE') return { kind: 'keyword', after: 'expression' }
    // function call arguments
    return { kind: 'columns' }
  }
  if (isPunctTok(prev, '(') || isPunctTok(prev, ',')) {
    // `((`, `IN (SELECT …), (` – a nested expression or subquery
    return contextAfterOpenParen(before, k - 1, dialect)
  }
  return { kind: 'columns' }
}

function contextFromPrevious(before: Tok[], dialect: Dialect): CaretContext {
  const k = before.length - 1
  const p = before[k]
  if (!p) return { kind: 'keyword', after: 'start' }

  // qualifier chain: `a.`, `schema.table.`
  if (isPunctTok(p, '.') && isName(before[k - 1])) {
    const chain = chainBefore(before, k - 1)
    const intro = before[chain.index]
    if (intro?.kind === 'word' && RELATION_INTRO.has(intro.upper)) return { kind: 'relation', qualifier: chain.parts }
    if (intro?.kind === 'word' && ROUTINE_INTRO.has(intro.upper)) return { kind: 'routine', qualifier: chain.parts }
    if (isPunctTok(intro, ',')) {
      const gov = governingKeyword(before, chain.index - 1, dialect)
      if (gov?.upper === 'FROM') return { kind: 'relation', qualifier: chain.parts }
    }
    return { kind: 'qualified', qualifier: chain.parts }
  }

  if (dialect === 'postgres' && isPunctTok(p, ':') && isPunctTok(before[k - 1], ':')) return { kind: 'type' }

  if (p.kind === 'word') {
    const up = p.upper
    if (RELATION_INTRO.has(up)) {
      // FROM inside EXTRACT(… FROM x), SUBSTRING(x FROM 1), TRIM(… FROM x) is not a relation list
      if (up === 'FROM') {
        const open = openParenIndex(before)
        if (open >= 0) {
          const opener = before[open - 1]
          const queryInside = before.slice(open + 1, k).some((t) => t.kind === 'word' && (t.upper === 'SELECT' || t.upper === 'DELETE'))
          if (!queryInside && isName(opener) && !(opener.kind === 'word' && ['IN', 'EXISTS', 'FROM', 'JOIN', 'AS', 'APPLY', 'LATERAL'].includes(opener.upper))) {
            return { kind: 'columns' }
          }
        }
      }
      return { kind: 'relation', qualifier: [] }
    }
    if (ROUTINE_INTRO.has(up)) return { kind: 'routine', qualifier: [] }
    if (up === 'AS') {
      const open = openParenIndex(before)
      const opener = open >= 0 ? before[open - 1] : undefined
      if (opener?.kind === 'word' && TYPE_CAST_FUNCTIONS.has(opener.upper)) return { kind: 'type' }
      return { kind: 'none' }
    }
    if (COLUMN_CLAUSE.has(up)) return { kind: 'columns' }
    if (isReservedWord(up, dialect)) return { kind: 'keyword', after: 'keyword' }
    return { kind: 'keyword', after: 'expression' }
  }

  if (isPunctTok(p, '(')) return contextAfterOpenParen(before, k, dialect)

  if (isPunctTok(p, ',')) {
    const open = openParenIndex(before)
    const gov = governingKeyword(before, k - 1, dialect)
    if (gov) {
      if (gov.upper === 'FROM' || gov.upper === 'TRUNCATE') return { kind: 'relation', qualifier: [] }
      if (COLUMN_CLAUSE.has(gov.upper) || gov.upper === 'BY' || gov.upper === 'VALUES') return { kind: 'columns' }
    }
    if (open >= 0) return contextAfterOpenParen(before, open, dialect)
    return { kind: 'columns' }
  }

  if (isPunctTok(p, '*')) {
    // `SELECT *`, `t.*`, `count(*` are complete expressions; anything else is multiplication
    const q = before[k - 1]
    if (!q || isPunctTok(q, ',') || isPunctTok(q, '.') || isPunctTok(q, '(') || (q.kind === 'word' && (q.upper === 'SELECT' || q.upper === 'DISTINCT'))) {
      return { kind: 'keyword', after: 'expression' }
    }
    return { kind: 'columns' }
  }

  if (p.kind === 'number' && before[k - 1]?.kind === 'word' && before[k - 1]!.upper === 'TOP') return { kind: 'columns' }
  if (p.kind === 'punct' && !isPunctTok(p, ')') && !isPunctTok(p, ';')) return { kind: 'columns' }
  // identifier, number, string, ')' …
  return { kind: 'keyword', after: 'expression' }
}

function quotedIdentClosed(text: string): boolean {
  const close = text[0] === '[' ? ']' : '"'
  if (text.length < 2 || !text.endsWith(close)) return false
  // the closing quote is not the second half of an escaped (doubled) quote
  let run = 0
  for (let i = text.length - 1; i > 0 && text[i] === close; i--) run++
  return run % 2 === 1
}

/** Analyse the caret position `offset` of `text`. */
export function analyzeCaret(text: string, offset: number, dialect: Dialect): CaretAnalysis {
  const region = statementRegion(text, offset, dialect)
  // Lex from the region start to the end of the region (or the caret when it lies beyond).
  const end = Math.max(region.end, offset)
  let all = lex(text.slice(region.start, end), dialect, region.start)
  // A quoted identifier being typed (`[em`, `"cust`) is not closed yet: the lexer runs it to the end
  // of the text (or to an unrelated quote further down), swallowing the rest of the statement. Lex
  // it as ending at the caret instead.
  const typing = all.find(
    (t) => t.kind === 'quoted-ident' && t.start < offset && offset < t.end && (!quotedIdentClosed(t.text) || text.slice(offset, t.end).includes('\n')),
  )
  if (typing) all = [...lex(text.slice(region.start, offset), dialect, region.start), ...lex(text.slice(offset, end), dialect, offset)]
  const tokens = all.filter(isSignificant)
  const scope = parseScope(tokens, dialect, { start: region.start, end })

  const base = { region, scope, tokens }
  for (const t of all) {
    if (insideComment(t, offset, end)) return { ...base, context: { kind: 'none' }, prefix: '', quoted: false, from: offset, to: offset }
  }

  // current word: a name token that the caret is inside or at the end of
  const current = tokens.find((t) => isName(t) && t.start < offset && offset <= t.end)
  const quoted = current?.kind === 'quoted-ident'
  // An unterminated quoted identifier runs to the end of the text: replace only up to the caret.
  const open = quoted && !quotedIdentClosed(current.text)
  const from = current ? current.start : offset
  const to = current && !open ? current.end : offset
  const prefix = current ? text.slice(current.start, offset) : ''
  const before = tokens.filter((t) => t.end <= from)
  return { ...base, context: contextFromPrevious(before, dialect), prefix, quoted, from, to }
}
