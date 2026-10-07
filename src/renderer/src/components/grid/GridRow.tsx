// One virtualized grid row: sticky row-number gutter, the frozen leading columns (sticky) and the
// visible column window. Memoized on primitive props so selection changes and scrolling re-render
// only rows whose inputs changed. Column indices here are VIEW columns (layout.source maps them to
// the source columns of the row).
import { memo, type CSSProperties, type ReactNode } from 'react'
import type { CellValue } from '@shared/types'
import { cn } from '@/lib/cn'
import type { RowState } from './DataGrid'
import type { CellMatcher } from './find'
import { CellContent } from './GridCell'
import { ROW_HEIGHT, type GridLayout } from './grid-data'

export interface GridRowProps {
  gridId: string
  viewRow: number
  sourceRow: number
  row: readonly CellValue[]
  top: number
  /** Visible column window (inclusive, view columns). */
  colStart: number
  colEnd: number
  layout: GridLayout
  showRowNumbers: boolean
  nullDisplay: string
  rowState?: RowState
  /** Number shown in the gutter (undefined: none, e.g. a pending insert). */
  rowNumber?: number
  /** Row number highlighted (row inside the selection). */
  rowSelected: boolean
  /** Source row / source column. */
  isCellModified?: (row: number, col: number) => boolean
  getCellPlaceholder?: (row: number, col: number) => string | undefined
  /** Find: cells whose value matches are highlighted. */
  match?: CellMatcher | null
}

const STATE_BG: Record<RowState, string> = {
  inserted: 'bg-grid-inserted [--row-tint:var(--c-grid-inserted)]',
  deleted: 'bg-grid-deleted [--row-tint:var(--c-grid-deleted)]',
  modified: 'hover:bg-hover hover:[--row-tint:var(--c-hover)]',
}

const STATE_BAR: Record<RowState, string> = {
  inserted: 'after:bg-success',
  deleted: 'after:bg-danger',
  modified: 'after:bg-warning',
}

function GridRowImpl({
  gridId,
  viewRow,
  sourceRow,
  row,
  top,
  colStart,
  colEnd,
  layout,
  showRowNumbers,
  nullDisplay,
  rowState,
  rowNumber,
  rowSelected,
  isCellModified,
  getCellPlaceholder,
  match,
}: GridRowProps) {
  const deleted = rowState === 'deleted'
  const frozen = Math.min(layout.frozen, layout.widths.length)

  const cell = (c: number): ReactNode => {
    const src = layout.source[c] ?? c
    const value = row[src] ?? null
    const modified = isCellModified?.(sourceRow, src) ?? false
    const placeholder = getCellPlaceholder?.(sourceRow, src)
    const matched = !!match && placeholder === undefined && match(value)
    const isFrozen = c < frozen
    let style: CSSProperties = { width: layout.widths[c] }
    if (isFrozen) {
      // sticky over the scrolled cells: an opaque surface under the row's tint and the cell's own
      const tint = matched ? 'var(--c-warning-soft)' : modified ? 'var(--c-grid-modified)' : 'transparent'
      style = {
        ...style,
        left: layout.gutter + (layout.offsets[c] ?? 0),
        background: `linear-gradient(${tint}, ${tint}), linear-gradient(var(--row-tint), var(--row-tint)), var(--c-surface)`,
      }
    }
    return (
      <div
        key={c}
        id={`${gridId}-${viewRow}-${c}`}
        role="gridcell"
        aria-colindex={c + 1}
        className={cn(
          'flex h-full shrink-0 items-center overflow-hidden border-b border-r border-line px-2',
          layout.numeric[c] && typeof value !== 'boolean' && 'justify-end tabular',
          !isFrozen && modified && 'bg-grid-modified',
          !isFrozen && matched && 'bg-warning-soft',
          isFrozen && 'sticky z-[7]',
          isFrozen && c === frozen - 1 && 'border-r-line-strong',
          deleted && 'text-subtle line-through decoration-danger/60',
        )}
        style={style}
      >
        {placeholder !== undefined ? (
          // small sans lowercase so it fits even the narrowest columns (int ids)
          <span className="truncate font-sans text-2xs lowercase italic text-grid-null" title={placeholder}>
            {placeholder}
          </span>
        ) : (
          <CellContent value={value} kind={layout.kinds[c] ?? 'text'} nullDisplay={nullDisplay} />
        )}
      </div>
    )
  }

  const cells: ReactNode[] = []
  for (let c = 0; c < frozen; c++) cells.push(cell(c))
  const first = Math.max(colStart, frozen)
  for (let c = first; c <= colEnd; c++) cells.push(cell(c))

  return (
    <div
      role="row"
      aria-rowindex={viewRow + 2}
      className={cn(
        'absolute left-0 flex font-mono text-xs leading-none text-code [--row-tint:transparent]',
        viewRow % 2 === 1 && 'bg-grid-row-alt [--row-tint:var(--c-grid-row-alt)]',
        rowState ? STATE_BG[rowState] : 'hover:bg-hover hover:[--row-tint:var(--c-hover)]',
      )}
      style={{ top, height: ROW_HEIGHT, width: layout.totalWidth }}
    >
      {showRowNumbers && (
        <div
          role="rowheader"
          data-gutter=""
          className={cn(
            'sticky left-0 z-10 flex h-full shrink-0 items-center justify-end border-b border-r border-line bg-surface pr-2 text-2xs tabular',
            rowSelected ? 'text-fg before:absolute before:inset-0 before:bg-selection' : 'text-faint',
            rowState && cn('after:absolute after:inset-y-0 after:left-0 after:w-0.5', STATE_BAR[rowState]),
          )}
          style={{ width: layout.gutter }}
        >
          <span className="relative">{rowNumber}</span>
        </div>
      )}
      {/* room of the columns left of the rendered window (frozen columns are rendered) */}
      <div className="shrink-0" style={{ width: (layout.offsets[first] ?? 0) - (layout.offsets[frozen] ?? 0) }} />
      {cells}
    </div>
  )
}

export const GridRow = memo(GridRowImpl)
