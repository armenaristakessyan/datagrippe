// DriverSession for SQL Server: one dedicated tedious connection, operations serialized.
//
// Large results: the first `maxRows` rows of a single query are read, then the statement is stopped
// (attention) so the server releases it — a paused stream would keep its Sch-S / page locks and
// block other sessions' DDL and writes for as long as the result stays on screen. "Load more"
// re-runs the query, skips the rows already shown (checking they are unchanged) and reads the next
// page the same way.

import { createHash, randomUUID, type Hash } from 'node:crypto'
import type { Connection } from 'tedious'
import { classifyStatement, splitStatements, splitStatementsFine, type SqlStatement } from '@shared/sql'
import { isSignificant, tokenize } from '@shared/sql/lexer'
import type {
  CellValue,
  ExplainResult,
  FetchMoreResult,
  QueryMessage,
  ServerInfo,
  StatementResult,
  TransactionState,
} from '@shared/types'
import { DriverError } from '../errors'
import type { DriverExecuteOptions, DriverExecuteResult, DriverSession, ResolvedConnection } from '../types'
import { BatchRequest, type BatchEvent, type MessageSink, type RecordsetEvent } from './batch-request'
import { resolveOptions } from './config'
import { closeConnection, openConnection } from './connection'
import type { SqlErrorFields } from './error-mapping'
import { parseShowplan } from './showplan'
import { isSingleReadOnlyQuery } from './single-query'

export const SERVER_INFO_SQL = `SELECT @@VERSION, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), DB_NAME(), SUSER_SNAME(), SCHEMA_NAME()`
const STATE_SQL = 'SELECT @@TRANCOUNT, DB_NAME(), @@OPTIONS & 2, @@OPTIONS & 16384'
const SHOWPLAN_COLUMN = /XML Showplan/i
const DML_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE'])
/** SET options that would switch plan-only mode off (or on) in the middle of an explain. */
const PLAN_OPTIONS = new Set(['SHOWPLAN_XML', 'SHOWPLAN_TEXT', 'SHOWPLAN_ALL', 'NOEXEC', 'PARSEONLY', 'FMTONLY'])
const CHANGED_RESULT =
  'The result changed since its first rows were read (the data was modified, or the query has no stable ORDER BY). Run the query again to load more rows.'

/** Server message with its place in the stream: the number of results of the execution before it. */
export interface OrderedQueryMessage extends QueryMessage {
  resultsBefore?: number
}

export function serverInfoFromRow(row: CellValue[] | undefined): ServerInfo {
  const text = (value: CellValue | undefined): string => (value === null || value === undefined ? '' : String(value))
  const info: ServerInfo = {
    dialect: 'mssql',
    version: text(row?.[0]).replace(/\s+/g, ' ').trim(),
    versionShort: text(row?.[1]),
    currentDatabase: text(row?.[2]),
    currentUser: text(row?.[3]),
  }
  const schema = text(row?.[4])
  if (schema) info.currentSchema = schema
  return info
}

/** Routes connection-level INFO / ERROR tokens to the request currently running. */
export interface MessageRouter {
  active?: MessageSink
}

/** Run `sql` on `connection` (no session) and return its recordsets; throws DriverError on SQL errors. */
export async function queryOnce(connection: Connection, sink: MessageRouter, sql: string): Promise<CellValue[][][]> {
  const request = new BatchRequest(connection, sql, { rowLimit: () => Number.POSITIVE_INFINITY })
  sink.active = request
  try {
    request.start()
    await request.settled
  } finally {
    sink.active = undefined
  }
  return recordsetsOrThrow(request)
}

function recordsetsOrThrow(request: BatchRequest): CellValue[][][] {
  if (request.fatal) throw request.fatal
  if (request.cancelled) throw DriverError.of('cancelled', 'Statement cancelled')
  const error = request.events.find((event) => event.kind === 'error')
  if (error) throw new DriverError(error.error)
  return request.events.flatMap((event) => (event.kind === 'rows' ? [event.rows] : []))
}

