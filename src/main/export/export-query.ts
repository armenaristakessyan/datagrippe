// files:exportQuery — run one statement on a temporary session and stream every row to a file.
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { splitStatements } from '@shared/sql'
import type { ExportQueryRequest, ExportResult } from '@shared/types'
import { DriverError } from '../db/errors'
import type { SessionManager } from '../db/session-manager'
import { createFormatter, EXPORT_FORMATS, type FileExportFormat } from './format'

export const EXPORT_BATCH_SIZE = 5000

export interface ExportDeps {
  sessions: Pick<SessionManager, 'openSession' | 'closeSession' | 'execute' | 'fetchMore' | 'dialectOf' | 'setSchema' | 'cancel'>
  /** Ask where to write; null when the user cancels. */
  chooseFile: (defaultName: string, format: FileExportFormat) => Promise<string | null>
  batchSize?: number
  /** Aborting stops the export: the running query is cancelled and the partial file removed. */
  signal?: AbortSignal
  /** Rows written so far (called after each batch). */
  onProgress?: (rows: number) => void
}

/** Running exports by caller-chosen id, so `files:cancelExport` can stop them. */
export { OperationRegistry as ExportRegistry } from '../operations'

const cancelledError = () => DriverError.of('cancelled', 'The export was cancelled.')

class FileSink {
  private readonly stream: WriteStream
  private error: Error | null = null

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: 'utf8' })
    this.stream.on('error', (error) => {
      this.error = error
    })
  }

  async write(chunk: string): Promise<void> {
    if (this.error) throw this.error
    if (!chunk) return
    // once() rejects when 'error' fires first and removes its listeners either way (no listener leak).
    if (!this.stream.write(chunk)) await once(this.stream, 'drain')
  }

  async finish(): Promise<void> {
    if (this.error) throw this.error
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject)
      this.stream.end(() => resolve())
    })
  }

  /** Abort and wait until the file descriptor is released (so the file can be removed). */
  async destroy(): Promise<void> {
    if (this.stream.closed) return
    const closed = once(this.stream, 'close').catch(() => undefined)
    this.stream.destroy()
    await closed
  }
}

export async function exportQuery(req: ExportQueryRequest, deps: ExportDeps): Promise<ExportResult> {
  if (!EXPORT_FORMATS.includes(req.format)) throw DriverError.of('invalid-input', `Unsupported export format: ${String(req.format)}`)
  const dialect = deps.sessions.dialectOf(req.connectionId)
  const units = splitStatements(req.sql, dialect)
  if (units.length === 0) throw DriverError.of('invalid-input', 'There is no statement to export.')
  if (units.length > 1) throw DriverError.of('invalid-input', 'Export runs a single statement — select one query and try again.')

  const path = await deps.chooseFile(req.defaultName, req.format)
  if (!path) return { path: null, rows: 0 }

  const { signal } = deps
  const checkCancelled = () => {
    if (signal?.aborted) throw cancelledError()
  }
  checkCancelled()
  const batch = deps.batchSize ?? EXPORT_BATCH_SIZE
  const session = await deps.sessions.openSession({ connectionId: req.connectionId, database: req.database })
  const onAbort = () => void deps.sessions.cancel(session.sessionId).catch(() => undefined)
  signal?.addEventListener('abort', onAbort)
  let sink: FileSink | null = null
  try {
    // Same name resolution as the console the query comes from (search_path on PostgreSQL).
    if (req.schema) await deps.sessions.setSchema(session.sessionId, req.schema)
    checkCancelled()
    const execution = await deps.sessions.execute(session.sessionId, req.sql, { maxRows: batch, stopOnError: true }, { history: false })
    checkCancelled()
    if (execution.cancelled) throw cancelledError()
    const failed = execution.results.find((r) => r.kind === 'error')
    if (failed) throw new DriverError({ kind: 'database', ...failed.error, message: failed.error?.message ?? 'The query failed.' })
    const result = execution.results[execution.results.length - 1]
    if (!result || result.kind !== 'rows') throw DriverError.of('invalid-input', 'The statement returned no rows to export.')
    if (execution.results.filter((r) => r.kind === 'rows').length > 1) {
      throw DriverError.of('invalid-input', 'The statement returned several result sets; export one query at a time.')
    }

    if (result.hasMore && !result.cursorId) {
      throw DriverError.of('internal', `The result was truncated after ${result.rows.length} rows and the remaining rows cannot be fetched.`)
    }

    const formatter = createFormatter(req.format, result.columns, { dialect, tableName: req.tableName })
    sink = new FileSink(path)
    await sink.write(formatter.begin())
    await sink.write(formatter.rows(result.rows))
    let rows = result.rows.length
    deps.onProgress?.(rows)
    let hasMore = result.hasMore
    while (hasMore) {
      checkCancelled()
      if (!result.cursorId) {
        throw DriverError.of('internal', `The result was truncated after ${rows} rows and the remaining rows cannot be fetched.`)
      }
      const more = await deps.sessions.fetchMore(session.sessionId, result.cursorId, batch).catch((error: unknown) => {
        throw signal?.aborted ? cancelledError() : error
      })
      checkCancelled()
      await sink.write(formatter.rows(more.rows))
      rows += more.rows.length
      deps.onProgress?.(rows)
      hasMore = more.hasMore && more.rows.length > 0
    }
    checkCancelled()
    await sink.write(formatter.end())
    await sink.finish()
    return { path, rows }
  } catch (error) {
    if (sink) {
      await sink.destroy()
      await unlink(path).catch(() => undefined)
    }
    throw signal?.aborted ? cancelledError() : error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await deps.sessions.closeSession(session.sessionId).catch(() => undefined)
  }
}
