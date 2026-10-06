// A failed statement: message, SQLSTATE / error number, detail, hint, the failing line with a caret,
// the statement, and actions (show in editor, copy, re-run).
import { Copy, Crosshair, RotateCw } from 'lucide-react'
import type { DbErrorInfo, Dialect } from '@shared/types'
import { Badge, Button, Callout, CodeBlock, toast } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { errorLocation, errorReport, severityLabel } from './result-meta'

export interface ErrorResultViewProps {
  error: DbErrorInfo
  /** Failing statement; absent for failures before execution (connection, read-only guard…). */
  sql?: string
  dialect?: Dialect
  /** Select the error range in the editor (offsets inside `sql`). */
  onShowInEditor?: (start: number, end: number) => void
  onRetry?: () => void
  retryLabel?: string
}

export function ErrorResultView({ error, sql, dialect, onShowInEditor, onRetry, retryLabel = 'Run again' }: ErrorResultViewProps) {
  const location = sql ? errorLocation(sql, error) : null
  const copy = async () => {
    try {
      await copyText(errorReport(error, sql, dialect))
      toast.success('Error copied', { duration: 1600 })
    } catch (e) {
      toast.error('Could not copy', e)
    }
  }

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        <Callout
          tone="danger"
          title={<span className="selectable">{error.message}</span>}
          actions={
            <>
              {location && onShowInEditor && (
                <Button size="xs" variant="secondary" leadingIcon={Crosshair} onClick={() => onShowInEditor(location.start, location.end)}>
                  Show in editor
                </Button>
              )}
              <Button size="xs" variant="ghost" leadingIcon={Copy} onClick={() => void copy()}>
                Copy error
              </Button>
              {onRetry && (
                <Button size="xs" variant="ghost" leadingIcon={RotateCw} onClick={onRetry}>
                  {retryLabel}
                </Button>
              )}
            </>
          }
        >
          {(error.code || error.severity || location) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {error.code && (
                <Badge tone="danger" mono>
                  {dialect === 'mssql' ? `Msg ${error.code}` : `SQLSTATE ${error.code}`}
                </Badge>
              )}
              {error.severity && <Badge mono>{severityLabel(error.severity)}</Badge>}
              {location && (
                <Badge mono>
                  Line {location.line}, col {location.column}
                </Badge>
              )}
            </div>
          )}
          {error.detail && (
            <p className="selectable mt-1.5 whitespace-pre-wrap">
              <span className="font-medium text-fg">Detail </span>
              {error.detail}
            </p>
          )}
          {error.hint && (
            <p className="selectable mt-1 whitespace-pre-wrap">
              <span className="font-medium text-fg">Hint </span>
              {error.hint}
            </p>
          )}
          {error.context && (
            <p className="selectable mt-1 whitespace-pre-wrap">
              <span className="font-medium text-fg">Context </span>
              <span className="font-mono text-2xs">{error.context}</span>
            </p>
          )}
        </Callout>

        {location && location.lineText.trim() !== '' && (
          <div className="overflow-x-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs leading-[18px]">
            <div className="flex whitespace-pre text-fg">
              <span className="mr-3 select-none text-faint tabular">{location.line}</span>
              <span className="selectable">{location.lineText}</span>
            </div>
            {error.position !== undefined && (
              <div className="flex whitespace-pre text-danger" aria-hidden>
                <span className="mr-3 select-none text-transparent tabular">{location.line}</span>
                {/* the line's own text, invisible, so the caret lines up whatever the glyph widths (tabs, emoji, CJK) */}
                <span className="invisible">{location.lineText.slice(0, location.caretOffset)}</span>
                <span>{'^'.repeat(Math.max(1, Math.min([...location.lineText.slice(location.caretOffset, location.caretOffset + (location.end - location.start))].length, 80)))}</span>
              </div>
            )}
          </div>
        )}

        {sql && (
          <div className="flex flex-col gap-1.5">
            <span className="text-2xs font-medium uppercase tracking-wider text-subtle">Statement</span>
            <CodeBlock code={sql} maxHeight={220} />
          </div>
        )}
      </div>
    </div>
  )
}
