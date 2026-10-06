import type { Ref } from 'react'
import { ArrowDown, ArrowUp, CornerDownLeft, History, ListFilter, Trash2, X } from 'lucide-react'
import type { SortSpec } from '@shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  SqlText,
  Tooltip,
} from '@/components/ui'
import { cn } from '@/lib/cn'

export interface FilterInputProps {
  value: string
  applied: string
  recent: string[]
  invalid?: boolean
  disabled?: boolean
  placeholder: string
  onChange: (value: string) => void
  onApply: (value: string) => void
  onClearRecent: () => void
  inputRef?: Ref<HTMLInputElement>
}

/** WHERE predicate box: Enter applies, Esc reverts to the applied filter, ⌄ lists recent filters. */
export function FilterInput({
  value,
  applied,
  recent,
  invalid,
  disabled,
  placeholder,
  onChange,
  onApply,
  onClearRecent,
  inputRef,
}: FilterInputProps) {
  const dirty = value.trim() !== applied.trim()
  return (
    <Input
      ref={inputRef}
      mono
      size="md"
      value={value}
      disabled={disabled}
      invalid={invalid}
      aria-label="WHERE filter"
      placeholder={placeholder}
      wrapperClassName="min-w-[200px] max-w-[600px] flex-[3] pl-2"
      leadingIcon={
        <span className="flex items-center gap-1.5">
          <ListFilter size={14} strokeWidth={1.75} className={cn(applied ? 'text-accent' : 'text-subtle')} aria-hidden />
          <span className="font-mono text-2xs font-medium tracking-wide text-subtle">WHERE</span>
        </span>
      }
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onApply(value)
        } else if (e.key === 'Escape') {
          if (dirty) {
            e.preventDefault()
            e.stopPropagation()
            onChange(applied)
          } else {
            e.currentTarget.blur()
          }
        }
      }}
      onClear={() => {
        onChange('')
        if (applied) onApply('')
      }}
      trailing={
        <span className="-mr-1.5 flex items-center gap-0.5">
          {dirty && (
            <Tooltip content="Apply filter" shortcut="Enter">
              <button
                type="button"
                aria-label="Apply filter"
                onClick={() => onApply(value)}
                className="flex h-5 items-center gap-1 rounded-[4px] px-1 text-2xs text-subtle outline-none hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
              >
                <CornerDownLeft size={12} strokeWidth={2} />
              </button>
            </Tooltip>
          )}
          <DropdownMenu>
            <Tooltip content="Recent filters">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Recent filters"
                  disabled={disabled}
                  className="flex size-5 items-center justify-center rounded-[4px] text-subtle outline-none hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-active data-[state=open]:text-fg"
                >
                  <History size={13} strokeWidth={1.75} />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-[420px] max-w-[70vw]">
              <DropdownMenuLabel>Recent filters</DropdownMenuLabel>
              {recent.length === 0 ? (
                <p className="px-2 pb-2 pt-0.5 text-xs text-subtle">Filters you apply on this table show up here.</p>
              ) : (
                <>
                  {recent.map((filter) => (
                    <DropdownMenuItem key={filter} onSelect={() => onApply(filter)}>
                      <SqlText code={filter} className="block truncate text-xs" />
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon={Trash2} onSelect={onClearRecent}>
                    Clear recent filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      }
    />
  )
}

export interface SortChipsProps {
  sort: SortSpec[]
  disabled?: boolean
  onFlip: (column: string) => void
  onRemove: (column: string) => void
  onClear: () => void
}

/** Active ORDER BY as removable chips; clicking a chip flips its direction. */
export function SortChips({ sort, disabled, onFlip, onRemove, onClear }: SortChipsProps) {
  if (sort.length === 0) return null
  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden" aria-label="Order by">
      <span className="shrink-0 font-mono text-2xs font-medium tracking-wide text-subtle">ORDER BY</span>
      {sort.map((s, i) => {
        const Arrow = s.direction === 'asc' ? ArrowUp : ArrowDown
        return (
          <span
            key={s.column}
            className="inline-flex h-6 min-w-0 shrink-0 items-center rounded-md border border-line bg-hover pl-0.5 text-xs text-fg"
          >
            <Tooltip content={`Sort ${s.direction === 'asc' ? 'descending' : 'ascending'}`}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onFlip(s.column)}
                className="flex h-5 min-w-0 items-center gap-1 rounded-[4px] px-1 outline-none hover:bg-active focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
              >
                {sort.length > 1 && <span className="text-2xs tabular text-subtle">{i + 1}</span>}
                <span className="max-w-[140px] truncate font-mono text-[11.5px]">{s.column}</span>
                <Arrow size={12} strokeWidth={2} className="shrink-0 text-accent" aria-label={s.direction === 'asc' ? 'ascending' : 'descending'} />
              </button>
            </Tooltip>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove sort on ${s.column}`}
              onClick={() => onRemove(s.column)}
              className="mr-0.5 flex size-5 items-center justify-center rounded-[4px] text-subtle outline-none hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
            >
              <X size={11} strokeWidth={2.25} />
            </button>
          </span>
        )
      })}
      {sort.length > 1 && (
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          className="h-6 shrink-0 rounded-md px-1.5 text-2xs text-subtle outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
        >
          Clear
        </button>
      )}
    </div>
  )
}
