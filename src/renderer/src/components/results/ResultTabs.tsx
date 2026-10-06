// Tab strip of the results panel: pinned results of earlier runs, one tab per statement result,
// then Messages and Plan.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Ban, MessageSquareText, OctagonAlert, Pin, SquareCheck, Table2, Workflow } from 'lucide-react'
import type { Dialect, ExecutionResult, StatementResult } from '@shared/types'
import { Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatCount } from '@/lib/format'
import { isCancelledResult, resultLabel } from './result-meta'

export type ResultTabId = { view: 'results'; index: number } | { view: 'messages' } | { view: 'explain' } | { view: 'pinned'; id: string }

/** A result pinned from an earlier run of the console. */
export interface PinnedTab {
  id: string
  result: StatementResult
  /** "10:42" */
  time: string
}

export interface ResultTabsProps {
  execution?: ExecutionResult
  dialect?: Dialect
  current: ResultTabId
  showPlan: boolean
  planLoading: boolean
  /** Results pinned from earlier runs (shown first). */
  pinned?: readonly PinnedTab[]
  /** Results of the current run that are pinned (pin glyph). */
  pinnedIndices?: ReadonlySet<number>
  onSelect: (tab: ResultTabId) => void
}

function tabKey(t: ResultTabId): string {
  return t.view === 'results' ? `r${t.index}` : t.view === 'pinned' ? `p${t.id}` : t.view
}

export function ResultTabs({ execution, dialect, current, showPlan, planLoading, pinned, pinnedIndices, onSelect }: ResultTabsProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const tabs: { id: ResultTabId; label: ReactNode; title: string; icon: ReactNode; tone?: 'danger' }[] = []

  for (const p of pinned ?? []) {
    const { label, title } = resultLabel(p.result, dialect)
    tabs.push({
      id: { view: 'pinned', id: p.id },
      label: (
        <>
          {label}
          <span className="ml-1 text-2xs text-subtle tabular">{p.time}</span>
        </>
      ),
      title: `Pinned at ${p.time} — ${title}`,
      tone: p.result.kind === 'error' ? 'danger' : undefined,
      icon: <Pin size={12} strokeWidth={2} className="text-accent" />,
    })
  }

  for (const r of execution?.results ?? []) {
    const { label, title } = resultLabel(r, dialect)
    const cancelled = isCancelledResult(r, execution)
    const isPinned = pinnedIndices?.has(r.index) ?? false
    tabs.push({
      id: { view: 'results', index: r.index },
      label: isPinned ? (
        <>
          {label}
          <Pin size={10} strokeWidth={2.25} className="ml-1 text-accent" aria-label="Pinned" />
        </>
      ) : (
        label
      ),
      title: cancelled ? `${label} — cancelled` : isPinned ? `${title}\nPinned: kept when the console runs again` : title,
      tone: r.kind === 'error' && !cancelled ? 'danger' : undefined,
      icon: cancelled ? (
        <Ban size={13} strokeWidth={1.75} />
      ) : r.kind === 'error' ? (
          <OctagonAlert size={13} strokeWidth={2} className="text-danger" />
        ) : r.kind === 'command' ? (
          <SquareCheck size={13} strokeWidth={1.75} />
        ) : (
          <Table2 size={13} strokeWidth={1.75} />
        ),
    })
  }
  if (execution) {
    const count = execution.messages.length
    tabs.push({
      id: { view: 'messages' },
      label: (
        <>
          Messages
          {count > 0 && <span className="ml-1 rounded-[4px] bg-active px-1 text-2xs leading-4 text-muted tabular">{formatCount(count)}</span>}
        </>
      ),
      title: 'Server messages and statement summary',
      icon: <MessageSquareText size={13} strokeWidth={1.75} />,
    })
  }
  if (showPlan) {
    tabs.push({
      id: { view: 'explain' },
      label: 'Plan',
      title: 'Query plan',
      icon: planLoading ? <Spinner size={12} /> : <Workflow size={13} strokeWidth={1.75} />,
    })
  }

  const currentKey = tabKey(current)

  // Vertical wheel scrolls the strip horizontally; keep the current tab visible.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>(`[data-key="${currentKey}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentKey])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    const i = tabs.findIndex((t) => tabKey(t.id) === currentKey)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : Math.min(tabs.length - 1, Math.max(0, i + (e.key === 'ArrowLeft' ? -1 : 1)))
    const tab = tabs[next]
    if (!tab) return
    e.preventDefault()
    onSelect(tab.id)
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-key="${tabKey(tab.id)}"]`)?.focus())
  }

  return (
    <div ref={scroller} role="tablist" aria-label="Results" onKeyDown={onKeyDown} className="scrollbar-none flex h-full min-w-0 flex-1 items-stretch overflow-x-auto">
      {tabs.map((t) => {
        const key = tabKey(t.id)
        const selected = key === currentKey
        return (
          <button
            key={key}
            type="button"
            role="tab"
            data-key={key}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={t.title}
            onClick={() => onSelect(t.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-xs outline-none transition-colors duration-100',
              'focus-visible:bg-hover focus-visible:text-fg',
              selected ? 'text-fg' : 'text-subtle hover:text-muted',
              selected && 'after:absolute after:inset-x-2 after:bottom-0 after:h-[1.5px] after:rounded-full',
              selected && (t.tone === 'danger' ? 'after:bg-danger' : 'after:bg-accent'),
            )}
          >
            <span className={cn('flex shrink-0', !selected && t.tone !== 'danger' && 'opacity-70')}>{t.icon}</span>
            <span className={cn('flex items-center', t.tone === 'danger' && !selected && 'text-danger/80')}>{t.label}</span>
          </button>
        )
      })}
    </div>
  )
}
