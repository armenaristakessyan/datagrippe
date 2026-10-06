// One T-SQL batch sent as a single tedious request, its token stream turned into recordsets,
// row counts and errors. Optionally reads only a window of the (single) recordset, then stops it.

import type { Connection, Request } from 'tedious'
import type { CellValue, ColumnMeta, DbErrorInfo, QueryMessage } from '@shared/types'
import { DriverError } from '../errors'
import { sqlErrorInfo, toDriverError, type SqlErrorFields } from './error-mapping'
import { DONE_CUR_CMD, tedious } from './tedious-runtime'
import { normalizeValue, typeInfoFromTedious, type SqlTypeInfo, type TediousColumnLike } from './values'

interface ColumnLike extends TediousColumnLike {
  colName: string
  flags: number
}

export interface RecordsetEvent {
  kind: 'rows'
  columns: ColumnMeta[]
  types: SqlTypeInfo[]
  rows: CellValue[][]
  /** More rows existed than were kept. */
  hasMore: boolean
  /** performance.now() when the recordset completed. */
  endedAt: number
}

export interface CountEvent {
  kind: 'count'
  rowCount: number
  /** TDS CurCmd of the DONE token (statement type), when tedious exposed it. */
  command?: string
  endedAt: number
}

export interface ErrorEvent {
  kind: 'error'
  error: DbErrorInfo
  endedAt: number
}

export type BatchEvent = RecordsetEvent | CountEvent | ErrorEvent

/**
 * Read a window of the FIRST recordset: rows [0, skip) go to `onSkipped`, rows [skip, skip + take)
 * are kept, the next one only sets `hasMore`. Then the request is cancelled (`stopEarly`) so the
 * server releases the statement and its locks, or drained (when an attention would roll back the
 * open transaction under XACT_ABORT ON). Only valid for a batch holding a single query.
 */
export interface RowWindow {
  skip: number
  take: number
  stopEarly: boolean
  onSkipped?: (row: CellValue[]) => void
}

export interface BatchRequestOptions {
  /** Rows kept per recordset; rows beyond are read and discarded (hasMore is set). */
  rowLimit: (columns: ColumnMeta[]) => number
  /** Window over the first recordset (single-query batches only); overrides rowLimit for it. */
  window?: RowWindow
  /** Total time allowed for the request (0 / undefined: none). */
  timeoutMs?: number
  /** Server message; `position` is the number of events recorded before it (stream order). */
  onInfo?: (message: QueryMessage, position: number) => void
}

/** Messages and errors arrive on the connection; the session forwards them to the active request. */
export interface MessageSink {
  onInfoMessage(token: SqlErrorFields): void
  onErrorMessage(token: SqlErrorFields): void
}

function isColumnArray(value: unknown): value is ColumnLike[] {
  return Array.isArray(value)
}

function rowValues(columns: unknown): unknown[] {
  if (!Array.isArray(columns)) return []
  return columns.map((column: unknown) =>
    typeof column === 'object' && column !== null && 'value' in column ? (column as { value: unknown }).value : null,
  )
}

/** FOR JSON / FOR XML output: one column with this name, split over rows of ≤ 2033 characters. */
const FOR_JSON_XML_COLUMN = /^(?:JSON|XML)_F52E2B61-18A1-11d1-B105-00805F49916B$/i

/** TDS DONE token CurCmd values (the statement type that produced the row count). */
const DONE_COMMANDS: Record<number, string> = {
  0xc1: 'SELECT',
  0xc3: 'INSERT',
  0xc4: 'DELETE',
  0xc5: 'UPDATE',
  0x117: 'MERGE',
}

interface OpenRecordset {
  event: RecordsetEvent
  /** Index of the recordset in the batch (0-based). */
  index: number
  /** FOR JSON / FOR XML fragments, joined into one value when the recordset ends. */
  fragments?: string[]
  /** Rows seen so far (kept, skipped or discarded). */
  seen: number
}

export class BatchRequest implements MessageSink {
  readonly events: BatchEvent[] = []
  readonly request: Request
  readonly startedAt = performance.now()
  cancelled = false
  timedOut = false
  /** Connection-level failure (socket closed…); the session is unusable afterwards. */
  fatal: DriverError | undefined
  /** The request has completed (tedious callback fired). */
  finished = false
  /** Rows of the first recordset handed to `window.onSkipped`. */
  skipped = 0
  /** The request was cancelled by us once the window was full (not a user cancel). */
  stoppedEarly = false

  /** Resolves when the request completes. */
  readonly settled: Promise<void>

