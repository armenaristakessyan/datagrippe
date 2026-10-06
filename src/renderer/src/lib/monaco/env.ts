// Per-model context for the language providers: which dialect / catalog / format options apply to a
// console model. Each SqlEditor registers its model here; providers look it up by model URI.
import type { Dialect } from '@shared/types'
import type { FormatOptions } from '@shared/sql'
import type { CompletionEnv } from './completion'

export interface ModelEnv {
  completion: () => CompletionEnv
  /** Load the completion catalog if it is missing (resolves when loaded or failed). */
  ensureCatalog: () => Promise<unknown>
  format: () => FormatOptions
}

const envs = new Map<string, ModelEnv>()

export function setModelEnv(uri: string, env: ModelEnv): () => void {
  envs.set(uri, env)
  return () => {
    if (envs.get(uri) === env) envs.delete(uri)
  }
}

export function modelEnv(uri: string): ModelEnv | undefined {
  return envs.get(uri)
}

/** Monaco language id per dialect ('sql' is Monaco's T-SQL grammar). */
export const LANGUAGE_ID: Record<Dialect, string> = {
  postgres: 'pgsql',
  mssql: 'sql',
}

export const CONSOLE_URI_PREFIX = 'inmemory://console/'

export function consoleModelUri(tabId: string): string {
  return `${CONSOLE_URI_PREFIX}${tabId}`
}
