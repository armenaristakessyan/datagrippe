// Statement classification: read-only detection (read-only connections) and destructive detection
// (production guard). Conservative by design: anything not known to be read-only is a write.

import type { Dialect } from '../types'
import { isPunct, isSignificant, tokenize, type Token } from './lexer'
import { batchRanges, splitPostgresTokens } from './split'
import type { StatementClassification } from './types'

const READ_ONLY_COMMON = new Set([
  'SELECT', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK', 'DECLARE', 'USE', 'PRINT', 'FETCH', 'CLOSE', 'DEALLOCATE',
])

const READ_ONLY_POSTGRES = new Set([
  'VALUES', 'TABLE', 'SHOW', 'RESET', 'START', 'END', 'ABORT', 'SAVEPOINT', 'RELEASE', 'DISCARD', 'LISTEN',
  'UNLISTEN', 'MOVE',
])

/** Control flow and session statements. Write statements nested in IF / WHILE / BEGIN … END are split out first. */
const READ_ONLY_MSSQL = new Set([
  'SAVE', 'OPEN', 'IF', 'ELSE', 'WHILE', 'END', 'RETURN', 'BREAK', 'CONTINUE', 'GOTO', 'THROW', 'RAISERROR',
  'REVERT',
])

/**
 * PostgreSQL settings that hold the server-side read-only guard of a read-only connection
 * (default_transaction_read_only, set by SET SESSION CHARACTERISTICS) or the current transaction's mode.
 * Changing or resetting them would turn the guard off, so it counts as a write.
 */
const READ_ONLY_GUCS = new Set(['default_transaction_read_only', 'transaction_read_only'])

/** Keywords that start a statement inside a WITH … (CTE body or main statement). */
const CTE_STATEMENTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE', 'WITH'])
const WITH_MAIN = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE'])

/**
 * Keywords that cannot continue a DELETE / UPDATE at depth 0: on SQL Server (no ';' needed) they start the
 * next statement, so a WHERE after them belongs to that statement.
 */
const DML_END = new Set([
  'SELECT', 'DECLARE', 'PRINT', 'IF', 'WHILE', 'BEGIN', 'ELSE', 'RETURN', 'USE', 'FETCH', 'OPEN', 'CLOSE',
  'DEALLOCATE', 'COMMIT', 'ROLLBACK', 'SAVE', 'THROW', 'RAISERROR', 'WAITFOR', 'BREAK', 'CONTINUE', 'GOTO',
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXEC', 'EXECUTE',
])

/** Object kinds written with two words after DROP (DROP MATERIALIZED VIEW, DROP FOREIGN TABLE…). */
const DROP_TWO_WORDS = new Set([
  'MATERIALIZED', 'FOREIGN', 'EVENT', 'TEXT', 'ACCESS', 'OWNED', 'PARTITION', 'FULLTEXT', 'EXTERNAL', 'XML',
  'SECURITY', 'MESSAGE', 'SEARCH', 'SERVER', 'COLUMN', 'ASYMMETRIC', 'SYMMETRIC', 'MASTER', 'APPLICATION',
  'BROKER', 'DATABASE', 'USER', 'WORKLOAD', 'RESOURCE', 'SENSITIVITY', 'EXTENDED', 'PROCEDURAL', 'TRUSTED',
])
const DROP_SECOND_WORDS = new Set([
  'VIEW', 'TABLE', 'TRIGGER', 'METHOD', 'BY', 'FUNCTION', 'SCHEME', 'INDEX', 'CATALOG', 'STOPLIST', 'POLICY',
  'TYPE', 'LIST', 'ROLE', 'AUDIT', 'KEY', 'CERTIFICATE', 'PRIORITY', 'MAPPING', 'WRAPPER', 'CONFIGURATION',
  'DICTIONARY', 'PARSER', 'TEMPLATE', 'SCHEMA', 'DATA', 'SOURCE', 'FILE', 'LIBRARY', 'LANGUAGE', 'POOL',
  'GROUP', 'CLASSIFICATION', 'PROPERTY', 'SPECIFICATION', 'ENCRYPTION', 'SCOPED', 'CREDENTIAL', 'STREAM',
])

/** ALTER TABLE … DROP followed by these only removes a column property, not data. */
const HARMLESS_ALTER_DROP = new Set(['DEFAULT', 'NOT', 'IDENTITY', 'EXPRESSION'])

const EMPTY: StatementClassification = { command: '', readOnly: true, destructive: false }

