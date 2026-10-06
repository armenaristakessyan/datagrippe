// Context menu of the grid body / header: view, edit, copy (as…), filter by value, find, sort,
// column arrangement, plus caller-provided items.
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Ban,
  Columns3,
  Copy,
  EyeOff,
  Eye,
  Filter,
  FilterX,
  MoveHorizontal,
  Pencil,
  Search,
  Snowflake,
} from 'lucide-react'
import type { ExportFormat } from '@shared/types'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui'
import type { GridMenuItem } from './DataGrid'

export type CopyFormat = ExportFormat | 'in-list'

export interface GridContextMenuProps {
  /** Something is selected (copy actions enabled). */
  hasSelection: boolean
  /** "Copy as SQL IN list" — one column selected. */
  singleColumn: boolean
  /** Header of the selection, e.g. "3 × 2 cells". */
  summary?: string
  inspectorOpen: boolean
  canEdit: boolean
  canSetNull: boolean
  /** Active column, for sort / filter / column entries. */
  columnName?: string
  sortDirection?: 'asc' | 'desc'
  /** "Filter by this value" is offered (one active cell). */
  canFilterByValue: boolean
  /** Client-side value filters are active ("Clear filters"). */
  filtered: boolean
  /** The active column is frozen ('last': the last frozen one, which offers "Unfreeze"). */
  frozen: 'none' | 'inside' | 'last'
  canHideColumn: boolean
  extraItems: GridMenuItem[]
  /** withHeaders 'auto': like ⌘C, the header row is included for whole-column selections. */
  onCopy: (format: CopyFormat, withHeaders: boolean | 'auto') => void
  onCopyColumnNames: () => void
  onToggleInspector: () => void
  onEdit: () => void
  onSetNull: () => void
  onFilterByValue: (exclude: boolean) => void
  onClearFilters: () => void
  onFind: () => void
  onSort: (direction: 'asc' | 'desc' | null) => void
  onAutoFit: () => void
  onHideColumn: () => void
  onFreeze: (freeze: boolean) => void
  onColumns: () => void
  /** Give the keyboard focus back to the grid once the menu closes. */
  onRestoreFocus: () => void
}

export function GridContextMenu({
  hasSelection,
  singleColumn,
  summary,
  inspectorOpen,
  canEdit,
  canSetNull,
  columnName,
  sortDirection,
  canFilterByValue,
  filtered,
  frozen,
  canHideColumn,
  extraItems,
  onCopy,
  onCopyColumnNames,
  onToggleInspector,
  onEdit,
  onSetNull,
  onFilterByValue,
  onClearFilters,
  onFind,
  onSort,
  onAutoFit,
  onHideColumn,
  onFreeze,
  onColumns,
  onRestoreFocus,
}: GridContextMenuProps) {
  return (
    <ContextMenuContent
      className="min-w-[230px]"
      onCloseAutoFocus={(e) => {
        // Radix would focus the trigger and scroll it into view: focus the grid without scrolling,
        // unless the chosen action moved the focus somewhere on purpose (cell editor, find bar, dialog…).
        e.preventDefault()
        const active = document.activeElement
        if (!active || active === document.body || !active.isConnected || active.closest('[role="menu"]')) onRestoreFocus()
      }}
    >
      {summary && <ContextMenuLabel>{summary}</ContextMenuLabel>}
      <ContextMenuItem icon={Eye} shortcut="Space" disabled={!hasSelection} onSelect={onToggleInspector}>
        {inspectorOpen ? 'Hide value inspector' : 'View value'}
      </ContextMenuItem>
      {canEdit && (
        <ContextMenuItem icon={Pencil} shortcut="Enter" onSelect={onEdit}>
          Edit cell
        </ContextMenuItem>
      )}
      {canSetNull && (
        <ContextMenuItem icon={Ban} shortcut="CmdOrCtrl+Backspace" onSelect={onSetNull}>
          Set NULL
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem icon={Copy} shortcut="CmdOrCtrl+C" disabled={!hasSelection} onSelect={() => onCopy('tsv', 'auto')}>
        Copy
      </ContextMenuItem>
      <ContextMenuItem inset disabled={!hasSelection} onSelect={() => onCopy('tsv', true)}>
        Copy with headers
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger inset disabled={!hasSelection}>
          Copy as
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-[180px]">
          <ContextMenuItem onSelect={() => onCopy('csv', true)}>CSV</ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopy('tsv', true)}>TSV</ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopy('json', true)}>JSON</ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopy('markdown', true)}>Markdown table</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onCopy('sql', true)}>SQL INSERT</ContextMenuItem>
          <ContextMenuItem disabled={!singleColumn} onSelect={() => onCopy('in-list', false)}>
            SQL IN list
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem inset disabled={!hasSelection} onSelect={onCopyColumnNames}>
        Copy column {singleColumn ? 'name' : 'names'}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {canFilterByValue && (
        <>
          <ContextMenuItem icon={Filter} onSelect={() => onFilterByValue(false)}>
            Filter by this value
          </ContextMenuItem>
          <ContextMenuItem inset onSelect={() => onFilterByValue(true)}>
            Exclude this value
          </ContextMenuItem>
        </>
      )}
      {filtered && (
        <ContextMenuItem icon={FilterX} onSelect={onClearFilters}>
          Clear value filters
        </ContextMenuItem>
      )}
      <ContextMenuItem icon={Search} shortcut="CmdOrCtrl+F" onSelect={onFind}>
        Find…
      </ContextMenuItem>
      {columnName !== undefined && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem icon={ArrowUpNarrowWide} disabled={sortDirection === 'asc'} onSelect={() => onSort('asc')}>
            Sort ascending
          </ContextMenuItem>
          <ContextMenuItem icon={ArrowDownWideNarrow} disabled={sortDirection === 'desc'} onSelect={() => onSort('desc')}>
            Sort descending
          </ContextMenuItem>
          {sortDirection && (
            <ContextMenuItem inset onSelect={() => onSort(null)}>
              Clear sort
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem icon={MoveHorizontal} onSelect={onAutoFit}>
            Fit column width
          </ContextMenuItem>
          <ContextMenuItem icon={EyeOff} disabled={!canHideColumn} onSelect={onHideColumn}>
            Hide column
          </ContextMenuItem>
          {frozen === 'last' ? (
            <ContextMenuItem icon={Snowflake} onSelect={() => onFreeze(false)}>
              Unfreeze columns
            </ContextMenuItem>
          ) : (
            <ContextMenuItem icon={Snowflake} onSelect={() => onFreeze(true)}>
              Freeze up to this column
            </ContextMenuItem>
          )}
          <ContextMenuItem icon={Columns3} onSelect={onColumns}>
            Columns…
          </ContextMenuItem>
        </>
      )}
      {extraItems.length > 0 && <ContextMenuSeparator />}
      {extraItems.map((item, i) =>
        'separator' in item ? (
          <ContextMenuSeparator key={`sep-${i}`} />
        ) : (
          <ContextMenuItem key={`${item.label}-${i}`} inset shortcut={item.shortcut} danger={item.danger} disabled={item.disabled} onSelect={item.onSelect}>
            {item.label}
          </ContextMenuItem>
        ),
      )}
    </ContextMenuContent>
  )
}
