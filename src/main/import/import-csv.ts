// files:importCsv — stream a CSV / TSV file into a table: multi-row INSERT statements on a dedicated
// session, all inside one transaction (all-or-nothing), with progress events and cancellation.
//
// Values are sent as escape-safe literals (E'…' with doubled quotes and backslashes on PostgreSQL, N'…'
// with doubled quotes on SQL Server) because the console session contract only takes SQL text; the server
// converts them to the column types exactly as it would parameters typed as text.
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { literalKind, qualifiedName, quoteIdent } from '@shared/sql'
import type { ColumnInfo, CsvParseOptions, Dialect, ImportCsvRequest, ImportCsvResult, ImportFilePreview } from '@shared/types'
import { DriverError } from '../db/errors'
import type { SessionManager } from '../db/session-manager'
import { CsvParser, csvOptions, detectDelimiter, stripBom, type CsvRecord } from './csv'

export const IMPORT_BATCH_ROWS = 500
/** SQL Server accepts at most 1000 rows in one VALUES list. */
const MSSQL_MAX_ROWS = 1000
/** Flush a statement early once its text passes this size. */
const MAX_STATEMENT_CHARS = 2 * 1024 * 1024
const PREVIEW_BYTES = 256 * 1024
const PREVIEW_ROWS = 50

export interface ImportDeps {
  sessions: Pick<
    SessionManager,
    'openSession' | 'closeSession' | 'execute' | 'setAutoCommit' | 'commit' | 'rollback' | 'cancel' | 'dialectOf' | 'tableDetails' | 'isReadOnly'
  >
  signal?: AbortSignal
  onProgress?: (progress: { rows: number; bytesRead: number; totalBytes: number }) => void
  now?: () => number
}

type Encoding = 'utf8' | 'utf16le'

