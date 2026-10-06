// "Columns" popover of a DataGrid: show / hide columns (searchable list), reorder them (drag, or
// Alt+↑ / Alt+↓ on a row), freeze the leading ones, reset.
import { useMemo, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Columns3, GripVertical, Search, Snowflake } from 'lucide-react'
import type { ColumnMeta } from '@shared/types'
import { Button, Checkbox, IconButton, Input, Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { cn } from '@/lib/cn'
import { freezeThrough, isDefaultColumnState, moveColumn, setColumnHidden, visibleColumns, type ColumnState } from './column-state'

export interface GridColumnsMenuProps {
  columns: readonly ColumnMeta[]
  state: ColumnState
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (state: ColumnState) => void
  onReset: () => void
  /** Give the keyboard focus back to the grid when the popover closes. */
  onRestoreFocus: () => void
}

const DRAG_MIME = 'application/x-datagrippe-grid-column'

export function GridColumnsMenu({ columns, state, open, onOpenChange, onChange, onReset, onRestoreFocus }: GridColumnsMenuProps) {
  const [query, setQuery] = useState('')
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null)
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden])
  const visible = visibleColumns(state)
  const frozenSet = new Set(visible.slice(0, state.frozen))
  const q = query.trim().toLowerCase()
  const shown = state.order.filter((i) => !q || (columns[i]?.name ?? '').toLowerCase().includes(q))
  const hiddenCount = state.hidden.length

  const move = (source: number, delta: number) => {
    const at = state.order.indexOf(source)
    onChange(moveColumn(state, source, at + delta))
  }

  const onRowKeyDown = (source: number, e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    // keyed rows move in the DOM: the focused checkbox keeps the focus
    move(source, e.key === 'ArrowUp' ? -1 : 1)
  }

  const onDragOver = (index: number, e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    setDrop({ index, after: e.clientY > box.top + box.height / 2 })
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const source = Number(e.dataTransfer.getData(DRAG_MIME))
    const target = drop
    setDrop(null)
    if (!target || !Number.isInteger(source)) return
    e.preventDefault()
    const targetSource = shown[target.index]
    if (targetSource === undefined || targetSource === source) return
    const without = state.order.filter((i) => i !== source)
    const at = without.indexOf(targetSource) + (target.after ? 1 : 0)
    onChange(moveColumn(state, source, at))
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton icon={Columns3} size="xs" label={hiddenCount > 0 ? `Columns (${hiddenCount} hidden)` : 'Columns'} active={!isDefaultColumnState(state)} className="text-subtle" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-72 flex-col gap-2 p-2"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onRestoreFocus()
        }}
      >
        <Input
          size="sm"
          leadingIcon={Search}
          value={query}
          placeholder="Filter columns"
          aria-label="Filter columns"
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
          autoFocus
        />
        <div role="list" aria-label="Columns" className="-mx-1 max-h-[320px] overflow-y-auto px-1" onDragLeave={() => setDrop(null)}>
          {shown.length === 0 && <p className="px-2 py-3 text-center text-xs text-subtle">No column matches.</p>}
          {shown.map((source, index) => {
            const column = columns[source]
            if (!column) return null
            const isHidden = hidden.has(source)
            const isFrozen = frozenSet.has(source)
            const visibleIndex = visible.indexOf(source)
            return (
              <div
                key={source}
                role="listitem"
                tabIndex={-1}
                draggable={!q}
                aria-label={`${column.name}${isHidden ? ', hidden' : ''}${isFrozen ? ', frozen' : ''}. Alt+Up or Alt+Down to move.`}
                onKeyDown={(e) => onRowKeyDown(source, e)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(DRAG_MIME, String(source))
                }}
                onDragEnd={() => setDrop(null)}
                onDragOver={(e) => onDragOver(index, e)}
                onDrop={onDrop}
                className={cn(
                  'group relative flex h-7 items-center gap-1.5 rounded-md pl-0.5 pr-1 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus',
                  drop?.index === index && (drop.after ? 'shadow-[inset_0_-2px_0_var(--c-accent)]' : 'shadow-[inset_0_2px_0_var(--c-accent)]'),
                )}
              >
                <GripVertical size={13} strokeWidth={1.75} className={cn('shrink-0 text-faint', q ? 'opacity-0' : 'cursor-grab')} aria-hidden />
                <Checkbox
                  checked={!isHidden}
                  disabled={!isHidden && visible.length <= 1}
                  onCheckedChange={(checked) => onChange(setColumnHidden(state, source, !checked))}
                />
                <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', isHidden ? 'text-subtle' : 'text-fg')}>{column.name || '?column?'}</span>
                <span className="max-w-20 shrink-0 truncate font-mono text-2xs text-subtle">{column.dataType}</span>
                {!isHidden && (
                  <IconButton
                    icon={Snowflake}
                    size="xs"
                    label={isFrozen && visibleIndex === state.frozen - 1 ? 'Unfreeze columns' : 'Freeze up to this column'}
                    active={isFrozen}
                    className={cn('size-5', !isFrozen && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                    onClick={() => onChange(freezeThrough(state, isFrozen && visibleIndex === state.frozen - 1 ? -1 : visibleIndex))}
                  />
                )}
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-1 border-t border-line pt-2">
          <span className="min-w-0 flex-1 truncate px-1 text-2xs text-subtle">
            {visible.length} of {columns.length} shown
            {state.frozen > 0 && ` · ${state.frozen} frozen`}
          </span>
          {hiddenCount > 0 && (
            <Button size="xs" variant="ghost" onClick={() => onChange({ ...state, hidden: [] })}>
              Show all
            </Button>
          )}
          <Button size="xs" variant="ghost" disabled={isDefaultColumnState(state)} onClick={onReset}>
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
