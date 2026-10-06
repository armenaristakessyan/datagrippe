// One dedicated server session per sessions tab, opened lazily and closed with the tab. Lists
// sessions and runs the cancel / terminate statements on it.
import type { ExecuteOptions, ExecutionResult } from '@shared/types'
import { api, ApiError, onEvent } from '@/lib/api'
import { useConnections } from '@/stores/connections'
import { onTabClosed, type SessionsTab } from '@/stores/tabs'

/**
 * Polling must not fill the query history. `history: false` is the additive ExecuteOptions flag
 * internal runs use (requested from the main process; ignored until it is honoured there).
 */
const OPTIONS: ExecuteOptions & { history?: boolean } = { maxRows: 2000, history: false }

const sessions = new Map<string, { sessionId: string; connectionId: string }>()
const opening = new Map<string, Promise<string>>()
let bound = false

function bind(): void {
  if (bound) return
  bound = true
  onTabClosed((tab) => {
    if (tab.kind !== 'sessions') return
    const entry = sessions.get(tab.id)
    sessions.delete(tab.id)
    if (entry) void api.session.close(entry.sessionId).catch(() => undefined)
  })
  onEvent('event:sessionClosed', ({ sessionId }) => {
    for (const [tabId, entry] of sessions) if (entry.sessionId === sessionId) sessions.delete(tabId)
  })
  onEvent('event:connectionClosed', ({ connectionId }) => {
    for (const [tabId, entry] of sessions) if (entry.connectionId === connectionId) sessions.delete(tabId)
  })
}

export class NotConnectedError extends Error {
  constructor(name: string) {
    super(`Not connected to ${name}`)
    this.name = 'NotConnectedError'
  }
}

async function ensureSession(tab: SessionsTab): Promise<string> {
  bind()
  const existing = sessions.get(tab.id)
  if (existing) return existing.sessionId
  const inflight = opening.get(tab.id)
  if (inflight) return inflight
  const run = async () => {
    const ok = await useConnections.getState().ensureConnected(tab.connectionId)
    if (!ok) throw new NotConnectedError(useConnections.getState().connections.find((c) => c.id === tab.connectionId)?.name ?? 'the server')
    const info = await api.session.open({ connectionId: tab.connectionId })
    sessions.set(tab.id, { sessionId: info.sessionId, connectionId: tab.connectionId })
    return info.sessionId
  }
  const promise = run().finally(() => opening.delete(tab.id))
  opening.set(tab.id, promise)
  return promise
}

/** Execute on the tab's session; a session lost meanwhile is reopened once. */
export async function runOnSessionsTab(tab: SessionsTab, sql: string): Promise<ExecutionResult> {
  const sessionId = await ensureSession(tab)
  try {
    return await api.session.execute(sessionId, sql, OPTIONS)
  } catch (error) {
    const lost = error instanceof ApiError && (error.info.kind === 'connection' || error.info.kind === 'not-found')
    if (!lost) throw error
    sessions.delete(tab.id)
    return api.session.execute(await ensureSession(tab), sql, OPTIONS)
  }
}
