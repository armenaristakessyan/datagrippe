// Right-side value panel of the grid: the full value of the active cell (JSON / XML pretty-printed
// and coloured, long text wrapped and selectable), its size and type, copy, and — when the cell is
// editable — a textarea with Apply / Set NULL.
import { useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Copy, MousePointerClick, X } from 'lucide-react'
import type { CellValue, ColumnMeta } from '@shared/types'
import { Button, EmptyState, IconButton, SegmentedControl, toast } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import { formatBytes, formatCount } from '@/lib/format'
import {
  looksLikeJson,
  looksLikeXml,
  prettyJson,
  prettyXml,
  sameValue,
  tokenizeJson,
  tokenizeXml,
  valueText,
  type CodeToken,
  type CodeTokenType,
} from './cell-format'
import { binaryLength, type ColumnKind } from './column-types'

/** Characters laid out in the viewer; copying always takes the full value. */
const VIEW_CAP = 200_000

const TOKEN_CLASS: Record<CodeTokenType, string> = {
  key: 'text-syn-function',
  string: 'text-syn-string',
  number: 'text-syn-number',
  literal: 'text-syn-keyword',
  punct: 'text-muted',
  tag: 'text-syn-keyword',
  attr: 'text-syn-function',
  comment: 'text-syn-comment italic',
  text: 'text-fg',
}

export interface CellInspectorProps {
  column?: ColumnMeta
  kind: ColumnKind
  /** Undefined when there is no active cell. */
  value: CellValue | undefined
  /** Row number shown in the header (as in the grid gutter). */
  rowNumber?: number
  /** Identity of the cell (row key + column): a different cell resets the editor draft. */
  cellKey?: string
  editable: boolean
  nullDisplay: string
  width: number
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  onClose: () => void
  onApply: (value: CellValue) => void
}

type Structured = 'json' | 'xml' | null

function structuredKind(value: CellValue | undefined, kind: ColumnKind): Structured {
  if (typeof value !== 'string') return null
  if (kind === 'json' || looksLikeJson(value)) return prettyJson(value) !== null ? 'json' : null
  if (kind === 'xml' || looksLikeXml(value)) return 'xml'
  return null
}

export function CellInspector({ column, kind, value, rowNumber, cellKey, editable, nullDisplay, width, onResizeStart, onClose, onApply }: CellInspectorProps) {
  const text = value === undefined ? '' : valueText(value)
  // Values too large to lay out are shown raw (first VIEW_CAP characters): no Pretty view for them.
  const tooLarge = text.length > VIEW_CAP
  const structured = tooLarge ? null : structuredKind(value, kind)
  const structuredType = tooLarge && typeof value === 'string' ? (kind === 'json' ? 'json' : kind === 'xml' ? 'xml' : null) : structured
  const [mode, setMode] = useState<'pretty' | 'raw'>('pretty')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (value === undefined || value === null) return
    try {
      await copyText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      toast.error('Could not copy', error)
    }
  }

  const meta =
    value === undefined || value === null
      ? null
      : kind === 'binary' && typeof value === 'string'
        ? formatBytes(binaryLength(value))
        : typeof value === 'string'
          ? `${formatCount(value.length)} char${value.length === 1 ? '' : 's'}`
          : null

  return (
    <aside
      aria-label="Value inspector"
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-panel"
      style={{ width }}
    >
      <div
        aria-hidden
        onPointerDown={onResizeStart}
        className="absolute -left-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize after:absolute after:inset-y-0 after:left-[2px] after:w-px after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-100"
      />
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate font-mono text-xs font-medium text-fg">{column?.name ?? 'Value'}</span>
          {column && <span className="truncate font-mono text-2xs text-subtle">{column.dataType}</span>}
        </div>
        {rowNumber !== undefined && <span className="shrink-0 text-2xs text-subtle tabular">Row {formatCount(rowNumber)}</span>}
        <IconButton icon={X} size="xs" label="Close inspector" shortcut="Space" onClick={onClose} />
      </header>

      {value === undefined ? (
        <EmptyState size="compact" icon={MousePointerClick} title="No cell selected" description="Select a cell to see its full value." />
      ) : editable ? (
        <InspectorEditor key={`${cellKey ?? `${column?.name}:${rowNumber}`}:${text}:${value === null}`} value={value} structured={structured} onApply={onApply} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {value === null ? (
            <div className="flex h-full items-center justify-center">
              <span className="font-mono text-xs italic text-grid-null">{nullDisplay}</span>
            </div>
          ) : typeof value === 'boolean' ? (
            <div className="p-3">
              <span className={cn('inline-flex h-5 items-center rounded px-1.5 font-mono text-xs', value ? 'bg-accent-soft text-accent' : 'bg-active text-muted')}>
                {String(value)}
              </span>
            </div>
          ) : (
            <ValueView text={text} structured={mode === 'pretty' ? structured : null} breakAll={kind === 'binary'} />
          )}
        </div>
      )}

      {value !== undefined && (
        <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-line pl-3 pr-1.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-subtle tabular">
            {value === null ? 'NULL' : (meta ?? typeof value)}
            {structuredType && ` · ${structuredType.toUpperCase()}`}
            {tooLarge && structuredType && ' · too large to format, shown raw'}
          </span>
          {structured && !editable && (
            <SegmentedControl
              size="xs"
              aria-label="Display"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'pretty', label: 'Pretty' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
          )}
          <Button
            size="xs"
            variant="ghost"
            leadingIcon={copied ? <Check size={13} strokeWidth={2.25} className="text-success" /> : Copy}
            disabled={value === null}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </footer>
      )}
    </aside>
  )
}