function read(command: string): StatementClassification {
  return { command, readOnly: true, destructive: false }
}

function write(command: string): StatementClassification {
  return { command, readOnly: false, destructive: false }
}

function destructive(command: string, reason: string): StatementClassification {
  return { command, readOnly: false, destructive: true, reason }
}

function rank(c: StatementClassification): number {
  if (c.destructive) return 2
  return c.readOnly ? 0 : 1
}

function mostDangerous(list: StatementClassification[]): StatementClassification {
  let best: StatementClassification | undefined
  for (const c of list) if (!best || rank(c) > rank(best)) best = c
  return best ?? EMPTY
}

/** Operates on significant tokens only. */
class Classifier {
  constructor(
    private readonly sql: string,
    private readonly dialect: Dialect,
  ) {}

  private punct(t: Token | undefined, ch: string): boolean {
    return t !== undefined && isPunct(this.sql, t, ch)
  }

  private text(t: Token): string {
    return this.sql.slice(t.start, t.end)
  }

  /** Index just after the ')' matching the '(' at `open`. */
  private closeParen(toks: Token[], open: number): number {
    let depth = 0
    for (let i = open; i < toks.length; i++) {
      if (this.punct(toks[i], '(')) depth++
      else if (this.punct(toks[i], ')') && --depth === 0) return i + 1
    }
    return toks.length
  }

  classify(toks: Token[]): StatementClassification {
    let i = 0
    while (i < toks.length && this.punct(toks[i], '(')) i++
    if (i >= toks.length) return toks.length === 0 ? EMPTY : write('')
    const first = toks[i]
    if (first.kind !== 'word') return write('')
    const body = toks.slice(i)
    const command = first.upper
    const second = body[1]?.kind === 'word' ? body[1].upper : ''

    if (this.dialect === 'postgres') {
      if (this.callsReadOnlySetConfig(body)) return write(command)
      switch (command) {
        case 'SET':
          if (this.setsReadOnlyMode(body)) return write(command)
          break
        case 'RESET':
          // RESET ALL restores default_transaction_read_only to its configured default (off).
          if (second === 'ALL' || READ_ONLY_GUCS.has(this.settingName(body[1]))) return write(command)
          break
        case 'DISCARD':
          // DISCARD ALL includes SET SESSION AUTHORIZATION DEFAULT and RESET ALL.
          if (second === 'ALL') return write(command)
          break
        case 'BEGIN':
        case 'START':
          if (this.hasReadWrite(body)) return write(command)
          break
      }
    }

    switch (command) {
      case 'WITH':
        return this.classifyWith(body)
      case 'EXPLAIN':
        return this.classifyExplain(body)
      case 'DELETE':
        return this.hasWhere(body) ? write(command) : destructive(command, 'DELETE without WHERE clause')
      case 'UPDATE':
        if (second === 'STATISTICS') return write(command)
        return this.hasWhere(body) ? write(command) : destructive(command, 'UPDATE without WHERE clause')
      case 'DROP':
        return destructive(command, this.dropReason(body))
      case 'TRUNCATE':
        return destructive(command, 'TRUNCATE TABLE')
      case 'ALTER': {
        const reason = second === 'TABLE' ? this.alterTableDrop(body) : undefined
        return reason ? destructive(command, reason) : write(command)
      }
      case 'BEGIN':
        if (this.dialect === 'mssql' && (second === 'DIALOG' || second === 'CONVERSATION')) return write(command)
        break
      case 'END':
        // SQL Server Service Broker: END CONVERSATION changes broker state.
        if (this.dialect === 'mssql' && second === 'CONVERSATION') return write(command)
        break
      case 'WAITFOR':
        if (this.dialect === 'mssql') return second === 'DELAY' || second === 'TIME' ? read(command) : write(command)
        break
    }

    const readOnlyCommand =
      READ_ONLY_COMMON.has(command) ||
      (this.dialect === 'postgres' ? READ_ONLY_POSTGRES : READ_ONLY_MSSQL).has(command)
    if (!readOnlyCommand) return write(command)
    return this.createsTable(body) || this.locksRows(body) ? write(command) : read(command)
  }

  /** Lower-case setting name of a word or "quoted" identifier token ('' otherwise). */
  private settingName(t: Token | undefined): string {
    if (!t) return ''
    if (t.kind === 'word') return t.upper.toLowerCase()
    if (t.kind === 'quoted-ident') return this.text(t).slice(1, -1).replace(/""/g, '"').toLowerCase()
    return ''
  }

