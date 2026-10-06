// Script splitting: execution units (statements / GO batches), statement-level units for
// "Run statement", and the statement under the caret.

import type { Dialect } from '../types'
import { isPunct, isSignificant, tokenize, type Token } from './lexer'
import type { SqlStatement } from './types'

/** A unit plus the token range it covers: tokens[from] is its first significant token, tokens[to - 1] its last. */
export interface TokenUnit {
  from: number
  to: number
  statement: SqlStatement
}

function newlineCount(sql: string, start: number, end: number, stopAt = Infinity): number {
  let count = 0
  for (let i = start; i < end; i++) {
    if (sql.charCodeAt(i) === 10 && ++count >= stopAt) break
  }
  return count
}

/** Collects the significant-token bounds of the unit being built. */
class UnitBuilder {
  private from = -1
  private to = -1

  constructor(
    private readonly sql: string,
    private readonly tokens: Token[],
    private readonly out: TokenUnit[],
  ) {}

  add(index: number): void {
    if (this.from === -1) this.from = index
    this.to = index + 1
  }

  get empty(): boolean {
    return this.from === -1
  }

  flush(repeat?: number): void {
    if (this.from !== -1) {
      const start = this.tokens[this.from].start
      const end = this.tokens[this.to - 1].end
      const statement: SqlStatement = { text: this.sql.slice(start, end), start, end }
      if (repeat !== undefined) statement.repeat = repeat
      this.out.push({ from: this.from, to: this.to, statement })
    }
    this.from = -1
    this.to = -1
  }
}

function nextSignificant(tokens: Token[], index: number, limit = tokens.length): Token | undefined {
  for (let i = index + 1; i < limit; i++) if (isSignificant(tokens[i])) return tokens[i]
  return undefined
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/**
 * One unit per ';' at parenthesis depth 0. SQL-standard function bodies (BEGIN ATOMIC … END) contain ';'
 * that do not end the statement; inside such a body CASE … END is tracked so that its END does not close
 * the body.
 */
export function splitPostgresTokens(sql: string, tokens: Token[]): TokenUnit[] {
  const out: TokenUnit[] = []
  const unit = new UnitBuilder(sql, tokens, out)
  let atomicDepth = 0
  // A ';' never ends a statement inside parentheses (CREATE RULE … DO ALSO (INSERT …; INSERT …)).
  let parenDepth = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!isSignificant(t)) continue
    if (atomicDepth === 0 && parenDepth === 0 && isPunct(sql, t, ';')) {
      unit.flush()
      continue
    }
    if (t.kind === 'punct') {
      if (isPunct(sql, t, '(')) parenDepth++
      else if (isPunct(sql, t, ')')) parenDepth = Math.max(0, parenDepth - 1)
    } else if (t.kind === 'word') {
      if (t.upper === 'BEGIN' && nextSignificant(tokens, i)?.upper === 'ATOMIC') atomicDepth++
      else if (atomicDepth > 0 && t.upper === 'CASE') atomicDepth++
      else if (atomicDepth > 0 && t.upper === 'END') atomicDepth--
    }
    unit.add(i)
  }
  unit.flush()
  return out
}

// ---------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------

export interface GoLine {
  /** Token index of the GO word. */
  first: number
  /** Token index of the last token on the GO line (GO, its count or its trailing comment). */
  last: number
  repeat?: number
}

function hasNewline(sql: string, t: Token): boolean {
  return newlineCount(sql, t.start, t.end, 1) > 0
}

/** Checks the rest of a line starting after a GO word: `[count] [-- comment]` then end of line. */
function matchGoTail(sql: string, tokens: Token[], goIndex: number): GoLine | null {
  let j = goIndex + 1
  let repeat: number | undefined
  const done = (): GoLine => ({ first: goIndex, last: j - 1, ...(repeat !== undefined ? { repeat } : {}) })
  const at = (): Token | undefined => tokens[j]

  let t = at()
  if (!t) return done()
  if (t.kind === 'whitespace') {
    if (hasNewline(sql, t)) return done()
    j++
    t = at()
    if (!t) return done()
  }
  if (t.kind === 'number' && /^\d+$/.test(sql.slice(t.start, t.end))) {
    repeat = Math.max(1, Number.parseInt(sql.slice(t.start, t.end), 10))
    j++
    t = at()
    if (!t) return done()
    if (t.kind === 'whitespace') {
      if (hasNewline(sql, t)) return done()
      j++
      t = at()
      if (!t) return done()
    }
  }
  if (t.kind === 'line-comment') {
    j++
    t = at()
    if (!t || (t.kind === 'whitespace' && hasNewline(sql, t))) return done()
  }
  return null
}