/** Forward connection-level INFO / ERROR tokens to whatever request is running. */
export function attachMessageRouting(connection: Connection, sink: MessageRouter): void {
  connection.on('infoMessage', (token: SqlErrorFields) => sink.active?.onInfoMessage(token))
  connection.on('errorMessage', (token: SqlErrorFields) => sink.active?.onErrorMessage(token))
}

/** First SET option that toggles plan-only mode (SET SHOWPLAN_XML OFF…), outside strings and comments. */
export function planOptionToggle(sql: string): string | undefined {
  const tokens = tokenize(sql, 'mssql').filter(isSignificant)
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.upper !== 'SET') continue
    // SET a, b, c ON|OFF
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j]
      if (!token) break
      if (token.kind === 'word' && PLAN_OPTIONS.has(token.upper)) return token.upper
      if (token.kind === 'word' && token.upper === 'STATISTICS') {
        const next = tokens[j + 1]
        if (next?.kind === 'word' && (next.upper === 'XML' || next.upper === 'PROFILE')) return `STATISTICS ${next.upper}`
      }
      const comma = token.kind === 'punct' && sql[token.start] === ','
      if (token.kind !== 'word' && !comma) break
      if (token.kind === 'word' && (token.upper === 'ON' || token.upper === 'OFF')) break
    }
  }
  return undefined
}

function rowKey(row: CellValue[]): string {
  return `${JSON.stringify(row)}\n`
}

function firstRecordset(request: BatchRequest): RecordsetEvent | undefined {
  const event = request.events[0]
  return event?.kind === 'rows' ? event : undefined
}