  /** READ WRITE transaction mode anywhere in the statement (BEGIN / START TRANSACTION / SET … TRANSACTION). */
  private hasReadWrite(body: Token[]): boolean {
    for (let k = 0; k < body.length - 1; k++) {
      if (body[k].kind === 'word' && body[k].upper === 'READ' && body[k + 1].kind === 'word' && body[k + 1].upper === 'WRITE') {
        return true
      }
    }
    return false
  }

  /**
   * SET [SESSION | LOCAL] default_transaction_read_only / transaction_read_only …, and
   * SET TRANSACTION / SET SESSION CHARACTERISTICS AS TRANSACTION … READ WRITE.
   */
  private setsReadOnlyMode(body: Token[]): boolean {
    const scope = body[1]?.kind === 'word' ? body[1].upper : ''
    const target = body[scope === 'SESSION' || scope === 'LOCAL' ? 2 : 1]
    if (target?.kind === 'word' && (target.upper === 'TRANSACTION' || target.upper === 'CHARACTERISTICS')) {
      return this.hasReadWrite(body)
    }
    return READ_ONLY_GUCS.has(this.settingName(target))
  }

  /**
   * set_config(name, …) whose name is a read-only setting or is not a plain string literal (it could be
   * computed to one). set_config('search_path', …) and other settings stay read-only.
   */
  private callsReadOnlySetConfig(body: Token[]): boolean {
    for (let k = 0; k < body.length - 1; k++) {
      if (this.settingName(body[k]) !== 'set_config' || !this.punct(body[k + 1], '(')) continue
      const arg = body[k + 2]
      const literal = arg?.kind === 'string' && this.sql.charCodeAt(arg.start) === 39 && this.punct(body[k + 3], ',')
      if (!literal) return true
      const name = this.text(arg).slice(1, -1).replace(/''/g, "'").trim().toLowerCase()
      if (READ_ONLY_GUCS.has(name)) return true
    }
    return false
  }

  /** WITH: CTE bodies (data-modifying CTEs count) and the main statement after the CTE list. */
  private classifyWith(body: Token[]): StatementClassification {
    const parts: StatementClassification[] = []
    let main: StatementClassification | undefined
    let i = 1
    while (i < body.length) {
      const t = body[i]
      if (this.punct(t, '(')) {
        const close = this.closeParen(body, i)
        const inner = body.slice(i + 1, close - 1)
        let k = 0
        while (k < inner.length && this.punct(inner[k], '(')) k++
        if (inner[k]?.kind === 'word' && CTE_STATEMENTS.has(inner[k].upper)) parts.push(this.classify(inner))
        i = close
        continue
      }
      if (t.kind === 'word' && WITH_MAIN.has(t.upper)) {
        main = this.classify(body.slice(i))
        break
      }
      i++
    }
    const worst = mostDangerous([main ?? write('WITH'), ...parts])
    return { ...worst, command: 'WITH' }
  }

  /** EXPLAIN only plans, except EXPLAIN ANALYZE which runs the statement. */
  private classifyExplain(body: Token[]): StatementClassification {
    let analyze = false
    let i = 1
    if (this.punct(body[i], '(')) {
      const close = this.closeParen(body, i)
      for (let k = i + 1; k < close - 1; k++) {
        const t = body[k]
        if (t.kind !== 'word' || (t.upper !== 'ANALYZE' && t.upper !== 'ANALYSE')) continue
        const value = body[k + 1]
        const off =
          value !== undefined &&
          !this.punct(value, ',') &&
          !this.punct(value, ')') &&
          /^'?(false|off|0|no)'?$/i.test(this.text(value))
        analyze = !off
      }
      i = close
    }
    while (body[i]?.kind === 'word' && ['ANALYZE', 'ANALYSE', 'VERBOSE'].includes(body[i].upper)) {
      if (body[i].upper !== 'VERBOSE') analyze = true
      i++
    }
    if (!analyze) return read('EXPLAIN')
    const inner = this.classify(body.slice(i))
    return { ...inner, command: 'EXPLAIN' }
  }