/** GO lines: a line holding only `GO [count] [-- comment]`, never inside strings, comments or brackets. */
export function findGoLines(sql: string, tokens: Token[]): GoLine[] {
  const out: GoLine[] = []
  let atLineStart = true
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'whitespace') {
      if (hasNewline(sql, t)) atLineStart = true
      continue
    }
    if (atLineStart && t.kind === 'word' && t.upper === 'GO') {
      const go = matchGoTail(sql, tokens, i)
      if (go) {
        out.push(go)
        i = go.last
      }
    }
    atLineStart = false
  }
  return out
}

export interface TokenRange {
  from: number
  to: number
  repeat?: number
}

/** Token ranges between GO lines (GO lines excluded). */
export function batchRanges(sql: string, tokens: Token[]): TokenRange[] {
  const ranges: TokenRange[] = []
  let from = 0
  for (const go of findGoLines(sql, tokens)) {
    ranges.push({ from, to: go.first, ...(go.repeat !== undefined ? { repeat: go.repeat } : {}) })
    from = go.last + 1
  }
  ranges.push({ from, to: tokens.length })
  return ranges
}

export function splitMssqlBatchTokens(sql: string, tokens: Token[]): TokenUnit[] {
  const out: TokenUnit[] = []
  const unit = new UnitBuilder(sql, tokens, out)
  for (const range of batchRanges(sql, tokens)) {
    for (let i = range.from; i < range.to; i++) if (isSignificant(tokens[i])) unit.add(i)
    unit.flush(range.repeat)
  }
  return out
}

/** BEGIN followed by one of these is a statement, not a BEGIN … END block. */
const NON_BLOCK_BEGIN = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'])

/** Keywords that start a T-SQL statement (used to tell an IF / WHILE / ELSE condition from its body). */
const MSSQL_STATEMENT_STARTS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'PRINT', 'BEGIN', 'SET', 'DECLARE', 'EXEC', 'EXECUTE',
  'RETURN', 'RAISERROR', 'THROW', 'IF', 'WHILE', 'BREAK', 'CONTINUE', 'GOTO', 'WAITFOR', 'TRUNCATE', 'DROP',
  'CREATE', 'ALTER', 'USE', 'COMMIT', 'ROLLBACK', 'SAVE', 'FETCH', 'OPEN', 'CLOSE', 'DEALLOCATE', 'WITH',
  'GRANT', 'REVOKE', 'DENY', 'BULK', 'DBCC', 'KILL', 'BACKUP', 'RESTORE', 'CHECKPOINT', 'RECONFIGURE',
  'ENABLE', 'DISABLE', 'SEND', 'RECEIVE', 'UPDATETEXT', 'WRITETEXT', 'READTEXT', 'SHUTDOWN', 'REVERT',
])

/** Keywords that never start a statement: after a blank line they continue the current one. */
const MSSQL_CONTINUATIONS = new Set([
  'WHERE', 'FROM', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'APPLY', 'ON', 'AND', 'OR',
  'NOT', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'ELSE', 'VALUES', 'OUTPUT', 'WHEN',
  'THEN', 'OPTION', 'PIVOT', 'UNPIVOT', 'OFFSET', 'INTO', 'COLLATE', 'ASC', 'DESC', 'BETWEEN', 'LIKE', 'IS',
  'IN', 'AS', 'ALL', 'ANY', 'SOME', 'ESCAPE', 'FOR', 'WINDOW', 'TABLESAMPLE', 'USING',
])

/** A statement cannot end with these keywords: the next line (even after a blank line) continues it. */
const MSSQL_INCOMPLETE_ENDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'JOIN', 'SET', 'BY', 'AS', 'INTO', 'VALUES', 'UNION',
  'EXCEPT', 'INTERSECT', 'ELSE', 'THEN', 'WHEN', 'IN', 'IS', 'LIKE', 'BETWEEN', 'INSERT', 'UPDATE', 'DELETE',
  'MERGE', 'EXEC', 'EXECUTE', 'TOP', 'DISTINCT', 'ORDER', 'GROUP', 'HAVING', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'OUTER', 'CROSS', 'APPLY', 'WITH', 'IF', 'WHILE', 'PRINT', 'DECLARE', 'TABLE', 'EXISTS', 'USING', 'DROP',
  'TRUNCATE', 'CREATE', 'ALTER', 'GRANT', 'REVOKE', 'DENY', 'TO', 'RAISERROR', 'OFFSET', 'FETCH', 'USE', 'GOTO',
  'WAITFOR', 'COLLATE', 'ALL',
])

const WITH_MAIN_STATEMENTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])
const INSERT_SOURCES = new Set(['VALUES', 'SELECT', 'EXEC', 'EXECUTE', 'DEFAULT', 'OUTPUT'])

