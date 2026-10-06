// Column arrangement of a DataGrid: display order, hidden columns and frozen leading columns.
// Pure helpers plus a small per-key memory (e.g. one per table), so a table tab keeps its
// arrangement across tab switches and restarts.
import type { ColumnMeta } from '@shared/types'

export interface ColumnState {
  /** Source column indices in display order (every column, hidden ones included). */
  order: number[]
  /** Source column indices that are not shown. */
  hidden: number[]
  /** Number of leading visible columns pinned to the left while scrolling horizontally. */
  frozen: number
}

export function defaultColumnState(count: number): ColumnState {
  return { order: Array.from({ length: count }, (_, i) => i), hidden: [], frozen: 0 }
}

/** Keep a state consistent with `count` columns (drops unknown indices, appends missing ones). */
export function normalizeColumnState(state: ColumnState | undefined, count: number): ColumnState {
  if (!state) return defaultColumnState(count)
  const seen = new Set<number>()
  const order: number[] = []
  for (const i of state.order) {
    if (Number.isInteger(i) && i >= 0 && i < count && !seen.has(i)) {
      seen.add(i)
      order.push(i)
    }
  }
  for (let i = 0; i < count; i++) if (!seen.has(i)) order.push(i)
  let hidden = [...new Set(state.hidden.filter((i) => Number.isInteger(i) && i >= 0 && i < count))]
  // never hide everything
  if (hidden.length >= count) hidden = []
  const visible = order.length - hidden.length
  const frozen = Math.max(0, Math.min(Math.floor(state.frozen) || 0, Math.max(0, visible - 1)))
  return { order, hidden, frozen }
}

/** Source indices of the visible columns, in display order. */
export function visibleColumns(state: ColumnState): number[] {
  if (state.hidden.length === 0) return state.order
  const hidden = new Set(state.hidden)
  return state.order.filter((i) => !hidden.has(i))
}

export function isDefaultColumnState(state: ColumnState): boolean {
  return state.hidden.length === 0 && state.frozen === 0 && state.order.every((v, i) => v === i)
}

export function setColumnHidden(state: ColumnState, source: number, hidden: boolean): ColumnState {
  const set = new Set(state.hidden)
  if (hidden) set.add(source)
  else set.delete(source)
  if (set.size >= state.order.length) return state
  return normalizeColumnState({ ...state, hidden: [...set] }, state.order.length)
}

/** Move a source column to display position `to` (index into `order`). */
export function moveColumn(state: ColumnState, source: number, to: number): ColumnState {
  const from = state.order.indexOf(source)
  if (from < 0) return state
  const order = [...state.order]
  order.splice(from, 1)
  order.splice(Math.max(0, Math.min(to, order.length)), 0, source)
  return { ...state, order }
}

/** Freeze the visible columns up to and including visible position `through` (-1 unfreezes). */
export function freezeThrough(state: ColumnState, through: number): ColumnState {
  return normalizeColumnState({ ...state, frozen: through + 1 }, state.order.length)
}

/** Signature of a column set: a saved arrangement only applies to the same columns. */
export function columnsSignature(columns: readonly Pick<ColumnMeta, 'name' | 'dataType'>[]): string {
  return columns.map((c) => `${c.name}\u0000${c.dataType}`).join('\u0001')
}

// --- memory ------------------------------------------------------------------------------------

const STORAGE_PREFIX = 'datagrippe.grid-columns:'
const memory = new Map<string, { signature: string; state: ColumnState }>()

export function loadColumnState(key: string, signature: string, count: number): ColumnState | undefined {
  let saved = memory.get(key)
  if (!saved) {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + key)
      if (raw) saved = JSON.parse(raw) as { signature: string; state: ColumnState }
    } catch {
      saved = undefined
    }
  }
  if (!saved || saved.signature !== signature) return undefined
  return normalizeColumnState(saved.state, count)
}

export function saveColumnState(key: string, signature: string, state: ColumnState): void {
  const entry = { signature, state }
  memory.set(key, entry)
  try {
    if (isDefaultColumnState(state)) globalThis.localStorage?.removeItem(STORAGE_PREFIX + key)
    else globalThis.localStorage?.setItem(STORAGE_PREFIX + key, JSON.stringify(entry))
  } catch {
    // storage unavailable: the in-memory copy still lasts for the session
  }
}