  /** WHERE at depth 0 of a DELETE / UPDATE (subqueries and CASE … END are skipped). */
  private hasWhere(body: Token[]): boolean {
    const isDelete = body[0].upper === 'DELETE'
    let depth = 0
    let caseDepth = 0
    for (let i = 1; i < body.length; i++) {
      const t = body[i]
      if (this.punct(t, '(')) depth++
      else if (this.punct(t, ')')) depth = Math.max(0, depth - 1)
      if (depth > 0 || t.kind !== 'word') continue
      if (t.upper === 'CASE') caseDepth++
      else if (t.upper === 'END') {
        if (caseDepth === 0) return false
        caseDepth--
      } else if (caseDepth === 0) {
        if (t.upper === 'WHERE') return true
        if (DML_END.has(t.upper) || (isDelete && t.upper === 'SET')) return false
      }
    }
    return false
  }

  private dropReason(body: Token[]): string {
    const words: string[] = ['DROP']
    const a = body[1]
    if (a?.kind === 'word') {
      words.push(a.upper)
      const b = body[2]
      if (DROP_TWO_WORDS.has(a.upper) && b?.kind === 'word' && DROP_SECOND_WORDS.has(b.upper)) words.push(b.upper)
    }
    return words.join(' ')
  }

  private alterTableDrop(body: Token[]): string | undefined {
    let depth = 0
    for (let i = 2; i < body.length; i++) {
      const t = body[i]
      if (this.punct(t, '(')) depth++
      else if (this.punct(t, ')')) depth = Math.max(0, depth - 1)
      if (depth > 0 || t.kind !== 'word' || t.upper !== 'DROP') continue
      const next = body[i + 1]
      const what = next?.kind === 'word' ? next.upper : ''
      if (HARMLESS_ALTER_DROP.has(what)) continue
      return what === 'COLUMN' || what === 'CONSTRAINT' || what === 'PERIOD'
        ? `ALTER TABLE … DROP ${what}`
        : 'ALTER TABLE … DROP'
    }
    return undefined
  }

  /** SELECT … INTO new_table (not INSERT INTO / MERGE INTO / FETCH … INTO @var). */
  private createsTable(body: Token[]): boolean {
    let depth = 0
    for (let i = 1; i < body.length; i++) {
      const t = body[i]
      if (this.punct(t, '(')) depth++
      else if (this.punct(t, ')')) depth = Math.max(0, depth - 1)
      if (depth > 0 || t.kind !== 'word' || t.upper !== 'INTO') continue
      const prev = body[i - 1]
      if (prev.kind === 'word' && (prev.upper === 'INSERT' || prev.upper === 'MERGE')) continue
      const target = body[i + 1]
      if (target?.kind === 'word' && target.upper.startsWith('@')) continue
      return true
    }
    return false
  }

  /** Row-locking clauses: FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE. */
  private locksRows(body: Token[]): boolean {
    for (let i = 0; i < body.length - 1; i++) {
      if (body[i].kind !== 'word' || body[i].upper !== 'FOR') continue
      const next = body[i + 1].upper
      if (next === 'UPDATE' || next === 'SHARE') return true
      if ((next === 'NO' || next === 'KEY') && i + 2 < body.length) {
        const third = body[i + 2].upper
        if (third === 'KEY' || third === 'UPDATE' || third === 'SHARE') return true
      }
    }
    return false
  }

  // -------------------------------------------------------------------------
  // SQL Server batches: statements do not need ';'
  // -------------------------------------------------------------------------

