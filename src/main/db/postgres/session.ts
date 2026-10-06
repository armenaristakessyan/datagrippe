// A console session: one dedicated pg.Client, operations serialized through an internal queue.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type Cursor from 'pg-cursor'
import type { FieldDef } from 'pg'
import { classifyStatement, quoteIdent, splitStatements, type SqlStatement } from '@shared/sql'
import type {
  CellValue,
  DbErrorInfo,
  ExplainResult,
  FetchMoreResult,
  MessageLevel,
  QueryMessage,
  ServerInfo,
  StatementResult,
  TransactionState,
} from '@shared/types'
import { DriverError } from '../errors'
import type { DriverExecuteOptions, DriverExecuteResult, DriverSession, ResolvedConnection } from '../types'
import { backendKeyOf, sendCancelRequest } from './cancel'
import { connectClient, queryServerInfo, withClient, type TlsSetting } from './connect'
import { closeCursor, extendedQuery, openCursor, parseCommandTag, readCursor, type RawRow } from './cursor'
import { isConnectionLevel, isServerError, serverErrorInfo, toDriverError } from './errors'
import { parseExplain } from './explain'
import { isCopyStdio, noTransactionBlockCommand } from './statement-kind'
import { num, select, str, type Queryable } from './rows'
import { TypeNameCache } from './type-names'
import { toCellRow } from './values'

const QUERY_CANCELED = '57014'
const ACTIVE_SQL_TRANSACTION = '25001'

/** Commands that manage the transaction themselves: no implicit BEGIN in manual-commit mode. */
const TRANSACTION_CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT'])

// An auto-commit statement whose result has more rows than maxRows runs in an implicit transaction that
// only ends when its portal is closed (Close + Sync). Until then its changes are not committed (and are
// rolled back if the connection closes), and it holds its snapshot and its locks, blocking DDL, TRUNCATE
// and VACUUM FULL from every other session. So such a portal never outlives user think time:
//  - a data-modifying statement (UPDATE … RETURNING, writing CTE) is read into memory, up to
//    writeResultRows, and its portal closed before execute() returns: the change is committed;
//  - a read-only statement is read ahead into memory (readAheadRows / readAheadMs) and, when it still
//    has more rows, its portal is released after idleReleaseMs without fetchMore.
// Statements run inside a transaction block (manual commit, explicit BEGIN) keep their portal: the
// transaction is the user's and stays open anyway.

/** Limits of that policy (mutable for tests only). */
export const RESULT_POLICY = {
  /** Rows buffered after the first page of a read-only auto-commit result. */
  readAheadRows: 10_000,
  /** Time budget of that read-ahead, so a slow query does not delay its first page much. */
  readAheadMs: 750,
  /** Rows of a data-modifying auto-commit statement kept in memory before its portal is closed. */
  writeResultRows: 100_000,
  /** An auto-commit portal not read from for this long is closed to release its locks and snapshot. */
  idleReleaseMs: 10_000,
}
const READ_CHUNK_ROWS = 2_000
/** close() waits this long for an auto-commit portal to be closed (committed) before disconnecting. */
const CLOSE_PORTAL_TIMEOUT_MS = 2_000

interface OpenResult {
  id: string
  /** Live portal; null once it is finished or was closed (only `buffered` rows remain). */
  cursor: Cursor<RawRow> | null
  /** Rows read ahead of the caller (at least the "peek" that tells whether more rows exist). */
  buffered: CellValue[][]
  /** The portal lives in the statement's implicit transaction (auto-commit). */
  implicit: boolean
  /** Why the rows after `buffered` cannot be fetched (portal released early, or failed while reading ahead). */
  rest: DriverError | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface StatementOutcome {
  result: StatementResult
  cursor?: OpenResult
  /** The statement is data-modifying (its portal must not stay open in auto-commit mode). */
  writes?: boolean
  cancelled: boolean
}

function noticeLevel(severity: string | undefined): MessageLevel {
  switch ((severity ?? '').toUpperCase()) {
    case 'WARNING':
      return 'warning'
    case 'NOTICE':
      return 'notice'
    case 'ERROR':
    case 'FATAL':
    case 'PANIC':
      return 'error'
    default:
      return 'info'
  }
}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100
}

