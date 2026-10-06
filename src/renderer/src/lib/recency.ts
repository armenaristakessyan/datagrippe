// Which part of the window the user worked in last: the explorer (sidebar) or the workspace (tabs,
// editors, grids). Used to pick the connection a new console opens on. A monotonic clock, not a
// timestamp, so two marks in the same millisecond still order correctly.
export type Region = 'explorer' | 'workspace'

let clock = 0
const marks: Record<Region, number> = { explorer: 0, workspace: 0 }

export function markRegion(region: Region): void {
  marks[region] = ++clock
}

/** The region marked most recently; undefined before any mark. */
export function lastRegion(): Region | undefined {
  if (marks.explorer === 0 && marks.workspace === 0) return undefined
  return marks.explorer > marks.workspace ? 'explorer' : 'workspace'
}

/** Test helper. */
export function resetRegions(): void {
  clock = 0
  marks.explorer = 0
  marks.workspace = 0
}