/** Text encoding from the byte order mark (UTF-8 without BOM is the default). */
function encodingOf(head: Buffer): { encoding: Encoding; bomBytes: number } {
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf16le', bomBytes: 2 }
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf8', bomBytes: 3 }
  return { encoding: 'utf8', bomBytes: 0 }
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Column names from a header record (blank / duplicate names made unique), or column_1…. */
export function headerNames(record: CsvRecord | undefined, width: number, header: boolean): string[] {
  const used = new Set<string>()
  const names: string[] = []
  for (let i = 0; i < width; i++) {
    const raw = header ? (record?.[i] ?? '').trim() : ''
    const base = raw || `column_${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`
    used.add(name.toLowerCase())
    names.push(name)
  }
  return names
}

/** First rows of a file with the detected (or given) options. */
export async function previewCsvFile(path: string, options: CsvParseOptions = {}): Promise<ImportFilePreview> {
  const info = await stat(path)
  if (!info.isFile()) throw DriverError.of('invalid-input', `${basename(path)} is not a file.`)
  const head = await readHead(path, PREVIEW_BYTES)
  const { encoding, bomBytes } = encodingOf(head)
  let text = stripBom(new StringDecoder(encoding).write(head.subarray(bomBytes)))
  // Drop a possibly cut last line (unless the whole file was read).
  if (head.length === PREVIEW_BYTES) {
    const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
    if (cut > 0) text = text.slice(0, cut)
  }
  const resolved = csvOptions({ ...options, delimiter: options.delimiter ?? detectDelimiter(text) })
  const parser = new CsvParser(resolved)
  let records: CsvRecord[]
  try {
    records = [...parser.feed(text), ...(head.length < PREVIEW_BYTES ? parser.end() : [])]
  } catch (error) {
    throw DriverError.of('invalid-input', `Cannot read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const first = resolved.header ? records[0] : undefined
  const rows = (resolved.header ? records.slice(1) : records).slice(0, PREVIEW_ROWS)
  const width = Math.max(first?.length ?? 0, ...rows.map((r) => r.length), 0)
  return {
    path,
    name: basename(path),
    sizeBytes: info.size,
    options: resolved,
    headers: headerNames(first, width, resolved.header),
    rows,
  }
}

/** Escape-safe text literal: E'…' (quotes and backslashes doubled) on PostgreSQL, N'…' on SQL Server. */
export function textLiteral(value: string, dialect: Dialect): string {
  if (dialect === 'postgres') {
    if (value.includes('\0')) throw DriverError.of('invalid-input', 'PostgreSQL text cannot contain NUL characters.')
    return `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
  }
  return `N'${value.replaceAll("'", "''")}'`
}

/** Literal for one CSV value in a column: SQL Server binary as 0x… (nvarchar → varbinary is not implicit). */
export function importLiteral(value: string | null, column: Pick<ColumnInfo, 'dataType'>, dialect: Dialect): string {
  if (value === null) return 'NULL'
  if (dialect === 'mssql' && literalKind(column.dataType, dialect) === 'binary') {
    if (/^0x[0-9a-f]*$/i.test(value) && value.length % 2 === 0) return value
    throw DriverError.of('invalid-input', `"${value.slice(0, 40)}" is not a binary value (expected 0x… hex) for a ${column.dataType} column.`)
  }
  return textLiteral(value, dialect)
}

function cancelled(): DriverError {
  return DriverError.of('cancelled', 'The import was cancelled. Nothing was inserted.')
}

export async function importCsv(req: ImportCsvRequest, deps: ImportDeps): Promise<ImportCsvResult> {
  const now = deps.now ?? (() => Date.now())
  const started = now()
  const { table } = req
  const dialect = deps.sessions.dialectOf(table.connectionId)
  if (deps.sessions.isReadOnly(table.connectionId)) {
    throw DriverError.of('read-only', 'This is a read-only connection — importing data is blocked.')
  }
  const options = csvOptions(req.options)
  if (req.mapping.length === 0) throw DriverError.of('invalid-input', 'Map at least one column to import.')

  const details = await deps.sessions.tableDetails(table.connectionId, table.database, table.schema, table.name)
  const byName = new Map(details.columns.map((c) => [c.name, c]))
  const seen = new Set<string>()
  const targets = req.mapping.map((m) => {
    const column = byName.get(m.column)
    if (!column) throw DriverError.of('invalid-input', `Column ${m.column} does not exist in ${table.schema}.${table.name}.`)
    if (column.isGenerated) throw DriverError.of('invalid-input', `Column ${m.column} is generated and cannot be imported into.`)
    if (seen.has(m.column)) throw DriverError.of('invalid-input', `Column ${m.column} is mapped twice.`)
    if (!Number.isInteger(m.source) || m.source < 0) throw DriverError.of('invalid-input', `Invalid source field for ${m.column}.`)
    seen.add(m.column)
    return { source: m.source, column }
  })

  const info = await stat(req.path)
  const totalBytes = info.size
  const head = await readHead(req.path, 4)
  const { encoding, bomBytes } = encodingOf(head)

  const maxRows = Math.max(1, Math.min(Math.floor(req.batchSize ?? IMPORT_BATCH_ROWS), dialect === 'mssql' ? MSSQL_MAX_ROWS : 10_000))
  const prefix = `INSERT INTO ${qualifiedName(table.schema, table.name, dialect)} (${targets.map((t) => quoteIdent(t.column.name, dialect)).join(', ')}) VALUES\n`
  const signal = deps.signal
  if (signal?.aborted) throw cancelled()

  const session = await deps.sessions.openSession({ connectionId: table.connectionId, database: table.database })
  const onAbort = () => void deps.sessions.cancel(session.sessionId).catch(() => undefined)
  signal?.addEventListener('abort', onAbort)
  const stream = createReadStream(req.path, { start: bomBytes })
  let committed = false
  let inserted = 0
  let line = options.header ? 1 : 0
  try {
    await deps.sessions.setAutoCommit(session.sessionId, false)
    const parser = new CsvParser({ ...options, skipLines: options.skipLines + (options.header ? 1 : 0) })
    const decoder = new StringDecoder(encoding)
    let tuples: string[] = []
    let chars = prefix.length

    const flush = async (): Promise<void> => {
      if (tuples.length === 0) return
      if (signal?.aborted) throw cancelled()
      const sql = prefix + tuples.join(',\n')
      const count = tuples.length
      tuples = []
      chars = prefix.length
      const execution = await deps.sessions.execute(session.sessionId, sql, { maxRows: 1, stopOnError: true }, { history: false })
      if (signal?.aborted || execution.cancelled) throw cancelled()
      const failed = execution.results.find((r) => r.kind === 'error')
      if (failed) {
        const first = inserted + 1
        throw new DriverError({
          kind: 'database',
          ...failed.error,
          message: `Rows ${first}–${first + count - 1} could not be inserted: ${failed.error?.message ?? 'the statement failed'}`,
        })
      }
      inserted += count
      deps.onProgress?.({ rows: inserted, bytesRead: Math.min(totalBytes, stream.bytesRead + bomBytes), totalBytes })
    }

    const add = async (records: CsvRecord[]): Promise<void> => {
      for (const record of records) {
        line++
        let tuple: string
        try {
          tuple = `(${targets.map((t) => importLiteral(record[t.source] ?? null, t.column, dialect)).join(', ')})`
        } catch (error) {
          if (error instanceof DriverError) throw DriverError.of('invalid-input', `Line ${line}: ${error.info.message}`)
          throw error
        }
        tuples.push(tuple)
        chars += tuple.length + 2
        if (tuples.length >= maxRows || chars >= MAX_STATEMENT_CHARS) await flush()
      }
    }

    for await (const chunk of stream) {
      if (signal?.aborted) throw cancelled()
      const text = decoder.write(chunk as Buffer)
      let records: CsvRecord[]
      try {
        records = parser.feed(text)
      } catch (error) {
        throw DriverError.of('invalid-input', error instanceof Error ? error.message : String(error))
      }
      await add(records)
    }
    let tail: CsvRecord[]
    try {
      tail = [...parser.feed(decoder.end()), ...parser.end()]
    } catch (error) {
      throw DriverError.of('invalid-input', error instanceof Error ? error.message : String(error))
    }
    await add(tail)
    await flush()
    if (signal?.aborted) throw cancelled()
    await deps.sessions.commit(session.sessionId)
    committed = true
    return { rows: inserted, durationMs: Math.max(0, Math.round(now() - started)) }
  } catch (error) {
    throw signal?.aborted ? cancelled() : error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stream.destroy()
    if (!committed) await deps.sessions.rollback(session.sessionId).catch(() => undefined)
    await deps.sessions.closeSession(session.sessionId).catch(() => undefined)
  }
}
