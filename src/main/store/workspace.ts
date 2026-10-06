// workspace.json — open tabs and layout, saved often (debounced).
import { join } from 'node:path'
import type { WorkspaceState } from '@shared/types'
import { isRecord, JsonFile } from './json-file'

export class WorkspaceStore {
  private readonly file: JsonFile<WorkspaceState | null>

  constructor(baseDir: string, options: { debounceMs?: number; log?: Pick<Console, 'warn' | 'error'> } = {}) {
    this.file = new JsonFile<WorkspaceState | null>(join(baseDir, 'workspace.json'), {
      fallback: () => null,
      parse: parseWorkspace,
      debounceMs: options.debounceMs ?? 500,
      pretty: false,
      log: options.log,
    })
  }

  load(): WorkspaceState | null {
    const value = this.file.get()
    return value ? structuredClone(value) : null
  }

  save(state: WorkspaceState): void {
    this.file.set(parseWorkspace(structuredClone(state)))
  }

  flush(): void {
    this.file.flush()
  }
}

function parseWorkspace(raw: unknown): WorkspaceState | null {
  if (raw === null) return null
  if (!isRecord(raw)) throw new Error('expected an object')
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs.filter(
        (t): t is WorkspaceState['tabs'][number] =>
          isRecord(t) && typeof t.id === 'string' && typeof t.kind === 'string' && typeof t.connectionId === 'string',
      )
    : []
  const state: WorkspaceState = { version: 1, tabs }
  if (typeof raw.activeTabId === 'string') state.activeTabId = raw.activeTabId
  if (isRecord(raw.layout)) state.layout = raw.layout
  return state
}