  private current: OpenRecordset | undefined
  private recordsetCount = 0
  private resolveSettled!: () => void
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly connection: Connection,
    sql: string,
    private readonly options: BatchRequestOptions,
  ) {
    this.settled = new Promise((resolve) => (this.resolveSettled = resolve))
    this.request = new tedious.Request(sql, (error) => this.onComplete(error ?? undefined))
    this.request.on('columnMetadata', (columns) => this.onColumns(columns))
    this.request.on('row', (columns: unknown) => this.onRow(columns))
    this.request.on('done', (rowCount) => this.onDone(rowCount))
    this.request.on('doneInProc', (rowCount) => this.onDone(rowCount))
  }

  /** Send the batch. */
  start(): void {
    const { timeoutMs } = this.options
    if (timeoutMs && timeoutMs > 0) {
      this.timer = setTimeout(() => {
        if (this.finished || this.stoppedEarly) return
        this.timedOut = true
        this.connection.cancel()
      }, timeoutMs)
    }
    this.connection.execSqlBatch(this.request)
  }

  cancel(): void {
    if (this.finished) return
    if (this.connection.request === this.request) this.connection.cancel()
    else this.request.cancel()
  }

  onInfoMessage(token: SqlErrorFields): void {
    this.options.onInfo?.({ level: 'info', text: token.message, at: Date.now() }, this.events.length)
  }

  onErrorMessage(token: SqlErrorFields): void {
    if (this.cancelled || this.request.canceled) return
    const error = sqlErrorInfo(token, this.sql)
    const current = this.current
    if (current && current.event.rows.length === 0 && current.seen === 0) {
      // A statement that failed right after describing its columns produced no usable recordset.
      this.events.splice(this.events.indexOf(current.event), 1)
      this.current = undefined
    }
    this.events.push({ kind: 'error', error, endedAt: performance.now() })
  }

  private get sql(): string {
    return this.request.sqlTextOrProcedure ?? ''
  }

  private onColumns(columns: unknown): void {
    if (!isColumnArray(columns)) return
    this.finishRecordset()
    const types = columns.map(typeInfoFromTedious)
    const meta: ColumnMeta[] = columns.map((column, i) => ({
      name: column.colName,
      dataType: types[i]?.name ?? column.type.name.toLowerCase(),
      nullable: (column.flags & 0x01) === 0x01,
    }))
    const event: RecordsetEvent = { kind: 'rows', columns: meta, types, rows: [], hasMore: false, endedAt: performance.now() }
    const open: OpenRecordset = { event, index: this.recordsetCount, seen: 0 }
    if (columns.length === 1 && FOR_JSON_XML_COLUMN.test(columns[0]?.colName ?? '')) open.fragments = []
    this.recordsetCount += 1
    this.current = open
    this.events.push(event)
  }

  private onRow(columns: unknown): void {
    const open = this.current
    if (!open || this.stoppedEarly) return
    const { event } = open
    const position = open.seen
    open.seen += 1
    const normalize = (): CellValue[] =>
      rowValues(columns).map((value, i) => normalizeValue(value, event.types[i] ?? { name: '' }))

    if (open.fragments) {
      // Never cut a FOR JSON / FOR XML document: it is one value, whatever the row limit.
      const [fragment] = normalize()
      if (fragment !== null && fragment !== undefined) open.fragments.push(String(fragment))
      return
    }

    const window = open.index === 0 ? this.options.window : undefined
    if (window) {
      if (position < window.skip) {
        this.skipped += 1
        window.onSkipped?.(normalize())
        return
      }
      if (position < window.skip + window.take) {
        event.rows.push(normalize())
        return
      }
      event.hasMore = true
      if (window.stopEarly) this.stopEarly()
      return
    }

    if (event.rows.length < this.options.rowLimit(event.columns)) event.rows.push(normalize())
    else event.hasMore = true
  }

  /** The window is full: stop the statement so the server releases it (and its locks). */
  private stopEarly(): void {
    this.stoppedEarly = true
    this.finishRecordset()
    this.clearTimer()
    this.cancel()
  }

  private onDone(rowCount: number | undefined): void {
    if (this.stoppedEarly) return
    if (this.current) {
      this.finishRecordset()
      return
    }
    if (rowCount !== undefined) {
      const count: CountEvent = { kind: 'count', rowCount, endedAt: performance.now() }
      const command = doneCommand(this.request)
      if (command) count.command = command
      this.events.push(count)
    }
  }

  private finishRecordset(): void {
    const open = this.current
    if (!open) return
    if (open.fragments) open.event.rows = open.fragments.length > 0 ? [[open.fragments.join('')]] : []
    open.event.endedAt = performance.now()
    this.current = undefined
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private onComplete(error: Error | undefined): void {
    this.finishRecordset()
    this.clearTimer()
    this.finished = true
    if (error) {
      const code = (error as Error & { code?: unknown }).code
      if (code === 'ECANCEL') {
        if (this.stoppedEarly) {
          // Our own attention once the window was full: a normal end.
        } else if (this.timedOut) {
          this.events.push({
            kind: 'error',
            error: {
              message: `Query timed out after ${this.options.timeoutMs ?? 0} ms`,
              code: 'ETIMEOUT',
              kind: 'database',
            },
            endedAt: performance.now(),
          })
        } else {
          this.cancelled = true
        }
      } else if (!this.isSqlError(error)) {
        this.fatal = toDriverError(error)
        this.events.push({ kind: 'error', error: this.fatal.info, endedAt: performance.now() })
      }
    }
    this.resolveSettled()
  }

  /** SQL errors were already reported through 'errorMessage'. */
  private isSqlError(error: Error): boolean {
    if (error instanceof AggregateError) return true
    const number = (error as Error & { number?: unknown }).number
    if (typeof number === 'number') return true
    const code = (error as Error & { code?: unknown }).code
    return code === 'EREQUEST' && this.events.some((event) => event.kind === 'error')
  }
}

function doneCommand(request: Request): string | undefined {
  const curCmd = (request as unknown as Record<symbol, unknown>)[DONE_CUR_CMD]
  return typeof curCmd === 'number' ? DONE_COMMANDS[curCmd] : undefined
}
