// Export side effects of the results panel: clipboard copies, "Save as…" of the loaded rows and
// "Export all rows" (re-runs the statement in main and streams every row to a file).
import type { ColumnMeta, CellValue, Dialect, ExportFormat } from '@shared/types'
import { toast } from '@/components/ui'
import { api, errorInfo, onEvent } from '@/lib/api'
import { uid } from '@/lib/id'
import { copyText } from '@/lib/clipboard'
import { EXPORT_FORMAT_META, formatRows } from '@/lib/export-format'
import { formatBytes, pluralize } from '@/lib/format'
import { isMac } from '@/lib/platform'

export interface ExportSource {
  columns: ColumnMeta[]
  rows: CellValue[][]
  dialect: Dialect
  tableName?: string
  /** File name without extension. */
  baseName: string
}

const revealLabel = () => (isMac() ? 'Reveal in Finder' : 'Show in folder')

function reveal(path: string) {
  void api.app.showItemInFolder(path).catch((error: unknown) => toast.error('Could not open the folder', error))
}

/** Clipboard text above this many characters (≈ 100 MB) is refused: Save / Export stream it instead. */
export const CLIPBOARD_CHAR_LIMIT = 50_000_000
/** "Save rows as…" builds the file in memory and sends it to main in one message. */
export const SAVE_CHAR_LIMIT = 300_000_000
/** Above this size the work shows a loading toast first. */
const SLOW_CHAR_COUNT = 2_000_000
/** Pretty-printed JSON on the clipboard up to this size, compact beyond. */
const PRETTY_JSON_CHAR_LIMIT = 10_000_000
const SAMPLE_ROWS = 200

/**
 * Size of the serialization, extrapolated from an evenly spread sample of rows (cheap: the full text
 * is only built once it is known to be reasonable).
 */
export function estimateChars(format: ExportFormat, source: Pick<ExportSource, 'columns' | 'rows' | 'dialect' | 'tableName'>, jsonIndent?: number): number {
  const n = source.rows.length
  if (n === 0) return 0
  const step = Math.max(1, Math.floor(n / SAMPLE_ROWS))
  const sample: CellValue[][] = []
  for (let i = 0; i < n && sample.length < SAMPLE_ROWS; i += step) sample.push(source.rows[i]!)
  const text = formatRows(format, source.columns, sample, { tableName: source.tableName, dialect: source.dialect, jsonIndent })
  return Math.ceil((text.length / sample.length) * n)
}

/** Let the loading toast paint before a long synchronous serialization. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0))
    else setTimeout(resolve, 0)
  })
}

/** "≈ 340 MB" — UTF-8 size of a text of `chars` characters (mostly ASCII). */
function approxSize(chars: number): string {
  return `≈ ${formatBytes(chars)}`
}

export async function copyAllAs(format: ExportFormat, source: ExportSource): Promise<void> {
  const label = EXPORT_FORMAT_META[format].label
  let estimate = estimateChars(format, source)
  let jsonIndent: number | undefined
  if (format === 'json' && estimate > PRETTY_JSON_CHAR_LIMIT) {
    // large JSON goes compact: no indentation repeated on every line
    jsonIndent = 0
    estimate = estimateChars(format, source, 0)
  }
  if (estimate > CLIPBOARD_CHAR_LIMIT) {
    toast.warning('Too large for the clipboard', {
      description: `${pluralize(source.rows.length, 'row')} as ${label} is ${approxSize(estimate)}. Use Save rows as… or Export all rows instead.`,
      duration: 8000,
    })
    return
  }
  const id = estimate > SLOW_CHAR_COUNT ? toast.loading(`Copying ${pluralize(source.rows.length, 'row')} as ${label}…`) : undefined
  try {
    if (id !== undefined) await nextPaint()
    await copyText(formatRows(format, source.columns, source.rows, { tableName: source.tableName, dialect: source.dialect, jsonIndent }))
    toast.success(`Copied ${pluralize(source.rows.length, 'row')} as ${label}`, { id, duration: 2000, description: jsonIndent === 0 ? 'Compact JSON (large result).' : undefined })
  } catch (error) {
    toast.error('Could not copy', error, { id })
  }
}

export async function saveLoadedRows(format: ExportFormat, source: ExportSource): Promise<void> {
  const meta = EXPORT_FORMAT_META[format]
  const estimate = estimateChars(format, source)
  if (estimate > SAVE_CHAR_LIMIT) {
    toast.warning('Too large to save from the grid', {
      description: `${pluralize(source.rows.length, 'row')} as ${meta.label} is ${approxSize(estimate)}. Use Export all rows, which streams the file.`,
      duration: 8000,
    })
    return
  }
  const id = estimate > SLOW_CHAR_COUNT ? toast.loading(`Preparing ${pluralize(source.rows.length, 'row')} as ${meta.label}…`) : undefined
  try {
    if (id !== undefined) await nextPaint()
    const content = formatRows(format, source.columns, source.rows, { tableName: source.tableName, dialect: source.dialect })
    if (id !== undefined) toast.dismiss(id)
    const path = await api.files.saveText({
      defaultName: `${source.baseName}.${meta.extension}`,
      content,
      filters: [{ name: meta.filterName, extensions: [meta.extension] }],
    })
    if (!path) return
    toast.success(`Saved ${pluralize(source.rows.length, 'row')}`, {
      description: path,
      action: { label: revealLabel(), onClick: () => reveal(path) },
    })
  } catch (error) {
    toast.error('Could not save the file', error, { id })
  }
}

export interface ExportAllRequest {
  connectionId: string
  database?: string
  schema?: string
  sql: string
  format: Exclude<ExportFormat, 'markdown'>
  tableName?: string
  baseName: string
}

export async function exportAllRows(req: ExportAllRequest): Promise<void> {
  const meta = EXPORT_FORMAT_META[req.format]
  const exportId = uid('export')
  const title = `Exporting all rows as ${meta.label}…`
  const cancel = { label: 'Cancel', onClick: () => void api.files.cancelExport(exportId).catch(() => undefined) }
  const id = toast.loading(title, { description: 'The statement runs again on a separate session.', action: cancel })
  const offProgress = onEvent('event:exportProgress', (p) => {
    if (p.exportId !== exportId) return
    toast.loading(title, { id, description: `${pluralize(p.rows, 'row')} written`, action: cancel })
  })
  try {
    const result = await api.files.exportQuery({
      connectionId: req.connectionId,
      database: req.database,
      schema: req.schema,
      exportId,
      sql: req.sql,
      format: req.format,
      tableName: req.tableName,
      defaultName: `${req.baseName}.${meta.extension}`,
    })
    offProgress()
    if (!result.path) {
      toast.dismiss(id)
      return
    }
    const path = result.path
    toast.success(`Exported ${pluralize(result.rows, 'row')}`, {
      id,
      description: path,
      action: { label: revealLabel(), onClick: () => reveal(path) },
    })
  } catch (error) {
    offProgress()
    if (errorInfo(error).kind === 'cancelled') toast.message('Export cancelled', { id, description: 'The partial file was removed.' })
    else toast.error('Export failed', error, { id })
  }
}
