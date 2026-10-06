import { create } from 'zustand'
import type { ConnectionConfig, ConnectionInput, ConnectionSecrets, ConnectionStatus, DbErrorInfo, ErrorKind, ServerInfo } from '@shared/types'
import { api, ApiError, errorInfo, onEvent } from '@/lib/api'
import { withHostKeyTrust } from '@/lib/host-key'
import { useUi } from './ui'
import { useVault, vaultPromptError } from './vault'

export interface ConnectionRuntime {
  status: ConnectionStatus
  info?: ServerInfo
  error?: string
  /** Kind of `error` ('vault' errors are presented as such). */
  errorKind?: ErrorKind
}

/** A secret the connect flow can prompt for (DbErrorInfo.secretField). */
export type PromptedSecret = NonNullable<DbErrorInfo['secretField']>

/** The secret main asks for, when `error` is a 'needs-password' refusal. */
export function neededSecret(error: unknown): PromptedSecret | null {
  if (!(error instanceof ApiError) || error.info.kind !== 'needs-password') return null
  return error.info.secretField ?? 'password'
}

/**
 * Prompt for `field`: the database password through useUi().askPassword, the Vault token / password
 * through useVault().askSecret. `submit` tries the value (the prompt stays open while it throws).
 */
export function askSecret(
  connection: ConnectionConfig,
  field: PromptedSecret,
  submit: (value: string) => Promise<void>,
  error?: DbErrorInfo,
): Promise<string | null> {
  if (field === 'password') return useUi.getState().askPassword(connection, submit)
  return useVault.getState().askSecret({ field, target: connection, confirmLabel: 'Connect', submit, ...(error ? { error } : {}) })
}

/**
 * Why a Vault prompt opens: main adds a `detail` when a saved / cached Vault secret (or VAULT_TOKEN,
 * ~/.vault-token) was sent and rejected; a merely missing secret has none and the prompt opens clean.
 */
export function rejectionShown(error: unknown): DbErrorInfo | undefined {
  return error instanceof ApiError ? vaultPromptError(error.info) : undefined
}

interface ConnectionsState {
  connections: ConnectionConfig[]
  runtime: Record<string, ConnectionRuntime>
  loaded: boolean

  load: () => Promise<void>
  save: (input: ConnectionInput) => Promise<ConnectionConfig>
  remove: (id: string) => Promise<void>
  duplicate: (id: string) => Promise<ConnectionConfig>
  /** Connect, prompting for a password when none is stored. Resolves to null if the user cancels. */
  connect: (id: string) => Promise<ServerInfo | null>
  /** Connect if needed; resolves to false when the connection could not be established/was cancelled. */
  ensureConnected: (id: string) => Promise<boolean>
  disconnect: (id: string) => Promise<void>
}

const pending = new Map<string, Promise<ServerInfo | null>>()

