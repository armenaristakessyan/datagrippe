// "Import data from CSV…": pick a CSV / TSV file, adjust parsing, map its columns to the table's,
// and insert every record in one transaction (all-or-nothing) with progress and cancel.
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileUp, Upload } from 'lucide-react'
import { create } from 'zustand'
import type { ColumnInfo, CsvParseOptions, DbErrorInfo, ImportFilePreview, TableRef } from '@shared/types'
import { qualifiedName } from '@shared/sql'
import { Button, Callout, Dialog, Field, Input, NumberInput, ProgressBar, Select, Switch, toast } from '@/components/ui'
import { ApiError, call, errorInfo, onEvent } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes, pluralize } from '@/lib/format'
import { uid } from '@/lib/id'
import { connectionById } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useTabs, type TableTab } from '@/stores/tabs'
import { ErrorDetail } from './ErrorDetail'
import { loadPage } from './table-actions'

interface ImportState {
  request?: { table: TableRef; preview: ImportFilePreview; key: string }
  close: () => void
}

const useImport = create<ImportState>((set) => ({
  close: () => set({ request: undefined }),
}))

/** Choose a file for `table` and open the import dialog (nothing happens when the picker is cancelled). */
export async function importCsvInto(table: TableRef): Promise<void> {
  const connection = connectionById(table.connectionId)
  if (connection?.readOnly) {
    toast.error('This connection is read-only', undefined, { description: 'Turn off Read-only in the connection settings to import data.' })
    return
  }
  try {
    const preview = await call('files:pickImportFile')
    if (!preview) return
    useImport.setState({ request: { table, preview, key: uid('import') } })
  } catch (error) {
    toast.error('Could not read the file', error)
  }
}

const DELIMITERS = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
] as const
type DelimiterChoice = ',' | ';' | '\t' | '|' | 'custom'

const SKIP = '__skip__'
const PREVIEW_ROWS = 8

/** Target column for each source column: same name (case-insensitive), else skipped. */
export function autoMapping(headers: readonly string[], columns: readonly Pick<ColumnInfo, 'name'>[]): string[] {
  const used = new Set<string>()
  return headers.map((header) => {
    const match = columns.find((c) => c.name.toLowerCase() === header.trim().toLowerCase() && !used.has(c.name))
    if (!match) return SKIP
    used.add(match.name)
    return match.name
  })
}

export function ImportCsvDialog() {
  const request = useImport((s) => s.request)
  if (!request) return null
  return <ImportSession key={request.key} table={request.table} initial={request.preview} />
}

type Phase = { kind: 'edit' } | { kind: 'running'; importId: string; rows: number; fraction?: number } | { kind: 'failed'; error: DbErrorInfo }