  /**
   * Split a batch into statements at ';' (depth 0) and at write keywords that start a new statement,
   * e.g. "SELECT 1 UPDATE t SET a = 1". Writes are the only starts that matter: everything else in a
   * fragment is classified with the fragment's leading command.
   */
  mssqlStatements(toks: Token[]): Token[][] {
    const out: Token[][] = []
    let current: Token[] = []
    let depth = 0
    let wholeRest = false
    let withPendingMain = false
    const flush = (): void => {
      if (current.length > 0) out.push(current)
      current = []
      withPendingMain = false
    }

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (wholeRest) {
        current.push(t)
        continue
      }
      if (this.punct(t, ';') && depth === 0) {
        flush()
        continue
      }
      if (this.punct(t, '(')) depth++
      else if (this.punct(t, ')')) depth = Math.max(0, depth - 1)
      else if (t.kind === 'word' && depth === 0) {
        if (current.length > 0 && this.startsWriteStatement(toks, i, current)) {
          if (withPendingMain && WITH_MAIN.has(t.upper)) withPendingMain = false
          else flush()
        } else if (withPendingMain && WITH_MAIN.has(t.upper)) {
          withPendingMain = false
        }
        if (current.length === 0) {
          if (t.upper === 'WITH') withPendingMain = true
          if (this.isModuleDefinition(toks, i)) wholeRest = true
        }
      }
      current.push(t)
    }
    flush()
    return out
  }

  /** CREATE / ALTER PROCEDURE | FUNCTION | TRIGGER | VIEW: the rest of the batch is the module body. */
  private isModuleDefinition(toks: Token[], i: number): boolean {
    if (toks[i].upper !== 'CREATE' && toks[i].upper !== 'ALTER') return false
    let k = i + 1
    if (toks[k]?.upper === 'OR' && toks[k + 1]?.upper === 'ALTER') k += 2
    return ['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'].includes(toks[k]?.upper ?? '')
  }

  private isTriggerHeader(current: Token[]): boolean {
    const leading = current.find((x) => !this.punct(x, '('))?.upper
    return (leading === 'CREATE' || leading === 'ALTER') && current.some((x) => x.kind === 'word' && x.upper === 'TRIGGER')
  }

  private startsWriteStatement(toks: Token[], i: number, current: Token[]): boolean {
    const t = toks[i]
    if (!MSSQL_WRITE_STARTS.has(t.upper)) return false
    const prev = toks[i - 1]
    const next = toks[i + 1]
    if (this.punct(prev, '.') || this.punct(next, '.') || this.punct(prev, ',')) return false
    if (prev.kind === 'word' && WRITE_START_EXCLUDED_AFTER.has(prev.upper)) return false
    // AFTER / BEFORE / INSTEAD OF INSERT only in a trigger header: elsewhere they are legal column
    // aliases ("SELECT 1 AS after DELETE FROM t" is a SELECT followed by a DELETE).
    if (prev.kind === 'word' && TRIGGER_TIMINGS.has(prev.upper) && this.isTriggerHeader(current)) return false
    if (t.upper === 'UPDATE' && this.punct(next, '(')) return false
    // ON DELETE CASCADE / ON UPDATE SET NULL… (foreign key actions)
    if (prev.upper === 'ON' && (t.upper === 'DELETE' || t.upper === 'UPDATE') && FK_ACTIONS.has(next?.upper ?? '')) {
      return false
    }
    const leading = current.find((x) => !this.punct(x, '('))?.upper
    if (leading === 'ALTER' && ALTER_CLAUSES.has(t.upper)) return false
    return true
  }
}

const MSSQL_WRITE_STARTS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY',
  'EXEC', 'EXECUTE', 'BULK', 'BACKUP', 'RESTORE', 'DBCC', 'KILL', 'RECONFIGURE', 'SHUTDOWN', 'CHECKPOINT',
  'UPDATETEXT', 'WRITETEXT', 'SEND', 'RECEIVE', 'ENABLE', 'DISABLE',
])

/**
 * A write keyword right after these is part of the current statement (MERGE … THEN DELETE, GRANT INSERT…,
 * cursor FOR UPDATE OF, INSTEAD OF DELETE). All of them are reserved words, so they cannot be aliases.
 */
const WRITE_START_EXCLUDED_AFTER = new Set(['THEN', 'OF', 'FOR', 'GRANT', 'REVOKE', 'DENY', 'OR', 'BULK'])

/** Trigger timings: not reserved in T-SQL, so only meaningful inside CREATE / ALTER TRIGGER. */
const TRIGGER_TIMINGS = new Set(['AFTER', 'BEFORE', 'INSTEAD'])

const FK_ACTIONS = new Set(['CASCADE', 'NO', 'SET', 'RESTRICT'])

/** Inside ALTER TABLE / ALTER INDEX these keywords are clauses, not new statements. */
const ALTER_CLAUSES = new Set(['ALTER', 'DROP', 'ENABLE', 'DISABLE'])

function significantTokens(tokens: Token[], from: number, to: number): Token[] {
  const out: Token[] = []
  for (let i = from; i < to; i++) if (isSignificant(tokens[i])) out.push(tokens[i])
  return out
}

export function classifyStatement(sql: string, dialect: Dialect): StatementClassification {
  const tokens = tokenize(sql, dialect)
  const classifier = new Classifier(sql, dialect)
  const results: StatementClassification[] = []
  if (dialect === 'postgres') {
    for (const unit of splitPostgresTokens(sql, tokens)) {
      results.push(classifier.classify(significantTokens(tokens, unit.from, unit.to)))
    }
  } else {
    for (const range of batchRanges(sql, tokens)) {
      for (const statement of classifier.mssqlStatements(significantTokens(tokens, range.from, range.to))) {
        results.push(classifier.classify(statement))
      }
    }
  }
  return mostDangerous(results)
}
