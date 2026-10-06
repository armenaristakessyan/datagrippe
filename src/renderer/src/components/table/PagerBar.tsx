import { ChevronLeft, ChevronRight, Sigma } from 'lucide-react'
import { Button, IconButton, Select, Spinner, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatCount, formatDuration } from '@/lib/format'
import { describeWindow, type PageWindow } from './paging'
import { PAGE_SIZES } from './table-session'

export interface PagerBarProps {
  window: PageWindow
  loading: boolean
  counting: boolean
  canCount: boolean
  durationMs?: number
  pendingLabel?: string
  disabled?: boolean
  onPrev: () => void
  onNext: () => void
  onPageSize: (size: number) => void
  onCount: () => void
}

export function PagerBar({
  window: w,
  loading,
  counting,
  canCount,
  durationMs,
  pendingLabel,
  disabled,
  onPrev,
  onNext,
  onPageSize,
  onCount,
}: PagerBarProps) {
  const text = describeWindow(w)
  const page = Math.floor(w.offset / w.pageSize) + 1
  const pages = w.total !== undefined ? Math.max(1, Math.ceil(w.total / w.pageSize)) : undefined
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel pl-3 pr-2 text-xs text-muted">
      <span className={cn('tabular whitespace-nowrap', loading && 'opacity-60')} aria-live="polite">
        <span className="text-fg">{text.range}</span>
        {text.total && <span className="text-subtle"> {text.total}</span>}
      </span>
      {canCount && w.total === undefined && (
        <Tooltip content="Count rows matching the filter (SELECT COUNT(*))">
          <Button
            size="xs"
            variant="ghost"
            leadingIcon={counting ? <Spinner size={12} /> : Sigma}
            disabled={counting || disabled}
            onClick={onCount}
            className="text-subtle"
          >
            {counting ? 'Counting…' : 'Count'}
          </Button>
        </Tooltip>
      )}
      {durationMs !== undefined && !loading && (
        <span className="whitespace-nowrap text-2xs tabular text-subtle" title="Query time">
          {formatDuration(durationMs)}
        </span>
      )}
      {pendingLabel && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-2xs text-warning">
          <span className="size-1.5 rounded-full bg-warning" aria-hidden />
          {pendingLabel}
        </span>
      )}
      <div className="flex-1" />
      <Select
        size="sm"
        variant="ghost"
        aria-label="Rows per page"
        disabled={disabled}
        value={String(w.pageSize)}
        onValueChange={(v) => onPageSize(Number(v))}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} rows`, triggerLabel: `${n} / page` }))}
        className="text-xs"
      />
      <div className="flex items-center gap-0.5">
        <IconButton icon={ChevronLeft} label="Previous page" size="xs" disabled={disabled || w.offset === 0} onClick={onPrev} tooltipSide="top" />
        <span className="min-w-[52px] text-center text-2xs tabular text-subtle">
          {pages !== undefined ? `${formatCount(page)} / ${formatCount(pages)}` : `Page ${formatCount(page)}`}
        </span>
        <IconButton icon={ChevronRight} label="Next page" size="xs" disabled={disabled || !w.hasMore} onClick={onNext} tooltipSide="top" />
      </div>
    </div>
  )
}
