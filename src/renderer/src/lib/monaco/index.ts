// Lazy entry point: Monaco is a large chunk, loaded on the first console instead of with the shell.
import type * as MonacoNs from 'monaco-editor/editor/editor.api.js'

export type MonacoApi = typeof MonacoNs
export type { MonacoNs as Monaco }

let pending: Promise<MonacoApi> | null = null
let loaded: MonacoApi | null = null

export function loadMonaco(): Promise<MonacoApi> {
  pending ??= import('./setup')
    .then((m) => m.initMonaco())
    .then((monaco) => {
      loaded = monaco
      return monaco
    })
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}

/** Monaco if it has finished loading, else null. */
export function loadedMonaco(): MonacoApi | null {
  return loaded
}

export { EDITOR_FONT_FAMILY_STACK } from './font'
export { consoleModelUri, LANGUAGE_ID, setModelEnv, type ModelEnv } from './env'
export { MONACO_THEME } from './theme'