/** CREATE / ALTER PROCEDURE | FUNCTION | TRIGGER | VIEW at `i`: the rest of the batch is the module body. */
function isModuleStart(tokens: Token[], i: number, limit: number): boolean {
  const first = tokens[i]
  if (first.kind !== 'word' || (first.upper !== 'CREATE' && first.upper !== 'ALTER')) return false
  let next = nextSignificantIndex(tokens, i, limit)
  if (next !== -1 && tokens[next].upper === 'OR') {
    const alter = nextSignificantIndex(tokens, next, limit)
    next = alter !== -1 && tokens[alter].upper === 'ALTER' ? nextSignificantIndex(tokens, alter, limit) : -1
  }
  return next !== -1 && ['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'].includes(tokens[next].upper)
}

function nextSignificantIndex(tokens: Token[], index: number, limit: number): number {
  for (let i = index + 1; i < limit; i++) if (isSignificant(tokens[i])) return i
  return -1
}

/**
 * What is known about the statement being built at nesting depth 0, so a blank line only ends a
 * statement that is complete: "DELETE FROM t", a blank line, then "WHERE id = 1" is one statement.
 */
class MssqlStatementState {
  leading = ''
  /** CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW: runs to the end of the batch. */
  module = false
  /** After IF / WHILE (condition) or ELSE: the controlled statement has not started yet. */
  needsBody = false
  sawUpdateSet = false
  sawInsertSource = false
  sawWithMain = false
  last: Token | undefined
  beforeLast: Token | undefined

  reset(): void {
    this.leading = ''
    this.module = false
    this.needsBody = false
    this.sawUpdateSet = false
    this.sawInsertSource = false
    this.sawWithMain = false
    this.last = undefined
    this.beforeLast = undefined
  }

  /** Record a significant token seen at depth 0 (before its own depth change). */
  observe(sql: string, tokens: Token[], i: number, limit: number, empty: boolean): void {
    const t = tokens[i]
    if (t.kind === 'word') {
      const word = t.upper
      if (empty) {
        this.leading = word
        this.module = isModuleStart(tokens, i, limit)
      }
      const next = tokens[nextSignificantIndex(tokens, i, limit)]
      const functionCall = next !== undefined && isPunct(sql, next, '(')
      if (word === 'IF' || word === 'WHILE' || word === 'ELSE') {
        this.needsBody = true
      } else if (MSSQL_STATEMENT_STARTS.has(word) && !(word === 'UPDATE' && functionCall)) {
        this.needsBody = false
      }
      if (this.leading === 'UPDATE' && word === 'SET') this.sawUpdateSet = true
      if (this.leading === 'INSERT' && INSERT_SOURCES.has(word)) this.sawInsertSource = true
      if (this.leading === 'WITH' && !empty && WITH_MAIN_STATEMENTS.has(word)) this.sawWithMain = true
    }
  }

  /** Record any significant token of the statement (any depth). */
  track(t: Token): void {
    this.beforeLast = this.last
    this.last = t
  }

  /** True when a blank line before `next` must not end the statement. */
  continuesAt(sql: string, next: Token | undefined): boolean {
    if (this.module || this.needsBody) return true
    const last = this.last
    if (last) {
      if (last.kind === 'punct' && !isPunct(sql, last, ')')) return true
      if (last.kind === 'word' && MSSQL_INCOMPLETE_ENDS.has(last.upper)) return true
      // JOIN u ON <condition>; SET NOCOUNT ON / SET XACT_ABORT ON are complete.
      if (last.upper === 'ON' && WITH_MAIN_STATEMENTS.has(this.leading)) return true
      // END TRY must be followed by BEGIN CATCH.
      if (last.upper === 'TRY' && this.beforeLast?.upper === 'END') return true
    }
    if (!next) return false
    if (next.kind !== 'word') return true
    const word = next.upper
    if (MSSQL_CONTINUATIONS.has(word)) return true
    if (word === 'SET' && this.leading === 'UPDATE' && !this.sawUpdateSet) return true
    if (this.leading === 'INSERT' && !this.sawInsertSource && INSERT_SOURCES.has(word)) return true
    if (this.leading === 'WITH' && !this.sawWithMain && WITH_MAIN_STATEMENTS.has(word)) return true
    // ORDER BY … OFFSET n ROWS, then FETCH NEXT n ROWS ONLY.
    if (word === 'FETCH' && (last?.upper === 'ROWS' || last?.upper === 'ROW')) return true
    return false
  }
}