export const useConnections = create<ConnectionsState>((set, get) => {
  const setRuntime = (id: string, runtime: ConnectionRuntime) =>
    set({ runtime: { ...get().runtime, [id]: runtime } })

  return {
    connections: [],
    runtime: {},
    loaded: false,

    load: async () => {
      const [connections, active] = await Promise.all([api.connections.list(), api.connections.active()])
      const runtime: Record<string, ConnectionRuntime> = { ...get().runtime }
      for (const id of active) runtime[id] = { ...runtime[id], status: 'connected' }
      set({ connections, runtime, loaded: true })
      // Connections still open in main (window reload): show their Vault lease again.
      for (const id of active) if (connections.find((c) => c.id === id)?.authMode === 'vault') void useVault.getState().loadStatus(id)
    },

    save: async (input) => {
      const saved = await api.connections.save(input)
      const others = get().connections.filter((c) => c.id !== saved.id)
      const exists = others.length !== get().connections.length
      set({
        connections: exists
          ? get().connections.map((c) => (c.id === saved.id ? saved : c))
          : [...get().connections, saved],
      })
      return saved
    },

    remove: async (id) => {
      await api.connections.delete(id)
      const runtime = { ...get().runtime }
      delete runtime[id]
      set({ connections: get().connections.filter((c) => c.id !== id), runtime })
      useVault.getState().clear(id)
    },

    duplicate: async (id) => {
      const copy = await api.connections.duplicate(id)
      set({ connections: [...get().connections, copy] })
      return copy
    },

    connect: (id) => {
      const inflight = pending.get(id)
      if (inflight) return inflight
      const run = async (): Promise<ServerInfo | null> => {
        setRuntime(id, { status: 'connecting' })
        // Main reports the Vault lease as soon as Vault issued it, before the database accepted the user;
        // when the connect then fails or is cancelled main revokes it silently: forget its status here.
        const fail = (error: unknown): never => {
          const info = errorInfo(error)
          setRuntime(id, { status: 'error', error: info.message, errorKind: info.kind })
          useVault.getState().clear(id)
          throw error
        }
        const notConnected = (): null => {
          setRuntime(id, { status: 'disconnected' })
          useVault.getState().clear(id)
          return null
        }
        const connected = (info: ServerInfo): ServerInfo => {
          setRuntime(id, { status: 'connected', info })
          if (get().connections.find((c) => c.id === id)?.authMode === 'vault') void useVault.getState().loadStatus(id)
          return info
        }
        let field: PromptedSecret | null
        let rejection: DbErrorInfo | undefined
        try {
          // An unknown SSH host key is confirmed first (nothing was sent to the server yet).
          const info = await withHostKeyTrust(() => api.connections.connect(id))
          if (!info) return notConnected()
          return connected(info)
        } catch (error) {
          field = neededSecret(error)
          if (!field) return fail(error)
          rejection = rejectionShown(error)
        }
        // A secret is missing (database password, Vault token or Vault password): the prompt connects
        // with what the user types and stays open (with the error) on a wrong value, so retrying does
        // not mean starting over. Answering one prompt may reveal the next one (e.g. Vault token, then
        // database password), each typed secret is sent again with the next attempt.
        const connection = get().connections.find((c) => c.id === id)
        const typed: ConnectionSecrets = {}
        for (let round = 0; connection && field && round < 4; round++) {
          const current: PromptedSecret = field
          const outcome: { info?: ServerInfo; next?: PromptedSecret } = {}
          const value = await askSecret(connection, current, async (secret) => {
            try {
              outcome.info = await api.connections.connect(id, { ...typed, [current]: secret })
            } catch (error) {
              const next = neededSecret(error)
              // The value was accepted; another secret is needed now.
              if (next && next !== current) {
                outcome.next = next
                return
              }
              throw error
            }
          }, round === 0 ? rejection : undefined)
          if (value === null) break
          if (outcome.info) return connected(outcome.info)
          typed[current] = value
          field = outcome.next ?? null
        }
        return notConnected()
      }
      const promise = run().finally(() => pending.delete(id))
      pending.set(id, promise)
      return promise
    },

    ensureConnected: async (id) => {
      if (get().runtime[id]?.status === 'connected') return true
      try {
        return (await get().connect(id)) !== null
      } catch {
        return false
      }
    },

    disconnect: async (id) => {
      await api.connections.disconnect(id)
      setRuntime(id, { status: 'disconnected' })
      useVault.getState().clear(id)
    },
  }
})

/** Keep runtime status in sync with main-side disconnects. Call once at startup. */
export function bindConnectionEvents(): () => void {
  return onEvent('event:connectionClosed', ({ connectionId, reason }) => {
    const { runtime } = useConnections.getState()
    useConnections.setState({
      runtime: { ...runtime, [connectionId]: { status: reason ? 'error' : 'disconnected', error: reason } },
    })
    useVault.getState().clear(connectionId)
  })
}

export function connectionById(id: string | undefined): ConnectionConfig | undefined {
  if (!id) return undefined
  return useConnections.getState().connections.find((c) => c.id === id)
}
