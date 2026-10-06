// DataGrid — virtualized result/data grid shared by query results and the table data editor.
// CONTRACT: the props below are consumed by components/results and components/table. Keep them
// backward compatible (additions only).
//
// Rows and columns are virtualized (@tanstack/react-virtual). Rows are memoized on primitive props;
// the selection range and the active cell are drawn as overlays, so moving the selection re-renders
// only the header and the rows whose row-number highlight changes.
//
// Coordinates: the selection, the editor and the overlays live in VIEW coordinates — rows after the
// client-side sort / filters, columns in display order without the hidden ones. Everything that
// leaves the grid (callbacks, GridSelection) is mapped back to source rows / `columns` indices.
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Filter, Rows3, SearchX, X } from 'lucide-react'
import type { CellValue, ColumnMeta, Dialect, SortSpec } from '@shared/types'
import { Button, ContextMenu, ContextMenuTrigger, EmptyState, Spinner, toast } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import { formatShortcut } from '@/lib/shortcuts'
import { formatCount, pluralize } from '@/lib/format'
import { isMac } from '@/lib/platform'
import { formatRows, toSqlInList, toTSV } from '@/lib/export-format'
import { editText, needsTextarea, parseEditedText, sameValue, valueText } from './cell-format'
import { CellEditor, type CommitMove } from './CellEditor'
import { CellInspector } from './CellInspector'
import {
  columnsSignature,
  defaultColumnState,
  freezeThrough,
  loadColumnState,
  normalizeColumnState,
  saveColumnState,
  setColumnHidden,
  visibleColumns,
  type ColumnState,
} from './column-state'
import { inferColumnKind, type ColumnKind } from './column-types'
import { collectMatches, filteredOrder, makeMatcher, nearestMatch, type ValueFilter } from './find'
import { ensureGridCommands, releaseGrid, setActiveGrid, type GridCommandHandle } from './grid-commands'
import { GridColumnsMenu } from './GridColumnsMenu'
import { GridContextMenu, type CopyFormat } from './GridContextMenu'
import { CLOSED_FIND, GridFindBar, type FindState } from './GridFindBar'
import { GridHeader } from './GridHeader'
import { GridRow } from './GridRow'
import {
  BULK_EDIT_LIMIT,
  columnAt,
  columnNames,
  columnOffsets,
  gutterWidth,
  HEADER_HEIGHT,
  LOAD_MORE_THRESHOLD,
  ROW_HEIGHT,
  sliceRect,
  type GridLayout,
} from './grid-data'
import { AUTOFIT_MAX_WIDTH, CELL_FONT, columnWidth, HEADER_FONT, initialWidths, MIN_COLUMN_WIDTH } from './measure'
import { parsePastedText, PASTE_CELL_LIMIT } from './paste'
import {
  allSelection,
  cellSelection,
  clampSelection,
  columnSelection,
  coversWholeColumns,
  inRect,
  moveSelection,
  rectCellCount,
  rowSelection,
  selectedSourceRows,
  selectionRect,
  tabSelection,
  toGridSelection,
  type CellPos,
  type Move,
  type Selection,
} from './selection'
import { nextSort, setSort, sortedOrder, type SortKey } from './sort'

export interface GridCellRef {
  /** Index into the `rows` prop (source order, independent of client-side sorting). */
  row: number
  /** Index into the `columns` prop. */
  col: number
}

/** Rectangular selection between two cells (inclusive). */
export interface GridSelection {
  anchor: GridCellRef
  focus: GridCellRef
  /**
   * Source rows of the selection in view order, for selections of up to SELECTED_ROWS_LIMIT rows.
   * Under a client-side sort or filter they are not the range anchor.row…focus.row.
   */
  rows?: number[]
}

/** GridSelection.rows is reported up to this many rows. */
export const SELECTED_ROWS_LIMIT = 5000

export type RowState = 'inserted' | 'deleted' | 'modified'