function bracket(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`
}

/** A partially read result: enough to re-run its query and continue after the rows already shown. */
interface OpenCursor {
  id: string
  sql: string
  /** Rows handed out so far. */
  delivered: number
  /** Running hash of the delivered rows, to check that a re-run returns the same prefix. */
  hash: Hash
  timeoutMs?: number
}

export class MssqlSession implements DriverSession {
  readonly dialect = 'mssql' as const

  private currentDatabase: string
  private currentSchema: string | undefined
  private readonly info: ServerInfo
  private autoCommit = true
  private inTransaction = false
  private xactAbort = false
  private cursor: OpenCursor | undefined
  private running: BatchRequest | undefined
  private cancelRequested = false
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private closeNotified = false
  private readonly closeListeners: ((reason: string) => void)[] = []

  private constructor(
    private readonly connection: Connection,
    private readonly router: MessageRouter,
    info: ServerInfo,
    schemaHint: string | undefined,
  ) {
    this.info = info
    this.currentDatabase = info.currentDatabase
    this.currentSchema = schemaHint ?? info.currentSchema
    connection.on('databaseChange', (name: string) => {
      this.currentDatabase = name
    })
    connection.on('end', () => this.notifyClose('The connection to the server was closed'))
    connection.on('error', (error: Error) => this.notifyClose(error.message))
  }

  static async open(resolved: ResolvedConnection, database: string): Promise<MssqlSession> {
    const options = await resolveOptions(resolved, database || undefined)
    const connection = await openConnection(options)
    const router: MessageRouter = {}
    attachMessageRouting(connection, router)
    // tedious emits 'error' for socket failures; never leave it without a listener.
    connection.on('error', () => undefined)
    try {
      const [info] = await queryOnce(connection, router, SERVER_INFO_SQL)
      const schemaHint = resolved.config.options.defaultSchema?.trim() || undefined
      const session = new MssqlSession(connection, router, serverInfoFromRow(info?.[0]), schemaHint)
      await session.refreshState()
      return session
    } catch (error) {
      await closeConnection(connection)
      throw error
    }
  }

  get database(): string {
    return this.currentDatabase
  }

  get schema(): string | undefined {
    return this.currentSchema
  }

  async serverInfo(): Promise<ServerInfo> {
    const info: ServerInfo = { ...this.info, currentDatabase: this.currentDatabase }
    if (this.currentSchema) info.currentSchema = this.currentSchema
    return info
  }

  transactionState(): TransactionState {
    return { autoCommit: this.autoCommit, inTransaction: this.inTransaction }
  }

  onUnexpectedClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener)
  }

  execute(sql: string, options: DriverExecuteOptions): Promise<DriverExecuteResult> {
    return this.enqueue(async () => {
      this.abandonCursor()
      this.cancelRequested = false
      const batches = splitStatements(sql, 'mssql')
      const results: StatementResult[] = []
      const messages: QueryMessage[] = []
      const onInfo = (message: QueryMessage, position: number): void => {
        const ordered: OrderedQueryMessage = { ...message, resultsBefore: results.length + position }
        messages.push(ordered)
        options.onMessage?.(ordered)
      }
      const maxRows = options.maxRows > 0 ? options.maxRows : Number.POSITIVE_INFINITY
      const stopOnError = options.stopOnError !== false
      let cancelled = false
      let ran = false

      outer: for (let b = 0; b < batches.length; b++) {
        const batch = batches[b]
        if (!batch) continue
        const repeat = Math.max(1, batch.repeat ?? 1)
        for (let r = 0; r < repeat; r++) {
          const lastRun = b === batches.length - 1 && r === repeat - 1
          const paged = lastRun && Number.isFinite(maxRows) && isSingleReadOnlyQuery(batch.text)
          // Earlier batches may have opened a transaction or changed XACT_ABORT.
          if (paged && ran) await this.refreshState()
          const request = new BatchRequest(this.connection, batch.text, {
            rowLimit: () => maxRows,
            window: paged ? { skip: 0, take: maxRows, stopEarly: this.canStopEarly() } : undefined,
            timeoutMs: options.timeoutMs,
            onInfo,
          })
          await this.run(request)
          ran = true

          let cursorId: string | undefined
          const recordset = paged ? firstRecordset(request) : undefined
          if (recordset?.hasMore && !request.fatal && !request.cancelled && !request.events.some((e) => e.kind === 'error')) {
            cursorId = randomUUID()
            const hash = createHash('sha1')
            for (const row of recordset.rows) hash.update(rowKey(row))
            this.cursor = { id: cursorId, sql: batch.text, delivered: recordset.rows.length, hash, timeoutMs: options.timeoutMs }
          }
          results.push(...this.toResults(request.events, batch, request.startedAt, results.length, cursorId))
          if (request.fatal) break outer
          if (request.cancelled || this.cancelRequested) {
            cancelled = true
            break outer
          }
          if (stopOnError && request.events.some((event) => event.kind === 'error')) break outer
        }
      }

      await this.refreshState()
      return { results, messages, cancelled }
    })
  }

  fetchMore(cursorId: string, count: number): Promise<FetchMoreResult> {
    return this.enqueue(async () => {
      const cursor = this.cursor
      if (!cursor || cursor.id !== cursorId) {
        throw DriverError.of('not-found', 'This result set is no longer open; run the query again to fetch more rows')
      }
      this.cancelRequested = false
      const take = Math.max(1, Math.floor(count))
      const skippedHash = createHash('sha1')
      const request = new BatchRequest(this.connection, cursor.sql, {
        rowLimit: () => take,
        window: {
          skip: cursor.delivered,
          take,
          stopEarly: this.canStopEarly(),
          onSkipped: (row) => skippedHash.update(rowKey(row)),
        },
        timeoutMs: cursor.timeoutMs,
      })
      try {
        await this.run(request)
      } finally {
        await this.refreshState()
      }
      if (request.fatal) {
        this.abandonCursor()
        throw request.fatal
      }
      // Cancelled: the result stays as it is and can be fetched again.
      if (request.cancelled || this.cancelRequested) throw DriverError.of('cancelled', 'Statement cancelled')
      const error = request.events.find((event) => event.kind === 'error')
      if (error) {
        this.abandonCursor()
        throw new DriverError(error.error)
      }
      const recordset = firstRecordset(request)
      if (!recordset || request.skipped !== cursor.delivered || skippedHash.digest('hex') !== cursor.hash.copy().digest('hex')) {
        this.abandonCursor()
        throw DriverError.of('invalid-input', CHANGED_RESULT)
      }
      for (const row of recordset.rows) cursor.hash.update(rowKey(row))
      cursor.delivered += recordset.rows.length
      if (!recordset.hasMore) this.abandonCursor()
      return { rows: recordset.rows, hasMore: recordset.hasMore }
    })
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true
    const request = this.running
    if (request && !request.finished) request.cancel()
  }

  setAutoCommit(autoCommit: boolean): Promise<TransactionState> {
    return this.enqueue(async () => {
      this.abandonCursor()
      await this.refreshState()
      if (autoCommit && this.inTransaction) {
        throw DriverError.of('invalid-input', 'Commit or roll back the open transaction before enabling auto-commit')
      }
      await this.internal(`SET IMPLICIT_TRANSACTIONS ${autoCommit ? 'OFF' : 'ON'}`)
      await this.refreshState()
      return this.transactionState()
    })
  }

  commit(): Promise<TransactionState> {
    return this.endTransaction('IF @@TRANCOUNT > 0 COMMIT TRANSACTION')
  }

  rollback(): Promise<TransactionState> {
    return this.endTransaction('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
  }

  async setSchema(schema: string): Promise<void> {
    this.currentSchema = schema
  }

  useDatabase(database: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.abandonCursor()
      await this.internal(`USE ${bracket(database)}`)
      await this.refreshState()
      return true
    })
  }

  explain(sql: string, analyze: boolean): Promise<ExplainResult> {
    return this.enqueue(async () => {
      this.abandonCursor()
      this.cancelRequested = false
      const batches = splitStatements(sql, 'mssql')
      if (batches.length === 0) throw DriverError.of('invalid-input', 'Nothing to explain')
      const toggle = batches.map((batch) => planOptionToggle(batch.text)).find(Boolean)
      if (toggle) {
        throw DriverError.of('invalid-input', `Explain cannot run a script that changes SET ${toggle}; remove that statement and try again`)
      }
      const documents: string[] = []
      try {
        if (analyze) await this.explainAnalyze(batches, documents)
        else await this.explainEstimated(batches, documents)
      } finally {
        await this.refreshState()
      }
      if (documents.length === 0) throw DriverError.of('invalid-input', 'SQL Server returned no execution plan for this statement')
      return parseShowplan(documents)
    })
  }

  async setReadOnly(): Promise<void> {
    // The session manager blocks writes on read-only connections.
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.cursor = undefined
    await closeConnection(this.connection)
  }

  // -------------------------------------------------------------------------

  private async explainEstimated(batches: SqlStatement[], documents: string[]): Promise<void> {
    // Nothing runs under SHOWPLAN_XML, except a batch that turns it off: the batches after it would
    // really execute (writes included, read-only connection or not).
    await this.internal('SET SHOWPLAN_XML ON')
    try {
      for (const batch of batches) documents.push(...(await this.collectShowplans(batch.text)))
    } finally {
      await this.internal('SET SHOWPLAN_XML OFF')
    }
  }

  private async explainAnalyze(batches: SqlStatement[], documents: string[]): Promise<void> {
    await this.refreshState()
    const readOnly = batches.every((batch) => classifyStatement(batch.text, 'mssql').readOnly)
    const wrap = !readOnly && !this.inTransaction
    if (wrap) await this.internal('BEGIN TRANSACTION')
    try {
      await this.internal('SET STATISTICS XML ON')
      try {
        for (const batch of batches) documents.push(...(await this.collectShowplans(batch.text)))
      } finally {
        await this.internal('SET STATISTICS XML OFF')
      }
    } finally {
      if (wrap) await this.internal('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
    }
  }

  /** Run a batch keeping only showplan recordsets; throws on SQL errors. */
  private async collectShowplans(sql: string): Promise<string[]> {
    const request = new BatchRequest(this.connection, sql, {
      rowLimit: (columns) =>
        columns.length === 1 && SHOWPLAN_COLUMN.test(columns[0]?.name ?? '') ? Number.POSITIVE_INFINITY : 0,
    })
    await this.run(request)
    const recordsets = recordsetsOrThrow(request)
    return recordsets.flatMap((rows) => rows.flatMap((row) => (typeof row[0] === 'string' ? [row[0]] : [])))
  }

  private endTransaction(sql: string): Promise<TransactionState> {
    return this.enqueue(async () => {
      this.abandonCursor()
      await this.internal(sql)
      await this.refreshState()
      return this.transactionState()
    })
  }

  private toResults(
    events: BatchEvent[],
    batch: SqlStatement,
    startedAt: number,
    firstIndex: number,
    cursorId: string | undefined,
  ): StatementResult[] {
    const base = { sql: batch.text, offset: batch.start }
    const counts = events.filter((event) => event.kind === 'count').length
    const batchCommand = classifyStatement(batch.text, 'mssql').command
    let dml: string[] = []
    if (counts > 0) {
      dml = splitStatementsFine(batch.text, 'mssql')
        .map((statement) => classifyStatement(statement.text, 'mssql').command)
        .filter((command) => DML_COMMANDS.has(command))
      if (dml.length !== counts) dml = []
    }

    const results: StatementResult[] = []
    let previous = startedAt
    let countIndex = 0
    for (const event of events) {
      const durationMs = Math.max(0, Math.round((event.endedAt - previous) * 100) / 100)
      previous = event.endedAt
      const index = firstIndex + results.length
      if (event.kind === 'rows') {
        const result: StatementResult = {
          ...base,
          index,
          kind: 'rows',
          columns: event.columns,
          rows: event.rows.slice(),
          rowCount: event.rows.length,
          hasMore: event.hasMore,
          command: 'SELECT',
          durationMs,
        }
        if (cursorId && event.hasMore) result.cursorId = cursorId
        results.push(result)
      } else if (event.kind === 'count') {
        results.push({
          ...base,
          index,
          kind: 'command',
          columns: [],
          rows: [],
          rowCount: event.rowCount,
          hasMore: false,
          // The DONE token names the statement type; the statement list is a fallback.
          command: event.command ?? dml[countIndex] ?? batchCommand,
          durationMs,
        })
        countIndex += 1
      } else {
        results.push({
          ...base,
          index,
          kind: 'error',
          columns: [],
          rows: [],
          rowCount: null,
          hasMore: false,
          command: batchCommand,
          durationMs,
          error: event.error,
        })
      }
    }
    if (results.length === 0) {
      results.push({
        ...base,
        index: firstIndex,
        kind: 'command',
        columns: [],
        rows: [],
        rowCount: null,
        hasMore: false,
        command: batchCommand,
        durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100),
      })
    }
    return results
  }

  private async run(request: BatchRequest): Promise<void> {
    if (this.closed) throw DriverError.of('connection', 'The session is closed')
    this.running = request
    this.router.active = request
    try {
      request.start()
      await request.settled
    } finally {
      this.running = undefined
      this.router.active = undefined
    }
  }

  /**
   * Stopping a statement early sends an attention, and under XACT_ABORT ON an attention rolls back
   * the open transaction: then the rest of the result is read and discarded instead.
   */
  private canStopEarly(): boolean {
    return !(this.inTransaction && this.xactAbort)
  }

  /** Internal statement: SQL errors throw, messages are ignored. */
  private async internal(sql: string): Promise<CellValue[][][]> {
    const request = new BatchRequest(this.connection, sql, { rowLimit: () => Number.POSITIVE_INFINITY })
    await this.run(request)
    return recordsetsOrThrow(request)
  }

  private async refreshState(): Promise<void> {
    if (this.closed) return
    try {
      const [rows] = await this.internal(STATE_SQL)
      const row = rows?.[0]
      if (!row) return
      this.inTransaction = Number(row[0]) > 0
      if (typeof row[1] === 'string') this.currentDatabase = row[1]
      this.autoCommit = Number(row[2]) === 0
      this.xactAbort = Number(row[3]) !== 0
    } catch {
      // Keep the last known state (e.g. the state query itself was cancelled).
    }
  }

  /** Forget the partially read result (nothing runs on the server for it). */
  private abandonCursor(): void {
    this.cursor = undefined
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.closed) throw DriverError.of('connection', 'The session is closed')
      return task()
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  private notifyClose(reason: string): void {
    if (this.closed || this.closeNotified) return
    this.closeNotified = true
    this.closed = true
    for (const listener of this.closeListeners) {
      try {
        listener(reason)
      } catch {
        // listeners must not break the driver
      }
    }
  }
}

