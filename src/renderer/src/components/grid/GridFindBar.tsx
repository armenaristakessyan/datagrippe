// Find bar of a DataGrid (⌘F while the grid has focus): searches the loaded rows, highlights the
// matching cells, steps through them with Enter / Shift+Enter, and can hide the rows without a match.
import { useEffect, useRef, type KeyboardEvent, type Ref } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, ListFilter, Search, X } from 'lucide-react'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatCount } from '@/lib/format'

export interface FindState {
  open: boolean
  query: string
  caseSensitive: boolean
  /** Hide the rows without a match. */
  onlyMatching: boolean
}

export const CLOSED_FIND: FindState = { open: false, query: '', caseSensitive: false, onlyMatching: false }

export interface GridFindBarProps {
  state: FindState
  /** Total matches (null while there is no query); `capped` when counting stopped early. */
  total: number | null
  capped: boolean
  /** 1-based position of the active cell among the matches, when it is one. */
  current?: number
  /** More rows exist than are loaded (the counter says "loaded rows"). */
  partial: boolean
  inputRef?: Ref<HTMLInputElement>
  onChange: (patch: Partial<FindState>) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function GridFindBar({ state, total, capped, current, partial, inputRef, onChange, onNext, onPrevious, onClose }: GridFindBarProps) {
  const localRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    localRef.current?.focus()
    localRef.current?.select()
  }, [])

  const setRefs = (el: HTMLInputElement | null) => {
    localRef.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) onPrevious()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const none = total === 0 && state.query !== ''
  const count =
    total === null
      ? ''
      : total === 0
        ? 'No matches'
        : `${current !== undefined ? `${formatCount(current)} of ` : ''}${formatCount(total)}${capped ? '+' : ''}${current === undefined ? (total === 1 ? ' match' : ' matches') : ''}`

  return (
    <div
      role="search"
      aria-label="Find in grid"
      className="flex h-8 items-center gap-1 rounded-lg border border-line bg-elevated py-1 pl-2 pr-1 shadow-popover"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Search size={13} strokeWidth={2} className="shrink-0 text-subtle" aria-hidden />
      <input
        ref={setRefs}
        value={state.query}
        aria-label="Find"
        aria-invalid={none || undefined}
        placeholder={partial ? 'Find in loaded rows' : 'Find'}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange({ query: e.target.value })}
        onKeyDown={onKeyDown}
        className={cn('h-full w-44 min-w-0 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-faint', none && 'text-danger')}
      />
      <span
        aria-live="polite"
        title={partial && total !== null ? 'Counted in the loaded rows only' : undefined}
        className={cn('min-w-16 shrink-0 text-right text-2xs tabular', none ? 'text-danger' : 'text-subtle')}
      >
        {count}
      </span>
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
      <IconButton
        icon={CaseSensitive}
        size="xs"
        label="Match case"
        active={state.caseSensitive}
        aria-pressed={state.caseSensitive}
        onClick={() => onChange({ caseSensitive: !state.caseSensitive })}
      />
      <IconButton
        icon={ListFilter}
        size="xs"
        label={state.onlyMatching ? 'Show all rows' : 'Only matching rows'}
        active={state.onlyMatching}
        aria-pressed={state.onlyMatching}
        onClick={() => onChange({ onlyMatching: !state.onlyMatching })}
      />
      <IconButton icon={ArrowUp} size="xs" label="Previous match" shortcut="Shift+Enter" disabled={!total} onClick={onPrevious} />
      <IconButton icon={ArrowDown} size="xs" label="Next match" shortcut="Enter" disabled={!total} onClick={onNext} />
      <IconButton icon={X} size="xs" label="Close" shortcut="Escape" onClick={onClose} />
    </div>
  )
}
