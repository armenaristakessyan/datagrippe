// Command-palette entries of the data grids. They act on the grid that last had the keyboard focus
// (the palette itself takes the focus while it is open), as long as that grid is still on screen.
import { Columns3, FilterX, Search } from 'lucide-react'
import { registerCommands } from '@/lib/commands'

export interface GridCommandHandle {
  /** The grid is mounted and visible. */
  isAlive: () => boolean
  openFind: () => void
  openColumns: () => void
  showAllColumns: () => void
  hasHiddenColumns: () => boolean
  clearFilters: () => void
  hasFilters: () => boolean
}

let current: GridCommandHandle | null = null
let registered = false

export function setActiveGrid(handle: GridCommandHandle): void {
  current = handle
}

export function releaseGrid(handle: GridCommandHandle): void {
  if (current === handle) current = null
}

function live(): GridCommandHandle | null {
  return current?.isAlive() ? current : null
}

/** Register the grid commands once (idempotent). */
export function ensureGridCommands(): void {
  if (registered) return
  registered = true
  registerCommands([
    {
      id: 'grid-find',
      title: 'Find in grid…',
      group: 'Data grid',
      icon: Search,
      shortcut: 'CmdOrCtrl+F',
      keywords: ['search', 'filter', 'rows', 'results'],
      when: () => !!live(),
      run: () => live()?.openFind(),
    },
    {
      id: 'grid-columns',
      title: 'Choose grid columns…',
      group: 'Data grid',
      icon: Columns3,
      keywords: ['hide', 'show', 'reorder', 'freeze', 'pin'],
      when: () => !!live(),
      run: () => live()?.openColumns(),
    },
    {
      id: 'grid-show-all-columns',
      title: 'Show all grid columns',
      group: 'Data grid',
      keywords: ['unhide', 'columns'],
      when: () => !!live()?.hasHiddenColumns(),
      run: () => live()?.showAllColumns(),
    },
    {
      id: 'grid-clear-filters',
      title: 'Clear grid value filters',
      group: 'Data grid',
      icon: FilterX,
      keywords: ['filter', 'unfilter'],
      when: () => !!live()?.hasFilters(),
      run: () => live()?.clearFilters(),
    },
  ])
}