export type GridMenuItem =
  | { label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { separator: true }

/** One cell edit, in source coordinates (index into `rows` / `columns`). */
export interface GridCellEdit {
  row: number
  col: number
  value: CellValue
}

export interface GridMenuContext {
  selection: GridSelection | null
  /** Source rows of the selection, in view order. */
  rows: number[]
  /** `columns` indices of the selection, in display order (hidden columns left out). */
  columns: number[]
  /** The active cell (source coordinates). */
  active: GridCellRef | null
}

export interface DataGridProps {
  columns: ColumnMeta[]
  rows: CellValue[][]
  /** Stable React key for a source row (defaults to its index). */
  rowKey?: (row: number) => string

  /**
   * Sorting. Uncontrolled (no onSortChange): the grid sorts client-side when a header is clicked.
   * Controlled (onSortChange given): the grid only renders indicators from `sort` and reports clicks
   * (server-side sorting, used by the table data editor). Shift+click adds a secondary sort.
   */
  sort?: SortSpec[]
  onSortChange?: (sort: SortSpec[]) => void
  /**
   * With `sort` / `onSortChange`: the parent owns the sort state but the grid still orders the rows
   * client-side (results panel, so exports can follow the visible order).
   */
  clientSort?: boolean
  /**
   * Changing this value starts the view fresh: selection cleared, editor closed, scrolled to the top
   * (a new page, filter or server-side sort of the same table).
   */
  resetKey?: string | number
  /**
   * Row number shown in the gutter and the inspector for a source row (default: view position + 1,
   * e.g. page offset + index in the table editor). Undefined shows no number (pending inserts).
   */
  getRowNumber?: (row: number) => number | undefined

  /** Inline editing (double-click / Enter / typing on a cell). */
  editable?: boolean
  /** Column indices that can never be edited (generated / identity columns). */
  readOnlyColumns?: ReadonlySet<number>
  onCellEdit?: (row: number, col: number, value: CellValue) => void
  /** Several edits at once (paste, Set NULL); without it onCellEdit is called for each cell. */
  onCellsEdit?: (edits: GridCellEdit[]) => void
  /**
   * A paste that runs past the last row: the extra rows to add, one value per `columns` index
   * (undefined where nothing was pasted). Without it those rows are not pasted.
   */
  onPasteRows?: (rows: (CellValue | undefined)[][]) => void
  /** Visual state of a source row (pending insert / delete / modification). */
  getRowState?: (row: number) => RowState | undefined
  isCellModified?: (row: number, col: number) => boolean
  /**
   * Placeholder text for a cell that holds no real value yet (e.g. "DEFAULT" in a pending insert).
   * Rendered dimmed like NULL; the editor opens empty, and any committed value (NULL included) is
   * reported through onCellEdit. Source indices.
   */
  getCellPlaceholder?: (row: number, col: number) => string | undefined

  /** Extra context-menu entries appended after the built-in copy actions. Rows are source indices. */
  contextMenuItems?: (context: GridMenuContext) => GridMenuItem[]
  /**
   * "Filter by this value" / "Exclude this value": handled by the caller (e.g. a server-side WHERE)
   * instead of filtering the loaded rows. Source column index.
   */
  onFilterByValue?: (col: number, value: CellValue, exclude: boolean) => void

  /** Infinite scroll: onLoadMore fires when the user nears the end and hasMore is true. */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void

  /** Used by "Copy as SQL INSERT". */
  tableName?: string
  dialect?: Dialect

  nullDisplay?: string
  showRowNumbers?: boolean
  /** Shown instead of the body when there are no rows. */
  emptyState?: ReactNode
  onSelectionChange?: (selection: GridSelection | null) => void
  className?: string

  /** Column indices of the primary key (key glyph in the header). */
  primaryKeyColumns?: ReadonlySet<number>
  /** Column indices that reference another table → tooltip line (link glyph in the header). */
  foreignKeyColumns?: ReadonlyMap<number, string>
  /** Remember the column arrangement (order, hidden, frozen) under this key, e.g. one per table. */
  columnStateKey?: string
  /** Accessible name of the grid. */
  'aria-label'?: string
}

interface EditState {
  row: number
  col: number
  initial: string
  caretAtEnd: boolean
  multiline: boolean
}

type DragKind = 'cells' | 'rows' | 'columns'

const NO_SORT: SortSpec[] = []
const NO_FILTERS: ValueFilter[] = []
const INSPECTOR_DEFAULT_WIDTH = 340
const INSPECTOR_MIN_WIDTH = 240

/** Value of a pasted field: empty means NULL except in text columns. */
function pastedValue(text: string, original: CellValue, kind: ColumnKind): CellValue {
  if (text === '' && kind !== 'text') return null
  return parseEditedText(text, original, kind)
}

export function DataGrid({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  clientSort = false,
  resetKey,
  getRowNumber,
  editable = false,
  readOnlyColumns,
  onCellEdit,
  onCellsEdit,
  onPasteRows,
  getRowState,
  isCellModified,
  getCellPlaceholder,
  contextMenuItems,
  onFilterByValue,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  tableName,
  dialect,
  nullDisplay = 'NULL',
  showRowNumbers = true,
  emptyState,
  onSelectionChange,
  className,
  primaryKeyColumns,
  foreignKeyColumns,
  columnStateKey,
  'aria-label': ariaLabel,
}: DataGridProps) {
  const gridId = useId().replace(/:/g, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)

  const sourceCount = rows.length
  const signature = useMemo(() => columnsSignature(columns), [columns])
  const hasRows = sourceCount > 0

  // --- state ---------------------------------------------------------------------------------
  const [selection, setSelection] = useState<Selection | null>(null)
  const [sortState, setSortState] = useState<SortSpec[]>(sort ?? NO_SORT)
  const [overrides, setOverrides] = useState<{ signature: string; widths: Record<number, number> }>({ signature, widths: {} })
  const [editing, setEditing] = useState<EditState | null>(null)
  const [inspector, setInspector] = useState({ open: false, width: INSPECTOR_DEFAULT_WIDTH })
  const [focused, setFocused] = useState(false)
  const [fontsVersion, setFontsVersion] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [scrollLeft, setScrollLeft] = useState(0)
  const [find, setFind] = useState<FindState>(CLOSED_FIND)
  const [valueFilters, setValueFilters] = useState<ValueFilter[]>(NO_FILTERS)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const [columnState, setColumnStateRaw] = useState<ColumnState>(
    () => (columnStateKey ? loadColumnState(columnStateKey, signature, columns.length) : undefined) ?? defaultColumnState(columns.length),
  )
  const [prevSignature, setPrevSignature] = useState(signature)

  if (prevSignature !== signature) {
    // a different result shape: start fresh
    setPrevSignature(signature)
    setSelection(null)
    setEditing(null)
    setSortState(sort ?? NO_SORT)
    setValueFilters(NO_FILTERS)
    setColumnStateRaw((columnStateKey ? loadColumnState(columnStateKey, signature, columns.length) : undefined) ?? defaultColumnState(columns.length))
  }
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  /** This render starts the view fresh: the selection is cleared, not carried over to the new rows. */
  const resetting = prevResetKey !== resetKey || prevSignature !== signature
  if (prevResetKey !== resetKey) {
    // a new page / filter / sort of the same table: nothing selected, back to the top
    setPrevResetKey(resetKey)
    setSelection(null)
    setEditing(null)
  }

  const controlledSort = onSortChange !== undefined
  /** The server orders the rows (table editor); otherwise the grid sorts them client-side. */
  const serverSort = controlledSort && !clientSort
  const effectiveSort = controlledSort ? (sort ?? NO_SORT) : sortState

  // --- columns -------------------------------------------------------------------------------
  const colState = useMemo(() => normalizeColumnState(columnState, columns.length), [columnState, columns.length])
  const setColumnState = useCallback(
    (next: ColumnState) => {
      setColumnStateRaw(next)
      if (columnStateKey) saveColumnState(columnStateKey, signature, next)
    },
    [columnStateKey, signature],
  )
  /** View column → source column. */
  const viewSource = useMemo(() => visibleColumns(colState), [colState])
  const colCount = viewSource.length
  const srcCol = useCallback((view: number) => viewSource[view] ?? view, [viewSource])
  const viewColumns = useMemo(() => viewSource.map((i) => columns[i]!), [viewSource, columns])

  // Kinds and initial widths are sampled once per result shape (and once rows first arrive).
  const kinds = useMemo(
    () => columns.map((c, i) => inferColumnKind(c, rows, i, dialect)),
    [signature, hasRows, dialect],
  )
  const keySignature = primaryKeyColumns ? [...primaryKeyColumns].join(',') : ''
  const baseWidths = useMemo(
    () => initialWidths(columns, kinds, rows, { nullDisplay, keyColumns: primaryKeyColumns }),
    [signature, hasRows, kinds, nullDisplay, fontsVersion, keySignature],
  )
  const widthOverrides = overrides.signature === signature ? overrides.widths : undefined
  const lastNumber = getRowNumber && sourceCount > 0 ? (getRowNumber(sourceCount - 1) ?? sourceCount) : sourceCount
  const gutter = showRowNumbers ? gutterWidth(Math.max(sourceCount, lastNumber)) : 0
  const layout = useMemo<GridLayout>(() => {
    const widths = viewSource.map((i) => widthOverrides?.[i] ?? baseWidths[i] ?? 100)
    const offsets = columnOffsets(widths)
    const viewKinds = viewSource.map((i) => kinds[i] ?? 'text')
    return {
      widths,
      offsets,
      kinds: viewKinds,
      numeric: viewKinds.map((k) => k === 'number'),
      source: viewSource,
      frozen: Math.min(colState.frozen, widths.length),
      gutter,
      totalWidth: gutter + offsets[widths.length]!,
    }
  }, [viewSource, baseWidths, widthOverrides, kinds, gutter, colState.frozen])
  const frozenWidth = layout.offsets[layout.frozen] ?? 0
  const viewPrimaryKey = useMemo(
    () => (primaryKeyColumns ? new Set(viewSource.flatMap((src, view) => (primaryKeyColumns.has(src) ? [view] : []))) : undefined),
    [primaryKeyColumns, viewSource],
  )
  const viewForeignKeys = useMemo(() => {
    if (!foreignKeyColumns || foreignKeyColumns.size === 0) return undefined
    const out = new Map<number, string>()
    viewSource.forEach((src, view) => {
      const label = foreignKeyColumns.get(src)
      if (label !== undefined) out.set(view, label)
    })
    return out
  }, [foreignKeyColumns, viewSource])

  useEffect(() => {
    // Widths measured before the web fonts load are re-measured once they are available.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts?.load) return
    let cancelled = false
    void Promise.all([fonts.load(CELL_FONT), fonts.load(HEADER_FONT)])
      .then((loaded) => {
        if (!cancelled && loaded.some((list) => list.length > 0)) setFontsVersion((v) => v + 1)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // --- row order: client-side sort, value filters, "only matching rows" ------------------------
  const sortKeys = useMemo<SortKey[]>(
    () =>
      effectiveSort.flatMap((s) => {
        const col = columns.findIndex((c) => c.name === s.column)
        return col >= 0 ? [{ col, direction: s.direction, kind: kinds[col] ?? 'text' }] : []
      }),
    [effectiveSort, columns, kinds],
  )
  const sorted = useMemo(() => (serverSort ? null : sortedOrder(rows, sortKeys)), [serverSort, rows, sortKeys])

  // Typing in the find bar re-filters on a deferred value, so large results stay responsive.
  const findQuery = useDeferredValue(find.open ? find.query : '')
  const matcher = useMemo(() => makeMatcher(findQuery, find.caseSensitive), [findQuery, find.caseSensitive])
  const matchOnly = !!matcher && find.onlyMatching
  const filtering = valueFilters.length > 0 || matchOnly
  const order = useMemo(
    () => (filtering ? filteredOrder(rows, sorted, columns.length, valueFilters, matchOnly ? matcher : null) : sorted),
    [filtering, rows, sorted, columns.length, valueFilters, matchOnly, matcher],
  )
  const rowCount = order ? order.length : sourceCount
  const sourceRow = useCallback((view: number) => (order ? (order[view] ?? view) : view), [order])

  // --- row identity ----------------------------------------------------------------------------
  // The selection (and the open editor) live in view coordinates. When the rows or their order
  // change — a page appended under a client-side sort, a pending insert added above, a re-sort, a
  // filter — they are moved to wherever the same rows now are, so actions never land on rows the
  // user did not pick. Rows are identified by rowKey, else by source index (stable for appended pages).
  const [tracked, setTracked] = useState({ rows, order, rowKey })
  if (tracked.rows !== rows || tracked.order !== order) {
    setTracked({ rows, order, rowKey })
    const sameMapping = !tracked.order && !order && !tracked.rowKey && !rowKey
    if (!sameMapping && !resetting && (selection || editing)) {
      const keyIn = (view: number, o: readonly number[] | null, rk: ((row: number) => string) | undefined) => {
        const src = o ? o[view] : view
        if (src === undefined) return undefined
        return rk ? rk(src) : String(src)
      }
      const wanted = new Map<string, number>()
      const want = (view: number | undefined) => {
        if (view === undefined) return
        const key = keyIn(view, tracked.order, tracked.rowKey)
        if (key !== undefined) wanted.set(key, -1)
      }
      want(selection?.anchor.row)
      want(selection?.focus.row)
      want(editing?.row)
      let missing = wanted.size
      for (let v = 0; v < rowCount && missing > 0; v++) {
        const key = keyIn(v, order, rowKey)
        if (key !== undefined && wanted.get(key) === -1) {
          wanted.set(key, v)
          missing--
        }
      }
      const moved = (view: number) => {
        const key = keyIn(view, tracked.order, tracked.rowKey)
        const next = key === undefined ? undefined : wanted.get(key)
        return next !== undefined && next >= 0 ? next : view
      }
      if (selection) {
        const anchor = moved(selection.anchor.row)
        const focus = moved(selection.focus.row)
        if (anchor !== selection.anchor.row || focus !== selection.focus.row) {
          setSelection({ ...selection, anchor: { ...selection.anchor, row: anchor }, focus: { ...selection.focus, row: focus } })
        }
      }
      if (editing && moved(editing.row) !== editing.row) setEditing({ ...editing, row: moved(editing.row) })
    }
  }
  // Same for columns: hiding / moving columns keeps the selection on the same source columns.
  const [trackedColumns, setTrackedColumns] = useState(viewSource)
  if (trackedColumns !== viewSource) {
    setTrackedColumns(viewSource)
    if (!resetting && selection) {
      const remap = (view: number) => {
        const next = viewSource.indexOf(trackedColumns[view] ?? -1)
        return next >= 0 ? next : Math.min(view, Math.max(viewSource.length - 1, 0))
      }
      setSelection({ ...selection, anchor: { ...selection.anchor, col: remap(selection.anchor.col) }, focus: { ...selection.focus, col: remap(selection.focus.col) } })
    }
    if (editing) setEditing(null)
  }

  // --- selection -----------------------------------------------------------------------------
  const sel = clampSelection(selection, rowCount, colCount)
  const rect = selectionRect(sel, rowCount, colCount)
  const active: CellPos | null = sel && rowCount > 0 ? sel.anchor : null

  const reportSelection = useCallback(
    (s: Selection | null) => {
      const reported = toGridSelection(s, rowCount, colCount, sourceRow)
      if (!reported) return null
      const r = selectionRect(s, rowCount, colCount)
      return {
        anchor: { ...reported.anchor, col: srcCol(reported.anchor.col) },
        focus: { ...reported.focus, col: srcCol(reported.focus.col) },
        rows: r && r.r1 - r.r0 + 1 <= SELECTED_ROWS_LIMIT ? selectedSourceRows(r, sourceRow) : undefined,
      }
    },
    [rowCount, colCount, sourceRow, srcCol],
  )
  const lastEmitted = useRef<string>('null')
  useEffect(() => {
    if (!onSelectionChange) return
    const reported = reportSelection(sel)
    const key = JSON.stringify(reported)
    if (key === lastEmitted.current) return
    lastEmitted.current = key
    onSelectionChange(reported)
  }, [sel, reportSelection, onSelectionChange])

  // --- virtualization ------------------------------------------------------------------------
  const rowVirtualizer = useVirtualizer({
    count: rowCount + (hasMore ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: HEADER_HEIGHT,
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => layout.widths[i] ?? 100,
    overscan: 3,
    paddingStart: gutter,
  })
  useLayoutEffect(() => {
    columnVirtualizer.measure()
  }, [columnVirtualizer, layout])

  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualCols = columnVirtualizer.getVirtualItems()
  const colStart = virtualCols[0]?.index ?? 0
  const colEnd = virtualCols[virtualCols.length - 1]?.index ?? -1
  const lastVisibleRow = virtualRows[virtualRows.length - 1]?.index ?? -1

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Infinite scroll: ask for more when the viewport is within LOAD_MORE_THRESHOLD rows of the end.
  // One request per row count: when a load fails (or brings nothing), auto-loading stops until the
  // rows change or the user asks explicitly — no retry loop. Under a client-side sort or filter the
  // loaded rows are shown as they are: appending pages while scrolling would reshuffle the view.
  const loadRequestedAt = useRef<number | null>(null)
  const autoLoad = hasMore && !!onLoadMore && order === null
  useEffect(() => {
    if (!autoLoad || loadingMore || lastVisibleRow < 0) return
    if (lastVisibleRow < sourceCount - LOAD_MORE_THRESHOLD || loadRequestedAt.current === sourceCount) return
    loadRequestedAt.current = sourceCount
    onLoadMore?.()
  }, [autoLoad, loadingMore, onLoadMore, lastVisibleRow, sourceCount])
  const loadMoreNow = () => {
    loadRequestedAt.current = sourceCount
    onLoadMore?.()
  }

  // A new page / filter, or a new sort order: show the top of it.
  const scrollTopPending = useRef(false)
  const firstReset = useRef(true)
  useLayoutEffect(() => {
    if (firstReset.current) {
      firstReset.current = false
      return
    }
    loadRequestedAt.current = null
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [resetKey])
  useLayoutEffect(() => {
    if (!scrollTopPending.current) return
    scrollTopPending.current = false
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [order])

  const ensureVisible = useCallback(
    (pos: CellPos) => {
      const el = scrollRef.current
      if (!el) return
      const top = HEADER_HEIGHT + pos.row * ROW_HEIGHT
      const bottom = top + ROW_HEIGHT
      if (top < el.scrollTop + HEADER_HEIGHT) el.scrollTop = top - HEADER_HEIGHT
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
      if (pos.col < layout.frozen) return // frozen columns are always in view
      // the frozen columns cover the left of the viewport
      const leftEdge = layout.gutter + frozenWidth
      const left = layout.gutter + (layout.offsets[pos.col] ?? 0)
      const right = left + (layout.widths[pos.col] ?? 0)
      if (left < el.scrollLeft + leftEdge) el.scrollLeft = left - leftEdge
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(left - leftEdge, right - el.clientWidth)
    },
    [layout, frozenWidth],
  )

  const focusGrid = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), [])

  // --- editing -------------------------------------------------------------------------------
  const canEditColumn = useCallback(
    (col: number) => editable && !!(onCellEdit || onCellsEdit) && col >= 0 && col < colCount && !readOnlyColumns?.has(srcCol(col)),
    [editable, onCellEdit, onCellsEdit, colCount, readOnlyColumns, srcCol],
  )
  const canEditRow = useCallback((view: number) => getRowState?.(sourceRow(view)) !== 'deleted', [getRowState, sourceRow])
  const canEditCell = useCallback((pos: CellPos) => canEditColumn(pos.col) && canEditRow(pos.row), [canEditColumn, canEditRow])

  const valueAt = useCallback((pos: CellPos): CellValue => rows[sourceRow(pos.row)]?.[srcCol(pos.col)] ?? null, [rows, sourceRow, srcCol])
  const placeholderAt = useCallback(
    (pos: CellPos): boolean => getCellPlaceholder?.(sourceRow(pos.row), srcCol(pos.col)) !== undefined,
    [getCellPlaceholder, sourceRow, srcCol],
  )
  const kindAt = (col: number): ColumnKind => layout.kinds[col] ?? 'text'

  const applyEdits = (edits: GridCellEdit[]) => {
    if (edits.length === 0) return
    if (onCellsEdit) onCellsEdit(edits)
    else for (const e of edits) onCellEdit?.(e.row, e.col, e.value)
  }

  const startEdit = (pos: CellPos, typed?: string): boolean => {
    if (!canEditCell(pos)) return false
    const text = typed ?? (placeholderAt(pos) ? '' : editText(valueAt(pos)))
    ensureVisible(pos)
    setEditing({ row: pos.row, col: pos.col, initial: text, caretAtEnd: typed !== undefined, multiline: needsTextarea(editText(valueAt(pos))) || needsTextarea(text) })
    return true
  }

  const commitValue = (pos: CellPos, next: CellValue) => {
    const original = valueAt(pos)
    if (placeholderAt(pos) || !sameValue(next, original)) applyEdits([{ row: sourceRow(pos.row), col: srcCol(pos.col), value: next }])
  }

  const commitEdit = (text: string, move: CommitMove) => {
    const current = editing
    setEditing(null)
    focusGrid()
    if (!current) return
    const pos = { row: current.row, col: current.col }
    const original = valueAt(pos)
    // opening the editor on NULL and leaving it empty keeps NULL
    if (!(original === null && text === '')) commitValue(pos, parseEditedText(text, original, kindAt(pos.col)))
    if (move) {
      const next = tabSelection(cellSelection(pos), move === 'left', rowCount, colCount)
      if (next) {
        setSelection(next)
        ensureVisible(next.anchor)
      }
    }
  }

  const cancelEdit = () => {
    setEditing(null)
    focusGrid()
  }

  const setNullOnSelection = () => {
    if (!rect || !(onCellEdit || onCellsEdit)) return
    if (rectCellCount(rect) > BULK_EDIT_LIMIT) {
      toast.warning('Selection too large', { description: `Set NULL works on up to ${formatCount(BULK_EDIT_LIMIT)} cells at a time.` })
      return
    }
    const skipped = new Set<string>()
    const edits: GridCellEdit[] = []
    for (let r = rect.r0; r <= rect.r1; r++) {
      if (!canEditRow(r)) continue
      for (let c = rect.c0; c <= rect.c1; c++) {
        if (!canEditColumn(c)) continue
        const column = viewColumns[c]
        if (column?.nullable === false) {
          skipped.add(column.name)
          continue
        }
        if (valueAt({ row: r, col: c }) !== null || placeholderAt({ row: r, col: c })) edits.push({ row: sourceRow(r), col: srcCol(c), value: null })
      }
    }
    applyEdits(edits)
    if (skipped.size > 0) toast.warning('Some cells kept their value', { description: `${[...skipped].join(', ')} cannot be NULL.` })
  }

  // --- paste ---------------------------------------------------------------------------------
  /** Paste a block of text at the selection (a single value fills the whole selection). */
  const pasteText = (text: string) => {
    if (!rect || !editable) return
    const block = parsePastedText(text)
    const fill = block.length === 1 && (block[0]?.length ?? 0) === 1 && rectCellCount(rect) > 1
    const height = fill ? rect.r1 - rect.r0 + 1 : block.length
    const width = fill ? rect.c1 - rect.c0 + 1 : Math.max(...block.map((r) => r.length))
    if (height * width > PASTE_CELL_LIMIT) {
      toast.warning('Too much to paste', { description: `Paste works on up to ${formatCount(PASTE_CELL_LIMIT)} cells at a time.` })
      return
    }
    const edits: GridCellEdit[] = []
    const added: (CellValue | undefined)[][] = []
    let skipped = 0
    let lostRows = 0
    for (let i = 0; i < height; i++) {
      const view = rect.r0 + i
      const fields = fill ? null : (block[i] ?? [])
      const field = (j: number) => (fill ? block[0]![0]! : (fields?.[j] ?? ''))
      if (view >= rowCount) {
        // past the last row: new rows, when the caller can add them (not inside a filtered view)
        if (!onPasteRows || filtering) {
          lostRows++
          continue
        }
        const values: (CellValue | undefined)[] = new Array<CellValue | undefined>(columns.length).fill(undefined)
        for (let j = 0; j < width; j++) {
          const c = rect.c0 + j
          if (c >= colCount || !canEditColumn(c)) continue
          values[srcCol(c)] = pastedValue(field(j), null, kindAt(c))
        }
        added.push(values)
        continue
      }
      for (let j = 0; j < width; j++) {
        const c = rect.c0 + j
        if (c >= colCount || !canEditCell({ row: view, col: c })) {
          skipped++
          continue
        }
        const pos = { row: view, col: c }
        const original = valueAt(pos)
        const value = pastedValue(field(j), original, kindAt(c))
        if (placeholderAt(pos) || !sameValue(value, original)) edits.push({ row: sourceRow(view), col: srcCol(c), value })
      }
    }
    applyEdits(edits)
    if (added.length > 0) onPasteRows?.(added)
    const lastRow = Math.min(rect.r0 + height - 1, rowCount - 1)
    const lastCol = Math.min(rect.c0 + width - 1, colCount - 1)
    if (lastRow >= rect.r0) setSelection({ anchor: { row: rect.r0, col: rect.c0 }, focus: { row: lastRow, col: lastCol }, mode: 'cells' })
    const notes: string[] = []
    if (added.length > 0) notes.push(`${pluralize(added.length, 'new row')} added`)
    if (skipped > 0) notes.push(`${pluralize(skipped, 'cell')} skipped (read-only or deleted)`)
    if (lostRows > 0) notes.push(`${pluralize(lostRows, 'row')} past the end not pasted`)
    if (height * width > 1 || notes.length > 0) {
      toast.message(`Pasted ${pluralize(height, 'row')} × ${pluralize(width, 'column')}`, { duration: 2400, description: notes.join(' · ') || undefined })
    }
  }

  const pasteHandler = useRef<(event: ClipboardEvent) => void>(() => undefined)
  pasteHandler.current = (event: ClipboardEvent) => {
    if (document.activeElement !== scrollRef.current || editing || !editable) return
    const text = event.clipboardData?.getData('text/plain')
    if (text === undefined) return
    event.preventDefault()
    pasteText(text)
  }

  const pasteFromClipboard = async () => {
    try {
      pasteText(await navigator.clipboard.readText())
    } catch (error) {
      toast.error('Could not read the clipboard', error)
    }
  }

  // --- copy ----------------------------------------------------------------------------------
  const selectionText = useCallback(
    (format: CopyFormat, withHeaders: boolean): string | null => {
      if (!rect) return null
      const slice = sliceRect(rect, columns, rows, sourceRow, srcCol)
      if (format === 'in-list') return toSqlInList(slice.rows.map((r) => r[0] ?? null), dialect ?? 'postgres', slice.columns[0]?.dataType)
      if (format === 'tsv') {
        // a single value is copied verbatim (no quoting)
        if (!withHeaders && slice.rows.length === 1 && slice.columns.length === 1) return valueText(slice.rows[0]![0] ?? null)
        return toTSV(slice.columns, slice.rows, { header: withHeaders })
      }
      return formatRows(format, slice.columns, slice.rows, { tableName, dialect: dialect ?? 'postgres', header: withHeaders })
    },
    [rect, columns, rows, sourceRow, srcCol, dialect, tableName],
  )

  const copyFromMenu = async (format: CopyFormat, headers: boolean | 'auto') => {
    // "Copy" follows the ⌘C rule: whole columns are copied with their header row.
    const withHeaders = headers === 'auto' ? coversWholeColumns(sel) : headers
    const text = selectionText(format, withHeaders)
    if (text === null) return
    try {
      await copyText(text)
      if (headers !== 'auto' && (format !== 'tsv' || withHeaders)) {
        const label = { csv: 'CSV', tsv: 'TSV', json: 'JSON', markdown: 'Markdown', sql: 'SQL INSERT', 'in-list': 'SQL IN list' }[format]
        toast.success(`Copied as ${label}`, { duration: 1600, description: rect ? pluralize(rect.r1 - rect.r0 + 1, 'row') : undefined })
      }
    } catch (error) {
      toast.error('Could not copy', error)
    }
  }

  // Cmd/Ctrl+C and Edit ▸ Copy dispatch a DOM "copy" event; answer it while the grid has focus.
  const copyHandler = useRef<(event: ClipboardEvent) => void>(() => undefined)
  copyHandler.current = (event: ClipboardEvent) => {
    if (document.activeElement !== scrollRef.current || editing) return
    const text = selectionText('tsv', coversWholeColumns(sel))
    if (text === null || !event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    event.preventDefault()
  }
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => copyHandler.current(event)
    const onPaste = (event: ClipboardEvent) => pasteHandler.current(event)
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  // --- sorting actions -----------------------------------------------------------------------
  // The selection follows its rows to their new positions (see row identity); the view shows the top
  // of the new order.
  const applySort = (next: SortSpec[]) => {
    if (!serverSort) scrollTopPending.current = true
    if (controlledSort) onSortChange(next)
    else setSortState(next)
  }
  const onSortClick = (col: number, multi: boolean) => {
    focusGrid()
    const name = viewColumns[col]?.name
    if (name !== undefined) applySort(nextSort(effectiveSort, name, multi))
  }

  // --- find & value filters ------------------------------------------------------------------
  const matches = useMemo(
    () => (matcher ? collectMatches(rows, rowCount, sourceRow, viewSource, matcher) : null),
    [matcher, rows, rowCount, sourceRow, viewSource],
  )
  const currentMatch = active && matches ? matches.matches.findIndex((m) => m.row === active.row && m.col === active.col) : -1

  const goToMatch = (backwards: boolean, inclusive = false) => {
    if (!matches || matches.matches.length === 0) return
    const index = nearestMatch(matches.matches, active, backwards, inclusive)
    const target = matches.matches[index]
    if (!target) return
    setSelection(cellSelection(target))
    ensureVisible(target)
  }

  // Typing a query moves to the first match at or after the active cell (like an editor's find).
  const lastJumped = useRef<string>('')
  useEffect(() => {
    if (!matcher || !matches) {
      lastJumped.current = ''
      return
    }
    const key = `${findQuery}\u0000${find.caseSensitive}`
    if (lastJumped.current === key) return
    lastJumped.current = key
    goToMatch(false, true)
    // only when the query changes, not when the rows do
  }, [matcher, matches])

  const openFind = useCallback(() => {
    setFind((f) => ({ ...f, open: true }))
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }, [])
  const closeFind = () => {
    setFind((f) => ({ ...f, open: false, onlyMatching: false }))
    focusGrid()
  }

  const filterByValue = (exclude: boolean) => {
    if (!active) return
    const value = valueAt(active)
    const col = srcCol(active.col)
    if (onFilterByValue) {
      onFilterByValue(col, value, exclude)
      return
    }
    scrollTopPending.current = true
    setValueFilters((f) => [...f.filter((x) => !(x.col === col && sameValue(x.value, value) && x.exclude === exclude)), { col, value, exclude }])
  }
  const clearFilters = useCallback(() => setValueFilters(NO_FILTERS), [])

  // --- column arrangement --------------------------------------------------------------------
  const hideColumn = (view: number) => {
    if (colCount <= 1) return
    setColumnState(setColumnHidden(colState, srcCol(view), true))
  }
  const freezeColumns = (view: number, freeze: boolean) => setColumnState(freezeThrough(colState, freeze ? view : -1))

  // --- palette commands ----------------------------------------------------------------------
  const commandHandle = useRef<GridCommandHandle | null>(null)
  const latest = useRef({ colState, valueFilters, setColumnState, clearFilters, openFind })
  latest.current = { colState, valueFilters, setColumnState, clearFilters, openFind }
  useEffect(() => {
    ensureGridCommands()
    const handle: GridCommandHandle = {
      isAlive: () => {
        const el = scrollRef.current
        return !!el && el.isConnected && el.offsetParent !== null
      },
      openFind: () => latest.current.openFind(),
      openColumns: () => setColumnsMenuOpen(true),
      showAllColumns: () => latest.current.setColumnState({ ...latest.current.colState, hidden: [] }),
      hasHiddenColumns: () => latest.current.colState.hidden.length > 0,
      clearFilters: () => latest.current.clearFilters(),
      hasFilters: () => latest.current.valueFilters.length > 0,
    }
    commandHandle.current = handle
    return () => releaseGrid(handle)
  }, [])

  // --- column sizing -------------------------------------------------------------------------
  const setColumnWidth = useCallback(
    (view: number, width: number) => {
      const col = viewSource[view]
      if (col === undefined) return
      setOverrides((o) => ({ signature, widths: { ...(o.signature === signature ? o.widths : {}), [col]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } }))
    },
    [signature, viewSource],
  )

  const autoFit = useCallback(
    (view: number) => {
      const col = viewSource[view]
      const column = col === undefined ? undefined : columns[col]
      if (col === undefined || !column) return
      const viewRows = order ? order.map((i) => rows[i]!) : rows
      const options = { nullDisplay, sampleSize: 1000, min: MIN_COLUMN_WIDTH, max: AUTOFIT_MAX_WIDTH, keyColumns: primaryKeyColumns }
      setColumnWidth(view, columnWidth(column, col, kinds[col] ?? 'text', viewRows, options))
    },
    [viewSource, columns, order, rows, kinds, nullDisplay, setColumnWidth, primaryKeyColumns],
  )

  const onResizeStart = useCallback(
    (col: number, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = layout.widths[col] ?? 100
      let frame = 0
      const move = (e: PointerEvent) => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => setColumnWidth(col, startWidth + e.clientX - startX))
      }
      const up = () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [layout, setColumnWidth],
  )

  // --- pointer selection ---------------------------------------------------------------------
  const drag = useRef<{ kind: DragKind; x: number; y: number; frame: number } | null>(null)
  const selectionRef = useRef(sel)
  selectionRef.current = sel

  /** View column under a client x (the frozen columns stay at the left of the viewport). */
  const columnAtClientX = useCallback(
    (clientX: number): number => {
      const scroll = scrollRef.current
      const body = bodyRef.current
      if (!scroll) return 0
      const fromViewport = clientX - scroll.getBoundingClientRect().left - layout.gutter
      if (layout.frozen > 0 && fromViewport >= 0 && fromViewport < frozenWidth) return columnAt(layout.offsets, fromViewport)
      const left = body ? body.getBoundingClientRect().left : scroll.getBoundingClientRect().left - scroll.scrollLeft
      return columnAt(layout.offsets, clientX - left - layout.gutter)
    },
    [layout, frozenWidth],
  )

  /** Cell under a client point (clamped into the grid while dragging). */
  const hitTest = useCallback(
    (clientX: number, clientY: number, clamp: boolean): { row: number; col: number; gutter: boolean } | null => {
      const scroll = scrollRef.current
      const body = bodyRef.current
      if (!scroll || !body || colCount === 0) return null
      const s = scroll.getBoundingClientRect()
      const b = body.getBoundingClientRect()
      const inGutter = layout.gutter > 0 && clientX - s.left < layout.gutter
      const fromViewport = clientX - s.left - layout.gutter
      const inFrozen = layout.frozen > 0 && fromViewport >= 0 && fromViewport < frozenWidth
      const x = inFrozen ? fromViewport : clientX - b.left - layout.gutter
      const rowRaw = Math.floor((clientY - b.top) / ROW_HEIGHT)
      const contentWidth = layout.offsets[colCount] ?? 0
      if (!clamp && (rowRaw < 0 || rowRaw >= rowCount || (!inGutter && (x < 0 || x >= contentWidth)))) return null
      return { row: Math.min(Math.max(rowRaw, 0), rowCount - 1), col: columnAt(layout.offsets, x), gutter: inGutter }
    },
    [colCount, rowCount, layout, frozenWidth],
  )

  const updateDrag = useCallback(
    (clientX: number, clientY: number) => {
      const d = drag.current
      const current = selectionRef.current
      if (!d || !current) return
      if (d.kind === 'columns') {
        setSelection({ ...current, focus: { row: current.focus.row, col: columnAtClientX(clientX) }, mode: 'columns' })
        return
      }
      const hit = hitTest(clientX, clientY, true)
      if (!hit) return
      if (d.kind === 'rows') setSelection({ ...current, focus: { row: hit.row, col: current.focus.col }, mode: 'rows' })
      else setSelection({ ...current, focus: { row: hit.row, col: hit.col }, mode: 'cells' })
    },
    [hitTest, columnAtClientX],
  )

  const startDrag = (kind: DragKind, clientX: number, clientY: number) => {
    drag.current = { kind, x: clientX, y: clientY, frame: 0 }
    // Auto-scroll while the pointer is outside the viewport.
    const tick = () => {
      const d = drag.current
      const el = scrollRef.current
      if (!d || !el) return
      const r = el.getBoundingClientRect()
      const speed = (over: number) => Math.sign(over) * Math.min(48, Math.max(4, Math.abs(over) / 2))
      const leftEdge = r.left + layout.gutter + frozenWidth
      const dy = d.kind === 'columns' ? 0 : d.y < r.top + HEADER_HEIGHT ? speed(d.y - (r.top + HEADER_HEIGHT)) : d.y > r.bottom ? speed(d.y - r.bottom) : 0
      const dx = d.kind === 'rows' ? 0 : d.x < leftEdge ? speed(d.x - leftEdge) : d.x > r.right ? speed(d.x - r.right) : 0
      if (dx || dy) {
        el.scrollTop += dy
        el.scrollLeft += dx
        updateDrag(d.x, d.y)
      }
      d.frame = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      d.x = e.clientX
      d.y = e.clientY
      updateDrag(e.clientX, e.clientY)
    }
    const up = () => {
      const d = drag.current
      if (d) cancelAnimationFrame(d.frame)
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    drag.current.frame = requestAnimationFrame(tick)
  }

  const onBodyPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return
    const hit = hitTest(e.clientX, e.clientY, false)
    focusGrid()
    if (!hit) return
    if (e.button === 2) {
      // right-click keeps a selection that contains the cell, otherwise selects it
      if (hit.gutter ? !(rect && hit.row >= rect.r0 && hit.row <= rect.r1 && rect.c0 === 0 && rect.c1 === colCount - 1) : !inRect(rect, hit.row, hit.col)) {
        setSelection(hit.gutter ? rowSelection(hit.row, hit.row) : cellSelection({ row: hit.row, col: hit.col }))
      }
      return
    }
    e.preventDefault()
    if (hit.gutter) {
      const next = e.shiftKey && sel ? { anchor: sel.anchor, focus: { row: hit.row, col: sel.anchor.col }, mode: 'rows' as const } : rowSelection(hit.row, hit.row)
      setSelection(next)
      selectionRef.current = next
      startDrag('rows', e.clientX, e.clientY)
      return
    }
    const pos = { row: hit.row, col: hit.col }
    const next: Selection = e.shiftKey && sel ? { anchor: sel.mode === 'all' ? { row: 0, col: 0 } : sel.anchor, focus: pos, mode: 'cells' } : cellSelection(pos)
    setSelection(next)
    selectionRef.current = next
    startDrag('cells', e.clientX, e.clientY)
  }

  const onBodyDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const hit = hitTest(e.clientX, e.clientY, false)
    if (!hit || hit.gutter) return
    const pos = { row: hit.row, col: hit.col }
    if (!startEdit(pos)) setInspector((s) => ({ ...s, open: true }))
  }

  const onColumnPointerDown = (col: number, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return
    focusGrid()
    if (e.button === 2) {
      if (!(rect && sel?.mode !== 'rows' && coversWholeColumns(sel) && col >= rect.c0 && col <= rect.c1)) setSelection(columnSelection(col, col))
      return
    }
    e.preventDefault()
    const anchorCol = e.shiftKey && sel ? sel.anchor.col : col
    const next = columnSelection(anchorCol, col)
    setSelection(next)
    selectionRef.current = next
    startDrag('columns', e.clientX, e.clientY)
  }

  // --- keyboard ------------------------------------------------------------------------------
  const pageRows = Math.max(1, Math.floor((viewport.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1)

  const applyMove = (move: Move, extend: boolean) => {
    const next = moveSelection(sel, move, extend, rowCount, colCount)
    if (!next) return
    setSelection(next)
    ensureVisible(extend ? next.focus : next.anchor)
  }

  const toggleInspector = () => setInspector((s) => ({ ...s, open: !s.open }))

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== scrollRef.current) return
    const mod = isMac() ? e.metaKey : e.ctrlKey
    const shift = e.shiftKey
    const arrow = (dr: number, dc: number) => applyMove(mod ? { kind: 'edge', dr, dc } : { kind: 'by', dr, dc }, shift)
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault()
        return arrow(-1, 0)
      case 'ArrowDown':
        e.preventDefault()
        return arrow(1, 0)
      case 'ArrowLeft':
        e.preventDefault()
        return arrow(0, -1)
      case 'ArrowRight':
        e.preventDefault()
        return arrow(0, 1)
      case 'Home':
        e.preventDefault()
        return applyMove(mod ? { kind: 'first' } : { kind: 'rowStart' }, shift)
      case 'End':
        e.preventDefault()
        return applyMove(mod ? { kind: 'last' } : { kind: 'rowEnd' }, shift)
      case 'PageUp':
        e.preventDefault()
        return applyMove({ kind: 'by', dr: -pageRows, dc: 0 }, shift)
      case 'PageDown':
        e.preventDefault()
        return applyMove({ kind: 'by', dr: pageRows, dc: 0 }, shift)
      case 'Tab': {
        if (e.altKey || mod) return
        const next = tabSelection(sel, shift, rowCount, colCount)
        if (!next) return // let focus leave the grid at either end
        e.preventDefault()
        setSelection(next)
        ensureVisible(next.anchor)
        return
      }
      case 'Escape':
        if (sel && rectCellCount(rect) > 1) {
          e.preventDefault()
          setSelection(cellSelection(sel.anchor))
        } else if (inspector.open) {
          e.preventDefault()
          setInspector((s) => ({ ...s, open: false }))
        } else if (find.open) {
          e.preventDefault()
          closeFind()
        }
        return
      case 'Enter':
      case 'F2':
        if (mod || e.altKey || !active) return
        if (shift) {
          // Shift+Enter / Enter step through the find matches while the bar is open
          if (find.open && matches?.matches.length) {
            e.preventDefault()
            goToMatch(true)
          }
          return
        }
        if (startEdit(active)) e.preventDefault()
        else if (find.open && matches?.matches.length) {
          e.preventDefault()
          goToMatch(false)
        }
        return
      case 'Backspace':
      case 'Delete':
        if (mod && editable && rect) {
          e.preventDefault()
          setNullOnSelection()
        }
        return
      case ' ': {
        if (mod || e.altKey) return
        e.preventDefault()
        if (active && layout.kinds[active.col] === 'boolean' && canEditCell(active)) {
          const v = valueAt(active)
          if (v === null || typeof v === 'boolean') commitValue(active, v === null ? true : !v)
          else if (v === 0 || v === 1) commitValue(active, v === 1 ? 0 : 1)
          return
        }
        toggleInspector()
        return
      }
    }
    if (mod && !shift && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      if (rowCount > 0 && colCount > 0) setSelection(allSelection(active ?? { row: 0, col: 0 }))
      return
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFind()
      return
    }
    // Typing a character starts editing with it.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && active) {
      if (startEdit(active, e.key)) e.preventDefault()
    }
  }

  // --- inspector -----------------------------------------------------------------------------
  const onInspectorResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = inspector.width
    const max = Math.max(INSPECTOR_MIN_WIDTH, (rootRef.current?.clientWidth ?? 1000) * 0.7)
    const move = (ev: PointerEvent) => {
      const width = Math.min(max, Math.max(INSPECTOR_MIN_WIDTH, startWidth - (ev.clientX - startX)))
      setInspector((s) => ({ ...s, width }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // --- render --------------------------------------------------------------------------------
  // whole-row selections do not tint the headers, whole-column selections do not tint row numbers
  const selC0 = rect && sel?.mode !== 'rows' ? rect.c0 : -1
  const selC1 = rect && sel?.mode !== 'rows' ? rect.c1 : -1
  const rowTint = rect && sel?.mode !== 'columns' ? rect : null
  const wholeColumns = coversWholeColumns(sel) || (!!rect && rect.r0 === 0 && rect.r1 === rowCount - 1 && rowCount > 1)
  const singleCell = rectCellCount(rect) <= 1

  const rowElements = []
  for (const item of virtualRows) {
    const view = item.index
    const top = item.start - HEADER_HEIGHT
    if (view >= rowCount) {
      rowElements.push(
        <div key="__more" className="absolute left-0 flex" style={{ top, height: ROW_HEIGHT, width: Math.max(layout.totalWidth, viewport.width) }}>
          <div
            className="sticky left-0 flex shrink-0 items-center gap-2 whitespace-nowrap px-3 text-2xs text-subtle"
            style={{ width: viewport.width || undefined }}
          >
            {loadingMore ? (
              <>
                <Spinner size={12} /> Loading more rows…
              </>
            ) : (
              <>
                <span className="truncate">
                  {filtering ? 'More rows available · filters cover the loaded rows' : order ? 'More rows available · the sort covers the loaded rows' : 'More rows available'}
                </span>
                {onLoadMore && (
                  <button
                    type="button"
                    className="shrink-0 rounded-[4px] px-1 font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-soft"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={loadMoreNow}
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </div>
        </div>,
      )
      continue
    }
    const src = sourceRow(view)
    const row = rows[src]
    if (!row) continue
    rowElements.push(
      <GridRow
        key={rowKey ? rowKey(src) : src}
        gridId={gridId}
        viewRow={view}
        sourceRow={src}
        row={row}
        top={top}
        colStart={colStart}
        colEnd={colEnd}
        layout={layout}
        showRowNumbers={showRowNumbers}
        nullDisplay={nullDisplay}
        rowState={getRowState?.(src)}
        rowNumber={getRowNumber ? getRowNumber(src) : view + 1}
        rowSelected={showRowNumbers && !!rowTint && view >= rowTint.r0 && view <= rowTint.r1}
        isCellModified={isCellModified}
        getCellPlaceholder={getCellPlaceholder}
        match={matcher}
      />,
    )
  }

  /** Box of a cell range in body coordinates; frozen columns follow the horizontal scroll. */
  const cellBox = (r0: number, r1: number, c0: number, c1: number) => ({
    left: layout.gutter + (layout.offsets[c0] ?? 0) + (c0 < layout.frozen ? scrollLeft : 0),
    top: r0 * ROW_HEIGHT,
    width: (layout.offsets[c1 + 1] ?? 0) - (layout.offsets[c0] ?? 0),
    height: (r1 - r0 + 1) * ROW_HEIGHT,
  })
  /** Selection overlay boxes: one for the frozen part, one for the scrolling part. */
  const selectionBoxes = (r: NonNullable<typeof rect>) => {
    const boxes: { key: string; style: ReturnType<typeof cellBox>; frozen: boolean }[] = []
    if (r.c0 < layout.frozen) boxes.push({ key: 'f', style: cellBox(r.r0, r.r1, r.c0, Math.min(r.c1, layout.frozen - 1)), frozen: true })
    if (r.c1 >= layout.frozen) boxes.push({ key: 's', style: cellBox(r.r0, r.r1, Math.max(r.c0, layout.frozen), r.c1), frozen: false })
    return boxes
  }

  const menuContext: GridMenuContext = {
    selection: reportSelection(sel),
    rows: selectedSourceRows(rect, sourceRow),
    columns: rect ? viewSource.slice(rect.c0, rect.c1 + 1) : [],
    active: active ? { row: sourceRow(active.row), col: srcCol(active.col) } : null,
  }
  const extraItems = contextMenuItems ? contextMenuItems(menuContext) : []
  const activeColumn = active ? viewColumns[active.col] : undefined
  const activeSort = activeColumn ? effectiveSort.find((s) => s.column === activeColumn.name)?.direction : undefined
  const summary = rect && !singleCell ? `${pluralize(rect.r1 - rect.r0 + 1, 'row')} × ${pluralize(rect.c1 - rect.c0 + 1, 'column')}` : undefined

  const empty = rowCount === 0
  const editBox = editing ? cellBox(editing.row, editing.row, editing.col, editing.col) : null
  const editShortcut = formatShortcut('CmdOrCtrl+C')
  const filterLabel = (f: ValueFilter) => {
    const name = columns[f.col]?.name ?? '?'
    if (f.value === null) return `${name} ${f.exclude ? 'is not' : 'is'} NULL`
    const text = valueText(f.value)
    return `${name} ${f.exclude ? '≠' : '='} ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`
  }

  return (
    <div ref={rootRef} className={cn('flex h-full min-h-0 w-full min-w-0 bg-surface', className)}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {valueFilters.length > 0 && (
          <div role="status" className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-b border-line bg-panel px-2 text-xs">
            <Filter size={12} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
            <span className="shrink-0 text-subtle tabular">
              {formatCount(rowCount)} of {formatCount(sourceCount)} loaded rows
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {valueFilters.map((f, i) => (
                <span key={i} className="flex h-5 min-w-0 shrink items-center gap-1 rounded-[4px] bg-accent-soft pl-1.5 pr-0.5 font-mono text-2xs text-accent">
                  <span className="truncate">{filterLabel(f)}</span>
                  <button
                    type="button"
                    aria-label={`Remove filter ${filterLabel(f)}`}
                    className="flex size-4 shrink-0 items-center justify-center rounded-[3px] outline-none hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => setValueFilters((all) => all.filter((_, j) => j !== i))}
                  >
                    <X size={10} strokeWidth={2.25} />
                  </button>
                </span>
              ))}
            </div>
            <Button size="xs" variant="ghost" className="shrink-0 text-muted" onClick={clearFilters}>
              Clear
            </Button>
          </div>
        )}
        {find.open && (
          <div className="absolute right-4 z-40" style={{ top: (valueFilters.length > 0 ? 28 : 0) + HEADER_HEIGHT + 6 }}>
            <GridFindBar
              state={find}
              total={matches ? matches.matches.length : null}
              capped={!!matches?.capped}
              current={currentMatch >= 0 ? currentMatch + 1 : undefined}
              partial={hasMore}
              inputRef={findInputRef}
              onChange={(patch) => setFind((f) => ({ ...f, ...patch }))}
              onNext={() => goToMatch(false)}
              onPrevious={() => goToMatch(true)}
              onClose={closeFind}
            />
          </div>
        )}
        <ContextMenu>
          <ContextMenuTrigger asChild disabled={colCount === 0}>
            <div
              ref={scrollRef}
              role="grid"
              tabIndex={0}
              aria-label={ariaLabel ?? 'Data grid'}
              aria-rowcount={rowCount + 1}
              aria-colcount={colCount}
              aria-multiselectable
              aria-activedescendant={active && !editing ? `${gridId}-${active.row}-${active.col}` : undefined}
              aria-description={`Arrow keys move, Shift extends, ${editShortcut} copies${editable ? ', Enter edits' : ''}, Space shows the value, ${formatShortcut('CmdOrCtrl+F')} finds.`}
              onKeyDown={onKeyDown}
              onScroll={layout.frozen > 0 ? (e) => setScrollLeft(e.currentTarget.scrollLeft) : undefined}
              onFocus={() => {
                setFocused(true)
                if (commandHandle.current) setActiveGrid(commandHandle.current)
              }}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
              }}
              className="relative isolate min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:outline-none"
            >
              {colCount > 0 && (
                <GridHeader
                  columns={viewColumns}
                  layout={layout}
                  colStart={colStart}
                  colEnd={colEnd}
                  sort={effectiveSort}
                  selC0={selC0}
                  selC1={selC1}
                  wholeColumns={wholeColumns}
                  allSelected={sel?.mode === 'all'}
                  showRowNumbers={showRowNumbers}
                  primaryKeyColumns={viewPrimaryKey}
                  foreignKeyColumns={viewForeignKeys}
                  trailing={
                    <GridColumnsMenu
                      columns={columns}
                      state={colState}
                      open={columnsMenuOpen}
                      onOpenChange={setColumnsMenuOpen}
                      onChange={setColumnState}
                      onReset={() => setColumnState(defaultColumnState(columns.length))}
                      onRestoreFocus={focusGrid}
                    />
                  }
                  onColumnPointerDown={onColumnPointerDown}
                  onCornerClick={() => {
                    focusGrid()
                    if (rowCount > 0) setSelection(allSelection())
                  }}
                  onSortClick={onSortClick}
                  onResizeStart={onResizeStart}
                  onAutoFit={autoFit}
                />
              )}
              {!empty && (
                <div
                  ref={bodyRef}
                  className="relative"
                  style={{ height: rowVirtualizer.getTotalSize(), width: layout.totalWidth }}
                  onPointerDown={onBodyPointerDown}
                  onDoubleClick={onBodyDoubleClick}
                >
                  {rowElements}
                  {rect &&
                    !singleCell &&
                    selectionBoxes(rect).map((b) => (
                      <div
                        key={b.key}
                        aria-hidden
                        className={cn('pointer-events-none absolute bg-selection shadow-[inset_0_0_0_1px_var(--c-accent-soft)]', b.frozen ? 'z-[8]' : 'z-[5]')}
                        style={b.style}
                      />
                    ))}
                  {active && !editing && (
                    <div
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute rounded-[1px] ring-[1.5px] ring-inset',
                        active.col < layout.frozen ? 'z-[9]' : 'z-[6]',
                        focused ? 'ring-accent' : 'ring-faint',
                      )}
                      style={cellBox(active.row, active.row, active.col, active.col)}
                    />
                  )}
                  {editing && editBox && (
                    <CellEditor
                      key={`${editing.row}:${editing.col}`}
                      {...editBox}
                      initial={editing.initial}
                      multiline={editing.multiline}
                      caretAtEnd={editing.caretAtEnd}
                      numeric={layout.numeric[editing.col] ?? false}
                      columnName={viewColumns[editing.col]?.name ?? ''}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                    />
                  )}
                </div>
              )}
              {empty && (
                <div
                  className="sticky left-0 flex items-center justify-center"
                  style={{ width: viewport.width || '100%', height: colCount > 0 ? Math.max(120, viewport.height - HEADER_HEIGHT) : viewport.height || '100%' }}
                >
                  {filtering && sourceCount > 0 ? (
                    <EmptyState
                      size="compact"
                      icon={SearchX}
                      title="No matching rows"
                      description={`None of the ${formatCount(sourceCount)} loaded rows match.`}
                      action={
                        <Button
                          size="xs"
                          onClick={() => {
                            clearFilters()
                            setFind((f) => ({ ...f, onlyMatching: false }))
                          }}
                        >
                          Show all rows
                        </Button>
                      }
                    />
                  ) : (
                    (emptyState ?? <EmptyState size="compact" icon={Rows3} title="No rows" description="The result set is empty." />)
                  )}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <GridContextMenu
            hasSelection={!!rect}
            singleColumn={!!rect && rect.c0 === rect.c1}
            summary={summary}
            inspectorOpen={inspector.open}
            canEdit={!!active && singleCell && canEditCell(active)}
            canSetNull={!!rect && editable && !!(onCellEdit || onCellsEdit) && (active ? canEditColumn(active.col) || !singleCell : false)}
            columnName={activeColumn?.name}
            sortDirection={activeSort}
            canFilterByValue={!!active && singleCell}
            filtered={valueFilters.length > 0}
            frozen={!active || active.col >= layout.frozen ? 'none' : active.col === layout.frozen - 1 ? 'last' : 'inside'}
            canHideColumn={colCount > 1}
            extraItems={
              editable && rect
                ? [{ label: 'Paste', shortcut: 'CmdOrCtrl+V', onSelect: () => void pasteFromClipboard() }, ...(extraItems.length > 0 ? [{ separator: true as const }] : []), ...extraItems]
                : extraItems
            }
            onCopy={(format, withHeaders) => void copyFromMenu(format, withHeaders)}
            onCopyColumnNames={() => {
              if (!rect) return
              void copyText(columnNames(viewColumns.slice(rect.c0, rect.c1 + 1))).catch((error: unknown) => toast.error('Could not copy', error))
            }}
            onToggleInspector={toggleInspector}
            onEdit={() => active && startEdit(active)}
            onSetNull={setNullOnSelection}
            onFilterByValue={filterByValue}
            onClearFilters={clearFilters}
            onFind={openFind}
            onSort={(direction) => activeColumn && applySort(setSort(effectiveSort, activeColumn.name, direction))}
            onAutoFit={() => active && autoFit(active.col)}
            onHideColumn={() => active && hideColumn(active.col)}
            onFreeze={(freeze) => active && freezeColumns(active.col, freeze)}
            onColumns={() => setColumnsMenuOpen(true)}
            onRestoreFocus={focusGrid}
          />
        </ContextMenu>
      </div>
      {inspector.open && (
        <CellInspector
          column={activeColumn}
          kind={active ? kindAt(active.col) : 'text'}
          value={active ? valueAt(active) : undefined}
          rowNumber={active ? (getRowNumber ? getRowNumber(sourceRow(active.row)) : active.row + 1) : undefined}
          cellKey={active ? `${rowKey ? rowKey(sourceRow(active.row)) : sourceRow(active.row)}:${srcCol(active.col)}` : undefined}
          editable={!!active && canEditCell(active)}
          nullDisplay={nullDisplay}
          width={inspector.width}
          onResizeStart={onInspectorResizeStart}
          onClose={() => {
            setInspector((s) => ({ ...s, open: false }))
            focusGrid()
          }}
          onApply={(value) => {
            if (!active) return
            const original = valueAt(active)
            commitValue(active, typeof value === 'string' ? parseEditedText(value, original, kindAt(active.col)) : value)
          }}
        />
      )}
    </div>
  )
}