export function splitMssqlFineTokens(sql: string, tokens: Token[]): TokenUnit[] {
  const out: TokenUnit[] = []
  const unit = new UnitBuilder(sql, tokens, out)
  const state = new MssqlStatementState()
  const flush = (): void => {
    unit.flush()
    state.reset()
  }
  for (const range of batchRanges(sql, tokens)) {
    let depth = 0
    for (let i = range.from; i < range.to; i++) {
      const t = tokens[i]
      if (state.module) {
        // CREATE PROCEDURE … AS <body>: T-SQL requires the module to be alone in its batch.
        if (isSignificant(t)) unit.add(i)
        continue
      }
      if (t.kind === 'whitespace') {
        if (depth === 0 && !unit.empty && newlineCount(sql, t.start, t.end, 2) >= 2) {
          const next = nextSignificantIndex(tokens, i, range.to)
          if (!state.continuesAt(sql, next === -1 ? undefined : tokens[next])) flush()
        }
        continue
      }
      if (!isSignificant(t)) continue
      if (depth === 0) {
        if (isPunct(sql, t, ';')) {
          // IF … PRINT 'a'; ELSE PRINT 'b' is one statement.
          const next = nextSignificantIndex(tokens, i, range.to)
          if (next === -1 || tokens[next].upper !== 'ELSE') flush()
          continue
        }
        state.observe(sql, tokens, i, range.to, unit.empty)
      }
      state.track(t)
      if (t.kind === 'punct') {
        if (isPunct(sql, t, '(')) depth++
        else if (isPunct(sql, t, ')')) depth = Math.max(0, depth - 1)
      } else if (t.kind === 'word') {
        if (t.upper === 'CASE') depth++
        else if (t.upper === 'BEGIN') {
          const next = nextSignificant(tokens, i, range.to)
          if (!next || !NON_BLOCK_BEGIN.has(next.upper)) depth++
        } else if (t.upper === 'END' && nextSignificant(tokens, i, range.to)?.upper !== 'CONVERSATION') {
          depth = Math.max(0, depth - 1)
        }
      }
      unit.add(i)
    }
    flush()
  }
  return out
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function splitTokens(sql: string, tokens: Token[], dialect: Dialect): TokenUnit[] {
  return dialect === 'postgres' ? splitPostgresTokens(sql, tokens) : splitMssqlBatchTokens(sql, tokens)
}

export function splitFineTokens(sql: string, tokens: Token[], dialect: Dialect): TokenUnit[] {
  return dialect === 'postgres' ? splitPostgresTokens(sql, tokens) : splitMssqlFineTokens(sql, tokens)
}

export function splitStatements(sql: string, dialect: Dialect): SqlStatement[] {
  return splitTokens(sql, tokenize(sql, dialect), dialect).map((u) => u.statement)
}

export function splitStatementsFine(sql: string, dialect: Dialect): SqlStatement[] {
  return splitFineTokens(sql, tokenize(sql, dialect), dialect).map((u) => u.statement)
}

/** True when tokens between `start` and `end` are only whitespace, comments and ';' (no GO line, no code). */
function gapIsSeparatorOnly(sql: string, tokens: Token[], start: number, end: number): boolean {
  for (const t of tokens) {
    if (t.end <= start) continue
    if (t.start >= end) break
    if (isSignificant(t) && !isPunct(sql, t, ';')) return false
  }
  return true
}

function hasBlankLine(text: string): boolean {
  return /\n[^\S\n]*\n/.test(text)
}

/**
 * Statement under the caret. Caret inside a statement (bounds included) → that statement. Otherwise,
 * in order: the previous statement ending on the caret's line (DataGrip: caret right after "SELECT 1;"
 * runs it), the next statement starting on the caret's line, the previous statement when nothing but
 * separators and no blank line lie between it and the caret, then the next one under the same rule.
 */
export function statementAtOffset(sql: string, offset: number, dialect: Dialect): SqlStatement | null {
  const tokens = tokenize(sql, dialect)
  const units = splitFineTokens(sql, tokens, dialect).map((u) => u.statement)
  if (units.length === 0) return null
  const caret = Math.min(Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0)), sql.length)

  let prev: SqlStatement | undefined
  let next: SqlStatement | undefined
  for (const unit of units) {
    if (caret >= unit.start && caret <= unit.end) return unit
    if (unit.end < caret) prev = unit
    else if (!next && unit.start > caret) next = unit
  }

  const before = prev ? sql.slice(prev.end, caret) : ''
  const after = next ? sql.slice(caret, next.start) : ''
  if (prev && !before.includes('\n')) return prev
  if (next && !after.includes('\n')) return next
  if (prev && !hasBlankLine(before) && gapIsSeparatorOnly(sql, tokens, prev.end, caret)) return prev
  if (next && !hasBlankLine(after) && gapIsSeparatorOnly(sql, tokens, caret, next.start)) return next
  return null
}