const readOnlySql = (readOnly: boolean) => `SET SESSION CHARACTERISTICS AS TRANSACTION ${readOnly ? 'READ ONLY' : 'READ WRITE'}`

export class PostgresSession implements DriverSession {
  readonly dialect = 'postgres' as const
  readonly database: string

  private currentSchema: string | undefined
  private autoCommit = true
  private queue: Promise<unknown> = Promise.resolve()
  /** An operation of the queue is running right now. */
  private operating = false
  private openResult: OpenResult | null = null
  /** An execute/fetchMore/explain operation is in progress. */
  private busy = false
  /** A statement is running on the server right now (cancel target). */
  private inFlight = false
  private cancelRequested = false
  private pendingCancel: Promise<void> | null = null
  /** statement_timeout value to put back after an execution that set its own timeout. */
  private timeoutToRestore: string | null = null
  /** The timeout was changed inside the current transaction block (so a ROLLBACK also reverts it). */
  private timeoutSetInTransaction = false
  /** search_path chosen with setSchema (null: never changed). */
  private searchPath: string | null = null
  /** default_transaction_read_only chosen with setReadOnly (null: never changed). */
  private readOnly: boolean | null = null
  /** setSchema / setReadOnly ran inside a transaction block, where a ROLLBACK reverts them: re-apply once idle. */
  private settingsToReapply = false
  private closing = false
  private closeReported = false
  private readonly closeListeners: ((reason: string) => void)[] = []
  private messageSink: ((message: QueryMessage) => void) | null = null
  private lastTag: string | null = null
  private sawRowDescription = false
  private readonly types = new TypeNameCache()

  private constructor(
    private readonly client: pg.Client,
    private readonly connection: ResolvedConnection,
    private readonly tls: TlsSetting,
    private readonly info: ServerInfo,
    private readonly backendPid: number,
  ) {
    this.database = info.currentDatabase
    this.currentSchema = info.currentSchema
    this.attachListeners()
  }

  static async open(connection: ResolvedConnection, database: string): Promise<PostgresSession> {
    const { client, tls } = await connectClient(connection, database)
    try {
      const info = await queryServerInfo(client)
      const [pidRow] = await select(client, 'SELECT pg_backend_pid() AS pid')
      const session = new PostgresSession(client, connection, tls, info, num(pidRow ?? {}, 'pid'))
      await session.types.preload(client)
      const schema = connection.config.options.defaultSchema?.trim()
      if (schema) await session.setSchema(schema)
      return session
    } catch (error) {
      await client.end().catch(() => undefined)
      throw toDriverError(error)
    }
  }