function ImportSession({ table, initial }: { table: TableRef; initial: ImportFilePreview }) {
  const close = useImport((s) => s.close)
  const [open, setOpen] = useState(true)
  const [preview, setPreview] = useState(initial)
  const [options, setOptions] = useState<Required<CsvParseOptions>>(initial.options)
  const [delimiterChoice, setDelimiterChoice] = useState<DelimiterChoice>(() =>
    DELIMITERS.some((d) => d.value === initial.options.delimiter) ? (initial.options.delimiter as DelimiterChoice) : 'custom',
  )
  const [previewError, setPreviewError] = useState<DbErrorInfo>()
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [columnsError, setColumnsError] = useState<DbErrorInfo>()
  const [mapping, setMapping] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' })
  const importRef = useRef<HTMLButtonElement>(null)
  const dialect = connectionById(table.connectionId)?.dialect ?? 'postgres'
  const target = qualifiedName(table.schema, table.name, dialect)

  // Target columns (generated ones cannot be written).
  useEffect(() => {
    let live = true
    call('meta:tableDetails', table.connectionId, table.database, table.schema, table.name)
      .then((details) => live && setColumns(details.columns.filter((c) => !c.isGenerated)))
      .catch((error: unknown) => live && setColumnsError(errorInfo(error)))
    return () => {
      live = false
    }
  }, [table])

  // Auto-map whenever the source columns or the target columns change.
  const headersKey = preview.headers.join('\u0000')
  useEffect(() => {
    if (columns) setMapping(autoMapping(preview.headers, columns))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headersKey, columns])

  // Re-read the preview when the parsing options change.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    let live = true
    const timer = setTimeout(() => {
      call('files:previewImport', preview.path, options)
        .then((next) => {
          if (!live) return
          setPreview(next)
          setPreviewError(undefined)
        })
        .catch((error: unknown) => live && setPreviewError(errorInfo(error)))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options])

  const mapped = mapping.map((column, source) => ({ source, column })).filter((m) => m.column !== SKIP)
  const duplicate = useMemo(() => {
    const seen = new Set<string>()
    for (const m of mapped) {
      if (seen.has(m.column)) return m.column
      seen.add(m.column)
    }
    return undefined
  }, [mapped])
  const running = phase.kind === 'running'
  const canImport = !running && mapped.length > 0 && !duplicate && !previewError && columns !== null

  const dismiss = () => {
    if (running) return
    setOpen(false)
    setTimeout(close, 160)
  }

  const run = async () => {
    const importId = uid('import')
    setPhase({ kind: 'running', importId, rows: 0 })
    const off = onEvent('event:importProgress', (p) => {
      if (p.importId !== importId) return
      setPhase({ kind: 'running', importId, rows: p.rows, fraction: p.totalBytes > 0 ? Math.min(1, p.bytesRead / p.totalBytes) : undefined })
    })
    try {
      const result = await call('files:importCsv', { importId, table, path: preview.path, options, mapping: mapped })
      off()
      toast.success(`Imported ${pluralize(result.rows, 'row')} into ${table.name}`)
      refreshTable(table)
      setOpen(false)
      setTimeout(close, 160)
    } catch (error) {
      off()
      if (error instanceof ApiError && error.info.kind === 'cancelled') {
        toast.message('Import cancelled', { description: 'Nothing was inserted.' })
        setPhase({ kind: 'edit' })
        return
      }
      setPhase({ kind: 'failed', error: errorInfo(error) })
    }
  }

  const setOption = (patch: Partial<CsvParseOptions>) => setOptions((o) => ({ ...o, ...patch }))
  const targetOptions = [
    { value: SKIP, label: 'Skip' },
    ...(columns ?? []).map((c) => ({ value: c.name, label: c.name, hint: c.dataType })),
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && dismiss()}
      size="xl"
      icon={FileUp}
      title={`Import into ${target}`}
      description={`${preview.name} · ${formatBytes(preview.sizeBytes)} · all rows are inserted in one transaction.`}
      modalLock={running}
      onOpenAutoFocus={(e) => {
        // Land on the primary action: the detected settings usually just work.
        e.preventDefault()
        importRef.current?.focus()
      }}
      footer={
        running ? (
          <>
            <span className="mr-auto text-xs text-muted tabular">{pluralize(phase.rows, 'row')} inserted…</span>
            <Button variant="ghost" onClick={() => void call('files:cancelImport', phase.importId).catch(() => undefined)}>
              Cancel import
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto text-xs text-subtle">
              {duplicate ? <span className="text-danger">{duplicate} is mapped twice.</span> : `${pluralize(mapped.length, 'column')} mapped`}
            </span>
            <Button variant="ghost" onClick={dismiss}>
              Cancel
            </Button>
            <Button ref={importRef} variant="primary" leadingIcon={Upload} disabled={!canImport} onClick={() => void run()}>
              Import
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {running && <ProgressBar value={phase.fraction} label="Importing" />}
        {phase.kind === 'failed' && (
          <Callout tone="danger" title={phase.error.message}>
            <ErrorDetail error={phase.error} showMessage={false} showPosition={false} />
          </Callout>
        )}

        <fieldset disabled={running} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_96px_minmax(0,1fr)] items-start gap-3">
          <Field label="Delimiter" htmlFor="imp-delimiter">
            <div className="flex gap-2">
              <Select<DelimiterChoice>
                id="imp-delimiter"
                value={delimiterChoice}
                onValueChange={(choice) => {
                  setDelimiterChoice(choice)
                  if (choice !== 'custom') setOption({ delimiter: choice })
                }}
                options={[...DELIMITERS.map((d) => ({ value: d.value as DelimiterChoice, label: d.label })), { value: 'custom', label: 'Other…' }]}
                className="min-w-0 flex-1"
              />
              {delimiterChoice === 'custom' && (
                <Input
                  aria-label="Custom delimiter"
                  mono
                  maxLength={1}
                  value={options.delimiter}
                  onChange={(e) => e.target.value.length === 1 && setOption({ delimiter: e.target.value })}
                  wrapperClassName="w-12"
                />
              )}
            </div>
          </Field>
          <Field label="NULL text" htmlFor="imp-null">
            <Input id="imp-null" mono value={options.nullText} placeholder="empty field" onChange={(e) => setOption({ nullText: e.target.value })} />
          </Field>
          <Field label="Skip lines" htmlFor="imp-skip">
            <NumberInput id="imp-skip" value={options.skipLines} min={0} max={1000} onValueChange={(v) => setOption({ skipLines: v ?? 0 })} />
          </Field>
          <Field label="Header">
            <div className="flex h-7 items-center">
              <Switch checked={options.header} onCheckedChange={(header) => setOption({ header })} label="First line" size="sm" />
            </div>
          </Field>
        </fieldset>

        {previewError && (
          <Callout tone="danger" title="Could not read the file with these settings">
            {previewError.message}
          </Callout>
        )}
        {columnsError && (
          <Callout tone="danger" title="Could not load the table's columns">
            {columnsError.message}
          </Callout>
        )}

        <div className="overflow-hidden rounded-lg border border-line">
          <div className="max-h-[340px] overflow-auto">
            <table className="w-max min-w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr>
                  {preview.headers.map((header, i) => (
                    <th key={i} className="border-b border-r border-line px-2 py-1.5 text-left align-top font-normal last:border-r-0">
                      <div className="mb-1 truncate font-mono text-2xs text-subtle" title={header}>
                        {header}
                      </div>
                      <Select
                        size="sm"
                        aria-label={`Target column for ${header}`}
                        disabled={running || columns === null}
                        value={mapping[i] ?? SKIP}
                        onValueChange={(value) => setMapping((m) => m.map((v, j) => (j === i ? value : v)))}
                        options={targetOptions}
                        className={cn('w-40', (mapping[i] ?? SKIP) === SKIP && 'text-subtle')}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, PREVIEW_ROWS).map((row, r) => (
                  <tr key={r} className="border-b border-line last:border-b-0">
                    {preview.headers.map((_, i) => {
                      const value = row[i]
                      const skipped = (mapping[i] ?? SKIP) === SKIP
                      return (
                        <td
                          key={i}
                          className={cn('max-w-48 truncate border-r border-line px-2 py-1 font-mono last:border-r-0', skipped && 'opacity-40')}
                          title={value ?? 'NULL'}
                        >
                          {value === null || value === undefined ? <span className="italic text-grid-null">NULL</span> : value}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {preview.rows.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(1, preview.headers.length)} className="px-3 py-4 text-center text-subtle">
                      No rows to import with these settings.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <p className="text-2xs text-subtle">
          Showing the first {Math.min(PREVIEW_ROWS, preview.rows.length)} rows. Unmapped table columns get their default value.
        </p>
      </div>
    </Dialog>
  )
}

/** Reload open data tabs of the table and its row estimate. */
function refreshTable(table: TableRef): void {
  void useExplorer.getState().loadDetails(table.connectionId, table.database, table.schema, table.name, true)
  for (const tab of useTabs.getState().tabs) {
    if (tab.kind !== 'table') continue
    const t = tab as TableTab
    if (t.connectionId === table.connectionId && t.database === table.database && t.table.schema === table.schema && t.table.name === table.name) {
      void loadPage(t, {}, true)
    }
  }
}
