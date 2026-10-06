// HashiCorp Vault state of the renderer: lease status of connected Vault connections (by connection id),
// the interactive sign-in in progress (OIDC browser flow) and the queue of Vault secret prompts
// (rendered by <DialogHost/>). Secrets never live here: prompts hand the typed value to `submit`.
import { create } from 'zustand'
import type { ConnectionColor, DbErrorInfo, Dialect, VaultConfig, VaultDefaults, VaultLoginEvent, VaultStatus } from '@shared/types'
import { api, onEvent } from '@/lib/api'
import { uid } from '@/lib/id'

/** Which Vault secret a prompt asks for (DbErrorInfo.secretField). */
export type VaultSecretField = 'vaultToken' | 'vaultPassword'

/** What the prompt shows about the connection (a saved ConnectionConfig or an unsaved ConnectionInput). */
export interface SecretPromptTarget {
  name: string
  dialect: Dialect
  color: ConnectionColor
  host: string
  port: number
  vault?: VaultConfig
  /** Whether the typed Vault secret is stored (encrypted) or kept in memory; the prompt says which. */
  savePassword?: boolean
}

export interface VaultSecretRequest {
  id: string
  field: VaultSecretField
  target: SecretPromptTarget
  /** Shown when the prompt opens (e.g. Vault rejected the password that was sent). */
  error?: DbErrorInfo
  /** Label of the confirm button (default "Sign in"). */
  confirmLabel?: string
  /** Tries the typed value; when it throws the prompt stays open with the error. */
  submit?: (value: string) => Promise<void>
  resolve: (value: string | null) => void
}

interface VaultState {
  /**
   * The vault CLI's environment (VAULT_ADDR / VAULT_NAMESPACE / VAULT_CACERT from the login shell, and whether
   * ~/.vault-token exists): prefills new Vault connections. Null until loaded.
   */
  defaults: VaultDefaults | null
  loadDefaults: () => Promise<VaultDefaults | null>
  statuses: Record<string, VaultStatus>
  /** The interactive sign-in waiting for the browser (null when none). */
  login: VaultLoginEvent | null
  prompts: VaultSecretRequest[]

  setStatus: (status: VaultStatus) => void
  /** Fetch the lease status of a connected connection (null = not a Vault connection / not connected). */
  loadStatus: (connectionId: string) => Promise<VaultStatus | null>
  clear: (connectionId: string) => void
  setLogin: (event: VaultLoginEvent | null) => void
  /** Ask for a Vault token / password. Resolves to the value once `submit` accepted it, or null when cancelled. */
  askSecret: (request: Omit<VaultSecretRequest, 'id' | 'resolve'>) => Promise<string | null>
  dismissPrompt: (id: string) => void
}

let defaultsPromise: Promise<VaultDefaults | null> | null = null

export const useVault = create<VaultState>((set, get) => ({
  defaults: null,
  loadDefaults: () => {
    if (!defaultsPromise) {
      defaultsPromise = api.vault
        .defaults()
        .then((defaults) => {
          set({ defaults })
          return defaults
        })
        .catch(() => {
          // Informative only: the fields simply stay empty.
          defaultsPromise = null
          return null
        })
    }
    return defaultsPromise
  },
  statuses: {},
  login: null,
  prompts: [],

  setStatus: (status) => set({ statuses: { ...get().statuses, [status.connectionId]: status } }),
  loadStatus: async (connectionId) => {
    let status: VaultStatus | null = null
    try {
      status = await api.vault.status(connectionId)
    } catch {
      // The status is informative only; the badge falls back to "not connected".
      return null
    }
    if (status) get().setStatus(status)
    else get().clear(connectionId)
    return status
  },
  clear: (connectionId) => {
    if (!(connectionId in get().statuses)) return
    const statuses = { ...get().statuses }
    delete statuses[connectionId]
    set({ statuses })
  },
  setLogin: (login) => set({ login }),
  askSecret: (request) =>
    new Promise<string | null>((resolve) => {
      set({ prompts: [...get().prompts, { ...request, id: uid('vault'), resolve }] })
    }),
  dismissPrompt: (id) => set({ prompts: get().prompts.filter((p) => p.id !== id) }),
}))

/**
 * The error a Vault secret prompt opens with: main adds a `detail` when a saved / cached Vault secret
 * (or VAULT_TOKEN, ~/.vault-token) was sent and rejected; a merely missing secret has none and the prompt
 * opens clean. `sentNow` = the value was typed for this very attempt (its refusal is shown too).
 */
export function vaultPromptError(error: DbErrorInfo | undefined, sentNow = false): DbErrorInfo | undefined {
  if (!error || error.kind !== 'needs-password') return undefined
  if (error.secretField !== 'vaultToken' && error.secretField !== 'vaultPassword') return undefined
  return error.detail || sentNow ? error : undefined
}

export interface VaultEventHandlers {
  /** A sign-in finished (completed / failed); 'cancelled' is silent. */
  onLoginFinished?: (event: VaultLoginEvent) => void
}

/** Mirror main's Vault events into the store. Call once (VaultLoginOverlay does). */
export function bindVaultEvents(handlers: VaultEventHandlers = {}): () => void {
  const offStatus = onEvent('event:vaultStatus', (status) => useVault.getState().setStatus(status))
  const offLogin = onEvent('event:vaultLogin', (event) => {
    if (event.state === 'browser-opened') {
      useVault.getState().setLogin(event)
      return
    }
    useVault.getState().setLogin(null)
    if (event.state !== 'cancelled') handlers.onLoginFinished?.(event)
  })
  return () => {
    offStatus()
    offLogin()
  }
}
