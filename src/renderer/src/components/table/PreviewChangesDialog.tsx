import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, FileCode2, RotateCcw, SquareTerminal, Upload } from 'lucide-react'
import type { DbErrorInfo } from '@shared/types'
import { Button, Callout, CodeBlock, Dialog, SkeletonLines } from '@/components/ui'
import { errorInfo } from '@/lib/api'
import { pluralize } from '@/lib/format'
import type { TableTab } from '@/stores/tabs'
import { ErrorDetail } from './ErrorDetail'
import { openSqlInConsole, previewChanges } from './table-actions'

type PreviewState = { status: 'loading' } | { status: 'ready'; statements: string[] } | { status: 'error'; error: DbErrorInfo }

export interface PreviewChangesDialogProps {
  tab: TableTab
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Summary line, e.g. "2 updates, 1 insert". */
  summary: string
  count: number
  submitting: boolean
  onSubmit: () => void
}

/** SQL that Submit would run (literals inlined), rendered by the driver without executing it. */
export function PreviewChangesDialog({ tab, open, onOpenChange, summary, count, submitting, onSubmit }: PreviewChangesDialogProps) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    setState({ status: 'loading' })
    previewChanges(tab)
      .then((statements) => setState({ status: 'ready', statements }))
      .catch((error: unknown) => setState({ status: 'error', error: errorInfo(error) }))
  }, [tab])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const sql = state.status === 'ready' ? state.statements.join('\n') : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      icon={FileCode2}
      tone="accent"
      title="Preview changes"
      description={`${summary || 'No changes'} on ${tab.table.schema}.${tab.table.name} — applied in a single transaction.`}
      footer={
        <>
          <Button
            variant="ghost"
            leadingIcon={copied ? Check : Copy}
            disabled={state.status !== 'ready' || !sql}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy SQL'}
          </Button>
          <Button
            variant="ghost"
            leadingIcon={SquareTerminal}
            disabled={state.status !== 'ready' || !sql}
            onClick={() => {
              openSqlInConsole(tab, sql)
              onOpenChange(false)
            }}
          >
            Open in console
          </Button>
          <div className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            leadingIcon={Upload}
            loading={submitting}
            disabled={count === 0}
            onClick={() => {
              onOpenChange(false)
              onSubmit()
            }}
          >
            Submit {pluralize(count, 'change')}
          </Button>
        </>
      }
    >
      {state.status === 'loading' && (
        <div className="rounded-lg border border-line bg-surface p-3">
          <SkeletonLines count={4} />
        </div>
      )}
      {state.status === 'error' && (
        <Callout
          tone="danger"
          title="Could not render the SQL"
          actions={
            <Button size="xs" leadingIcon={RotateCcw} onClick={load}>
              Retry
            </Button>
          }
        >
          <ErrorDetail error={state.error} />
        </Callout>
      )}
      {state.status === 'ready' &&
        (state.statements.length === 0 ? (
          <p className="text-xs text-subtle">Nothing to submit.</p>
        ) : (
          <CodeBlock code={sql} maxHeight="min(52vh, 440px)" wrap={false} />
        ))}
    </Dialog>
  )
}