function ValueView({ text, structured, breakAll }: { text: string; structured: Structured; breakAll: boolean }) {
  const capped = text.length > VIEW_CAP
  const shown = capped ? text.slice(0, VIEW_CAP) : text
  const tokens = useMemo<CodeToken[] | null>(() => {
    if (!structured || capped) return null
    if (structured === 'json') {
      const pretty = prettyJson(shown)
      return pretty ? tokenizeJson(pretty) : null
    }
    return tokenizeXml(prettyXml(shown))
  }, [structured, shown, capped])

  return (
    <div className="p-3">
      <pre
        className={cn(
          'selectable whitespace-pre-wrap font-mono text-xs leading-[18px] text-fg',
          breakAll ? 'break-all' : '[overflow-wrap:anywhere]',
        )}
      >
        {tokens
          ? tokens.map((t, i) => (
              <span key={i} className={TOKEN_CLASS[t.type]}>
                {t.text}
              </span>
            ))
          : shown}
      </pre>
      {capped && (
        <p className="mt-2 text-2xs text-subtle">
          Showing the first {formatCount(VIEW_CAP)} characters. Copy to get the whole value.
        </p>
      )}
    </div>
  )
}

function InspectorEditor({ value, structured, onApply }: { value: CellValue; structured: Structured; onApply: (value: CellValue) => void }) {
  const original = valueText(value)
  const [draft, setDraft] = useState(original)
  const [isNull, setIsNull] = useState(value === null)
  const dirty = isNull ? value !== null : value === null || draft !== original

  const apply = () => {
    const next: CellValue = isNull ? null : draft
    if (!sameValue(next, value === null ? null : original)) onApply(next)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <textarea
        value={isNull ? '' : draft}
        placeholder={isNull ? 'NULL' : undefined}
        aria-label="Cell value"
        spellCheck={false}
        onChange={(e) => {
          setIsNull(false)
          setDraft(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            apply()
          }
        }}
        className={cn(
          'selectable min-h-0 w-full flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs leading-[18px] text-fg outline-none',
          'placeholder:italic placeholder:text-grid-null focus:border-accent/70 focus:ring-[3px] focus:ring-accent-soft',
        )}
      />
      <div className="flex items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={isNull} onClick={() => setIsNull(true)}>
          Set NULL
        </Button>
        {structured === 'json' && !isNull && (
          <Button size="xs" variant="ghost" onClick={() => setDraft((d) => prettyJson(d) ?? d)}>
            Format
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          disabled={!dirty}
          onClick={() => {
            setDraft(original)
            setIsNull(value === null)
          }}
        >
          Revert
        </Button>
        <Button size="xs" variant="primary" disabled={!dirty} onClick={apply} title="Apply (⌘↵ / Ctrl+Enter)">
          Apply
        </Button>
      </div>
    </div>
  )
}