  get schema(): string | undefined {
    return this.currentSchema
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private attachListeners(): void {
    this.client.on('notice', (notice) => {
      const message: QueryMessage = {
        level: noticeLevel(notice.severity),
        text: notice.message ?? '',
        at: Date.now(),
      }
      this.messageSink?.(message)
    })
    this.client.on('error', (error) => this.reportClose(error.message || 'Connection error'))
    this.client.on('end', () => this.reportClose('The server closed the connection'))
    const wire = this.client.connection
    wire.on('rowDescription', () => {
      this.sawRowDescription = true
    })
    wire.on('readyForQuery', (message: unknown) => {
      // Once idle, any later transaction block is a different one than the one the timeout was set in.
      if (typeof message === 'object' && message !== null && 'status' in message && message.status === 'I') {
        this.timeoutSetInTransaction = false
      }
    })
    wire.on('commandComplete', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'text' in message && typeof message.text === 'string') {
        this.lastTag = message.text
      }
    })
  }

  private reportClose(reason: string): void {
    if (this.closing || this.closeReported) return
    this.closeReported = true
    for (const listener of this.closeListeners) listener(reason)
  }

  /** Serialize operations: each runs only after the previous one settled. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.closing) throw DriverError.of('connection', 'The session is closed')
      if (this.pendingCancel) await this.pendingCancel
      this.operating = true
      try {
        return await operation()
      } finally {
        this.operating = false
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private txStatus(): 'I' | 'T' | 'E' {
    return this.client.getTransactionStatus() ?? 'I'
  }

  private async simple(text: string): Promise<void> {
    try {
      await this.client.query(text)
    } catch (error) {
      throw toDriverError(error)
    }
  }

  /** Discard the open result and restore session settings changed for the last execution. */
  private async settle(): Promise<void> {
    const open = this.openResult
    this.openResult = null
    if (open) {
      this.clearIdle(open)
      if (open.cursor) await closeCursor(open.cursor)
      open.cursor = null
    }
    await this.restoreSettings()
  }

  /** Session settings that can only be put back while no portal is open on the connection. */
  private async restoreSettings(): Promise<void> {
    await this.restoreTimeout()
    await this.reapplySettings()
  }

  /**
   * Put statement_timeout back. A value set outside the current transaction block cannot be restored
   * durably from inside it (a ROLLBACK would undo the restore): it is restored for the rest of the
   * transaction only (is_local) and for good once the session is idle again.
   */
  private async restoreTimeout(): Promise<void> {
    const value = this.timeoutToRestore
    const status = this.txStatus()
    if (value === null || status === 'E') return
    const durable = status === 'I' || this.timeoutSetInTransaction
    try {
      await select(this.client, `SELECT set_config('statement_timeout', $1, $2)`, [value, !durable])
      if (durable) this.timeoutToRestore = null
    } catch {
      // Retried before the next operation.
    }
  }

  /** Re-apply search_path / read-only after the transaction block they were set in has ended. */
  private async reapplySettings(): Promise<void> {
    if (!this.settingsToReapply || this.txStatus() !== 'I') return
    try {
      if (this.searchPath !== null) await this.client.query(`SET search_path TO ${this.searchPath}`)
      if (this.readOnly !== null) await this.client.query(readOnlySql(this.readOnly))
      this.settingsToReapply = false
    } catch {
      // Retried before the next operation.
    }
  }

  /** Run a session-level SET now; inside a transaction block (where ROLLBACK reverts it) also once idle again. */
  private async applySessionSetting(text: string): Promise<void> {
    const status = this.txStatus()
    // In an aborted transaction every command fails: the setting is applied after the ROLLBACK.
    if (status !== 'E') await this.simple(text)
    if (status !== 'I') this.settingsToReapply = true
  }

  private async applyTimeout(timeoutMs: number | undefined): Promise<void> {
    if (!timeoutMs || timeoutMs <= 0 || this.txStatus() === 'E') return
    const rows = await select(
      this.client,
      `SELECT current_setting('statement_timeout') AS prev, set_config('statement_timeout', $1, false) AS next`,
      [`${Math.round(timeoutMs)}ms`],
    )
    if (this.timeoutToRestore === null) {
      this.timeoutToRestore = str(rows[0] ?? {}, 'prev')
      this.timeoutSetInTransaction = this.txStatus() !== 'I'
    }
  }

  private async columnsFor(fields: FieldDef[], cursorStaysOpen: boolean) {
    const missing = this.types.missing(fields)
    const relations = this.types.missingRelations(fields)
    if (missing.length > 0 || relations.length > 0) {
      const resolve = async (q: Queryable) => {
        await this.types.resolve(q, missing)
        await this.types.resolveRelations(q, relations)
      }
      if (cursorStaysOpen) {
        // The session connection is busy with the open portal: resolve on a short-lived connection.
        await withClient(this.connection, this.database, this.tls, resolve).catch(() => undefined)
      } else {
        await resolve(this.client)
      }
    }
    return this.types.columns(fields)
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  execute(sql: string, options: DriverExecuteOptions): Promise<DriverExecuteResult> {
    return this.enqueue(async () => {
      await this.settle()
      const maxRows = Math.max(1, Math.floor(options.maxRows))
      const messages: QueryMessage[] = []
      const results: StatementResult[] = []
      let cancelled = false
      this.cancelRequested = false
      this.busy = true
      this.messageSink = (message) => {
        messages.push(message)
        options.onMessage?.(message)
      }
      let pending: { result: StatementResult; open: OpenResult; writes: boolean } | null = null
      try {
        const statements = splitStatements(sql, 'postgres')
        if (statements.length > 0) await this.applyTimeout(options.timeoutMs)
        for (const [index, statement] of statements.entries()) {
          if (pending) {
            // Only the last result keeps its rows: the earlier one stays truncated (hasMore without cursorId).
            if (pending.open.cursor) await closeCursor(pending.open.cursor)
            delete pending.result.cursorId
            pending = null
          }
          // A COMMIT / ROLLBACK earlier in the script may have ended the block a setting was changed in.
          await this.reapplySettings()
          // Read-only connection: an earlier statement (e.g. a function calling set_config) may have turned
          // default_transaction_read_only off; each statement is its own transaction, so re-assert it.
          if (index > 0 && this.readOnly === true && this.txStatus() === 'I') await this.simple(readOnlySql(true))
          if (this.cancelRequested) {
            cancelled = true
            break
          }
          const outcome = await this.runStatement(statement, index, maxRows)
          results.push(outcome.result)
          if (outcome.cursor) pending = { result: outcome.result, open: outcome.cursor, writes: outcome.writes === true }
          if (outcome.cancelled) {
            cancelled = true
            break
          }
          if (outcome.result.kind === 'error' && options.stopOnError !== false) break
        }
        if (pending) await this.keepResult(pending.open, pending.writes)
        else await this.settle()
        return { results, messages, cancelled }
      } finally {
        this.busy = false
        this.messageSink = null
      }
    })
  }

  private async runStatement(statement: SqlStatement, index: number, maxRows: number): Promise<StatementOutcome> {
    const started = performance.now()
    const base = { index, sql: statement.text, offset: statement.start, columns: [], rows: [] }
    const { command, readOnly } = classifyStatement(statement.text, 'postgres')
    const refuse = (error: DbErrorInfo): StatementOutcome => ({
      result: { ...base, kind: 'error', rowCount: null, hasMore: false, durationMs: 0, error },
      cancelled: false,
    })

    if (isCopyStdio(statement.text)) {
      return refuse({
        message: 'COPY FROM STDIN / TO STDOUT is not supported in the console. Use a file on the server or the export feature.',
        kind: 'invalid-input',
      })
    }

    // VACUUM, CREATE DATABASE, … CONCURRENTLY: never wrapped in the manual-commit BEGIN, and refused up front
    // inside an open block (the server would abort the user's transaction).
    const outsideBlock = noTransactionBlockCommand(statement.text)
    if (outsideBlock && this.txStatus() === 'T') {
      return refuse({
        message: `${outsideBlock} cannot run inside a transaction block. Commit or roll back the open transaction first.`,
        code: ACTIVE_SQL_TRANSACTION,
        kind: 'invalid-input',
      })
    }

    if (!this.autoCommit && !outsideBlock && this.txStatus() === 'I' && !TRANSACTION_CONTROL.has(command)) {
      await this.simple('BEGIN')
    }

    if (this.cancelRequested) {
      return { result: this.cancelledResult(base, started), cancelled: true }
    }
    // Idle before the statement: it runs in its own implicit transaction, which a suspended portal keeps open.
    const implicit = this.txStatus() === 'I'
    this.sawRowDescription = false
    this.lastTag = null
    this.inFlight = true
    const cursor = openCursor(this.client, statement.text)
    let read: { rows: RawRow[]; fields: FieldDef[] }
    try {
      read = await readCursor(cursor, maxRows + 1)
    } catch (error) {
      if (isServerError(error) && !isConnectionLevel(error)) {
        if (error.code === QUERY_CANCELED && this.cancelRequested) {
          return { result: this.cancelledResult(base, started), cancelled: true }
        }
        const result: StatementResult = {
          ...base,
          kind: 'error',
          rowCount: null,
          hasMore: false,
          durationMs: elapsed(started),
          error: serverErrorInfo(error),
        }
        return { result, cancelled: false }
      }
      throw toDriverError(error)
    } finally {
      this.inFlight = false
    }

    const rows = read.rows.map(toCellRow)
    const hasMore = rows.length > maxRows
    const tag = this.lastTag ? parseCommandTag(this.lastTag) : null

    if (!this.sawRowDescription) {
      return {
        result: {
          ...base,
          kind: 'command',
          rowCount: tag?.rowCount ?? null,
          hasMore: false,
          command: tag?.command ?? command,
          durationMs: elapsed(started),
        },
        cancelled: false,
      }
    }

    const columns = await this.columnsFor(read.fields, hasMore)
    const pageRows = hasMore ? rows.slice(0, maxRows) : rows
    const result: StatementResult = {
      ...base,
      kind: 'rows',
      columns,
      rows: pageRows,
      rowCount: pageRows.length,
      hasMore,
      command: tag?.command ?? command,
      durationMs: elapsed(started),
    }
    if (!hasMore) return { result, cancelled: false }
    const open: OpenResult = { id: randomUUID(), cursor, buffered: rows.slice(maxRows), implicit, rest: null, idleTimer: null }
    result.cursorId = open.id
    return { result, cursor: open, writes: !readOnly, cancelled: false }
  }

  /** Keep the last result for fetchMore, without letting an auto-commit portal outlive user think time. */
  private async keepResult(open: OpenResult, writes: boolean): Promise<void> {
    if (open.implicit) {
      if (writes) {
        // The change is only committed once the portal is closed: buffer the returned rows, then close it.
        await this.readAhead(open, RESULT_POLICY.writeResultRows, Number.POSITIVE_INFINITY)
        if (open.cursor) {
          await closeCursor(open.cursor)
          open.cursor = null
          open.rest = DriverError.of(
            'not-found',
            `Only the first ${RESULT_POLICY.writeResultRows.toLocaleString('en-US')} rows returned by this statement were kept. Its changes are committed.`,
          )
        }
      } else {
        await this.readAhead(open, RESULT_POLICY.readAheadRows, RESULT_POLICY.readAheadMs)
      }
    }
    this.openResult = open
    if (open.cursor) this.armIdle(open)
    else await this.restoreSettings()
  }

  /** Buffer up to `limit` rows of a live portal within `budgetMs`; a failure is kept for fetchMore to report. */
  private async readAhead(open: OpenResult, limit: number, budgetMs: number): Promise<void> {
    const started = performance.now()
    this.inFlight = true
    try {
      while (open.cursor && !this.cancelRequested && open.buffered.length < limit && performance.now() - started < budgetMs) {
        const wanted = Math.min(READ_CHUNK_ROWS, limit - open.buffered.length)
        const { rows } = await readCursor(open.cursor, wanted)
        for (const row of rows) open.buffered.push(toCellRow(row))
        // Fewer rows than asked: the statement completed and pg-cursor closed the portal (Close + Sync).
        if (rows.length < wanted) open.cursor = null
      }
    } catch (error) {
      // After an error pg-cursor has already sent Sync: the portal and its implicit transaction are gone.
      open.cursor = null
      if (isServerError(error) && !isConnectionLevel(error)) {
        open.rest =
          error.code === QUERY_CANCELED && this.cancelRequested
            ? DriverError.of('cancelled', 'Fetching was cancelled', { code: QUERY_CANCELED })
            : new DriverError(serverErrorInfo(error))
        return
      }
      throw toDriverError(error)
    } finally {
      this.inFlight = false
    }
  }

  private armIdle(open: OpenResult): void {
    this.clearIdle(open)
    if (!open.implicit || !open.cursor) return
    const timer = setTimeout(() => {
      open.idleTimer = null
      void this.releasePortal(open)
    }, RESULT_POLICY.idleReleaseMs)
    timer.unref?.()
    open.idleTimer = timer
  }

  private clearIdle(open: OpenResult): void {
    if (open.idleTimer) clearTimeout(open.idleTimer)
    open.idleTimer = null
  }

  /** Close an idle auto-commit portal: ends its implicit transaction, releasing its locks and snapshot. */
  private releasePortal(open: OpenResult): Promise<void> {
    return this.enqueue(async () => {
      // Read from (and re-armed) or discarded since the timer fired.
      if (this.openResult !== open || !open.cursor || open.idleTimer) return
      await closeCursor(open.cursor)
      open.cursor = null
      open.rest = DriverError.of(
        'not-found',
        `The rest of this result was released after ${Math.round(RESULT_POLICY.idleReleaseMs / 1000)} s without fetching, so that it does not keep locks on the tables it reads. Run the query again to load more rows.`,
      )
      await this.restoreSettings()
    }).catch(() => undefined)
  }

  private cancelledResult(
    base: Pick<StatementResult, 'index' | 'sql' | 'offset' | 'columns' | 'rows'>,
    started: number,
  ): StatementResult {
    return {
      ...base,
      kind: 'error',
      rowCount: null,
      hasMore: false,
      durationMs: elapsed(started),
      error: { message: 'Canceling statement due to user request', code: QUERY_CANCELED, kind: 'cancelled' },
    }
  }

  fetchMore(cursorId: string, count: number): Promise<FetchMoreResult> {
    return this.enqueue(async () => {
      const open = this.openResult
      if (!open || open.id !== cursorId) {
        throw DriverError.of('not-found', 'This result is no longer available. Run the query again to fetch more rows.')
      }
      this.clearIdle(open)
      const wanted = Math.max(1, Math.floor(count))
      const toRead = wanted + 1 - open.buffered.length
      if (open.cursor && toRead > 0) {
        this.busy = true
        this.cancelRequested = false
        this.inFlight = true
        try {
          const { rows } = await readCursor(open.cursor, toRead)
          for (const row of rows) open.buffered.push(toCellRow(row))
          if (rows.length < toRead) open.cursor = null
        } catch (error) {
          open.cursor = null
          this.openResult = null
          if (isServerError(error) && error.code === QUERY_CANCELED && this.cancelRequested) {
            throw DriverError.of('cancelled', 'Fetching was cancelled', { code: QUERY_CANCELED })
          }
          throw toDriverError(error)
        } finally {
          this.inFlight = false
          this.busy = false
        }
      }
      if (open.buffered.length > wanted) {
        const rows = open.buffered.slice(0, wanted)
        open.buffered = open.buffered.slice(wanted)
        this.armIdle(open)
        return { rows, hasMore: true }
      }
      const rows = open.buffered
      open.buffered = []
      if (open.rest) {
        // More rows exist but can no longer be fetched: say so on the next call rather than ending silently.
        if (rows.length > 0) return { rows, hasMore: true }
        const reason = open.rest
        await this.settle()
        throw reason
      }
      await this.settle()
      return { rows, hasMore: false }
    })
  }

  async cancel(): Promise<void> {
    if (!this.busy || this.closing) return
    this.cancelRequested = true
    if (!this.inFlight) return // between statements: the execution loop stops by itself
    await this.signalCancel()
  }

  private signalCancel(): Promise<void> {
    if (this.pendingCancel) return this.pendingCancel
    const run = this.sendCancel().finally(() => {
      this.pendingCancel = null
    })
    this.pendingCancel = run.catch(() => undefined)
    return run
  }

  /**
   * Protocol CancelRequest first (no login, works when the server is out of connection slots), then
   * pg_cancel_backend on a side connection when the server cannot be reached that way.
   */
  private async sendCancel(): Promise<void> {
    const key = backendKeyOf(this.client)
    if (key) {
      try {
        await sendCancelRequest(this.connection.host, this.connection.port, key)
        return
      } catch {
        // Fall back to pg_cancel_backend.
      }
    }
    try {
      await withClient(this.connection, this.database, this.tls, async (side) => {
        await select(side, 'SELECT pg_cancel_backend($1)', [this.backendPid])
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw DriverError.of('internal', `The statement could not be cancelled: ${reason}`)
    }
  }

  // -------------------------------------------------------------------------
  // Transactions & session settings
  // -------------------------------------------------------------------------

  transactionState(): TransactionState {
    return { autoCommit: this.autoCommit, inTransaction: this.txStatus() !== 'I' }
  }

  setAutoCommit(autoCommit: boolean): Promise<TransactionState> {
    return this.enqueue(async () => {
      if (autoCommit === this.autoCommit) return this.transactionState()
      if (autoCommit) {
        await this.settle()
        if (this.txStatus() !== 'I') {
          throw DriverError.of('invalid-input', 'Commit or roll back the open transaction first')
        }
      }
      this.autoCommit = autoCommit
      return this.transactionState()
    })
  }

  commit(): Promise<TransactionState> {
    return this.endTransaction('COMMIT')
  }

  rollback(): Promise<TransactionState> {
    return this.endTransaction('ROLLBACK')
  }

  private endTransaction(command: 'COMMIT' | 'ROLLBACK'): Promise<TransactionState> {
    return this.enqueue(async () => {
      await this.settle()
      if (this.txStatus() !== 'I') {
        await this.simple(command)
        await this.settle()
      }
      return this.transactionState()
    })
  }

  setSchema(schema: string): Promise<void> {
    return this.enqueue(async () => {
      await this.settle()
      const path = schema === 'public' ? 'public' : `${quoteIdent(schema, 'postgres')}, public`
      await this.applySessionSetting(`SET search_path TO ${path}`)
      this.searchPath = path
      this.currentSchema = schema
    })
  }

  async useDatabase(): Promise<boolean> {
    return false
  }

  setReadOnly(readOnly: boolean): Promise<void> {
    return this.enqueue(async () => {
      await this.settle()
      await this.applySessionSetting(readOnlySql(readOnly))
      this.readOnly = readOnly
      // An open transaction keeps the mode it started with: make the rest of it read-only as well.
      if (readOnly && this.txStatus() === 'T') await this.simple('SET TRANSACTION READ ONLY')
    })
  }

  async serverInfo(): Promise<ServerInfo> {
    return { ...this.info, currentSchema: this.currentSchema }
  }

  // -------------------------------------------------------------------------
  // Explain
  // -------------------------------------------------------------------------

  explain(sql: string, analyze: boolean): Promise<ExplainResult> {
    return this.enqueue(async () => {
      await this.settle()
      const statements = splitStatements(sql, 'postgres')
      const [statement] = statements
      if (!statement || statements.length !== 1) {
        throw DriverError.of('invalid-input', 'Select a single statement to explain')
      }
      const options = analyze ? 'FORMAT JSON, ANALYZE, BUFFERS, VERBOSE' : 'FORMAT JSON, VERBOSE'
      const status = this.txStatus()
      if (status === 'E') {
        throw DriverError.of('invalid-input', 'The current transaction is aborted. Roll it back before explaining a statement.')
      }
      // EXPLAIN ANALYZE really runs the statement, and even a SELECT can change data (a writing function,
      // nextval(), …): it always runs in a transaction or savepoint that is rolled back. Inside the user's
      // transaction a plain EXPLAIN uses a savepoint too, so that a failing one does not abort that transaction.
      const guard = status === 'T' ? 'savepoint' : analyze ? 'transaction' : 'none'
      if (guard === 'transaction') await this.simple('BEGIN')
      if (guard === 'savepoint') await this.simple('SAVEPOINT datagrippe_explain')
      this.busy = true
      this.cancelRequested = false
      this.inFlight = true
      try {
        const { rows } = await extendedQuery(this.client, `EXPLAIN (${options}) ${statement.text}`)
        const planText = rows[0]?.[0]
        if (typeof planText !== 'string') throw DriverError.of('internal', 'EXPLAIN returned no plan')
        return parseExplain(planText)
      } catch (error) {
        if (isServerError(error) && error.code === QUERY_CANCELED && this.cancelRequested) {
          throw DriverError.of('cancelled', 'Explain was cancelled', { code: QUERY_CANCELED })
        }
        throw toDriverError(error)
      } finally {
        this.inFlight = false
        this.busy = false
        if (guard === 'transaction') await this.simple('ROLLBACK').catch(() => undefined)
        if (guard === 'savepoint') {
          await this.simple('ROLLBACK TO SAVEPOINT datagrippe_explain').catch(() => undefined)
          await this.simple('RELEASE SAVEPOINT datagrippe_explain').catch(() => undefined)
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closing) return
    if (this.inFlight) await this.signalCancel().catch(() => undefined)
    this.closing = true
    const open = this.openResult
    this.openResult = null
    if (open) {
      this.clearIdle(open)
      // Close an auto-commit portal (Close + Sync) so its statement ends committed rather than being rolled back
      // by the disconnect — only when no operation is using the connection.
      if (open.cursor && open.implicit && !this.operating) {
        await withTimeout(closeCursor(open.cursor), CLOSE_PORTAL_TIMEOUT_MS)
      }
      open.cursor = null
    }
    await this.client.end().catch(() => undefined)
  }

  onUnexpectedClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener)
  }
}
