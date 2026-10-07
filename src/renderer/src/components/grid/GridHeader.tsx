// Sticky header row: column name + type, sort button, resize handles, select-all corner, the frozen
// leading columns (sticky) and the trailing "Columns" button. Column indices are VIEW columns.
import { memo, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, KeyRound, Link2 } from 'lucide-react'
import type { ColumnMeta, SortSpec } from '@shared/types'
import { cn } from '@/lib/cn'
import { HEADER_HEIGHT, type GridLayout } from './grid-data'

export interface GridHeaderProps {
  /** Visible columns, in display order. */
  columns: readonly ColumnMeta[]
  layout: GridLayout
  colStart: number
  colEnd: number
  sort: readonly SortSpec[]
  /** Selected column range (inclusive), highlighted. */
  selC0: number
  selC1: number
  /** Whole columns are selected (stronger highlight). */
  wholeColumns: boolean
  allSelected: boolean
  showRowNumbers: boolean
  /** View columns of the primary key. */
  primaryKeyColumns?: ReadonlySet<number>
  /** View columns that reference another table (foreign key) → tooltip line ("→ public.customers"). */
  foreignKeyColumns?: ReadonlyMap<number, string>
  /** Rendered sticky at the right end of the header (e.g. the Columns menu). */
  trailing?: ReactNode
  onColumnPointerDown: (col: number, event: ReactPointerEvent<HTMLDivElement>) => void
  onCornerClick: () => void
  onSortClick: (col: number, multi: boolean) => void
  onResizeStart: (col: number, event: ReactPointerEvent<HTMLDivElement>) => void
  onAutoFit: (col: number) => void
}

function GridHeaderImpl({
  columns,
  layout,
  colStart,
  colEnd,
  sort,
  selC0,
  selC1,
  wholeColumns,
  allSelected,
  showRowNumbers,
  primaryKeyColumns,
  foreignKeyColumns,
  trailing,
  onColumnPointerDown,
  onCornerClick,
  onSortClick,
  onResizeStart,
  onAutoFit,
}: GridHeaderProps) {
  const frozen = Math.min(layout.frozen, columns.length)

  const header = (c: number): ReactNode => {
    const column = columns[c]
    if (!column) return null
    const sortIndex = sort.findIndex((s) => s.column === column.name)
    const direction = sortIndex >= 0 ? sort[sortIndex]!.direction : undefined
    const selected = c >= selC0 && c <= selC1
    const SortIcon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown
    const isFrozen = c < frozen
    const reference = foreignKeyColumns?.get(c)
    return (
      <div
        key={c}
        role="columnheader"
        aria-colindex={c + 1}
        aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}
        title={`${column.name} · ${column.dataType}${column.table ? ` · ${column.table}` : ''}${reference ? `\n${reference}` : ''}`}
        onPointerDown={(e) => onColumnPointerDown(c, e)}
        className={cn(
          'group relative flex h-full shrink-0 cursor-default items-center gap-1 border-b border-r border-line bg-grid-header pl-2 pr-1',
          selected && (wholeColumns ? 'before:absolute before:inset-0 before:bg-selection' : 'before:absolute before:inset-0 before:bg-hover'),
          isFrozen && 'sticky z-[25]',
          isFrozen && c === frozen - 1 && 'border-r-line-strong',
        )}
        style={isFrozen ? { width: layout.widths[c], left: layout.gutter + (layout.offsets[c] ?? 0) } : { width: layout.widths[c] }}
      >
        <div className="relative flex min-w-0 flex-1 flex-col justify-center gap-px">
          <span className={cn('flex min-w-0 items-center gap-1 font-mono text-xs leading-4', selected ? 'text-fg' : 'text-fg/90')}>
            {primaryKeyColumns?.has(c) && <KeyRound size={11} strokeWidth={2} className="shrink-0 text-warning" aria-label="Primary key" />}
            {reference && !primaryKeyColumns?.has(c) && <Link2 size={11} strokeWidth={2} className="shrink-0 text-info" aria-label="Foreign key" />}
            <span className="truncate">{column.name || <span className="italic text-subtle">?column?</span>}</span>
          </span>
          <span className="truncate font-mono text-2xs leading-[13px] text-subtle">{column.dataType}</span>
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-label={direction ? `Sorted ${direction === 'asc' ? 'ascending' : 'descending'}; change sort` : `Sort by ${column.name}`}
          // never take the focus: keyboard navigation and ⌘C stay on the grid (onSortClick refocuses it)
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => onSortClick(c, e.shiftKey)}
          className={cn(
            'relative flex h-5 shrink-0 items-center justify-center gap-px rounded-[4px] px-0.5 outline-none hover:bg-active',
            direction ? 'text-accent' : 'text-faint opacity-0 hover:text-fg group-hover:opacity-100',
          )}
        >
          <SortIcon size={12} strokeWidth={2} />
          {direction && sort.length > 1 && <span className="font-mono text-[9px] leading-none">{sortIndex + 1}</span>}
        </button>
        <div
          aria-hidden
          onPointerDown={(e) => {
            e.stopPropagation()
            onResizeStart(c, e)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onAutoFit(c)
          }}
          className="absolute -right-[4px] top-0 z-10 h-full w-[7px] cursor-col-resize after:absolute after:inset-y-1.5 after:left-[3px] after:w-px after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-100"
        />
      </div>
    )
  }

  const cells: ReactNode[] = []
  for (let c = 0; c < frozen; c++) cells.push(header(c))
  const first = Math.max(colStart, frozen)
  for (let c = first; c <= colEnd; c++) cells.push(header(c))

  return (
    <div role="row" aria-rowindex={1} className="sticky top-0 z-20 flex select-none" style={{ height: HEADER_HEIGHT, minWidth: layout.totalWidth }}>
      {showRowNumbers && (
        <div
          role="columnheader"
          aria-label="Select all"
          onClick={onCornerClick}
          className={cn(
            'sticky left-0 z-30 flex h-full shrink-0 cursor-default items-end justify-end border-b border-r border-line bg-grid-header pb-1 pr-2',
            allSelected && 'before:absolute before:inset-0 before:bg-selection',
          )}
          style={{ width: layout.gutter }}
        >
          <span className="relative size-0 border-b-[6px] border-l-[6px] border-b-faint border-l-transparent" />
        </div>
      )}
      {/* room of the columns left of the rendered window (frozen columns are rendered) */}
      <div className="h-full shrink-0 border-b border-line bg-grid-header" style={{ width: (layout.offsets[first] ?? 0) - (layout.offsets[frozen] ?? 0) }} />
      {cells}
      <div className="h-full min-w-0 flex-1 border-b border-line bg-grid-header" />
      {trailing && (
        <div role="presentation" className="sticky right-0 z-30 flex h-full shrink-0 items-center border-b border-l border-line bg-grid-header px-0.5">
          {trailing}
        </div>
      )}
    </div>
  )
}

export const GridHeader = memo(GridHeaderImpl)
