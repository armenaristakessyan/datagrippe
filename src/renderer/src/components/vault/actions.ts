// Vault actions shared by the explorer context menu, the status bar chip and the command palette.
import type { ConnectionConfig } from '@shared/types'
import { connectionIdOf } from '@/components/explorer/tree'
import { toast } from '@/components/ui'
import { api, errorInfo } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { connectionById, useConnections } from '@/stores/connections'
import { useExplorer } from '@/stores/explorer'
import { useTabs } from '@/stores/tabs'
import { useVault } from '@/stores/vault'
import { describeLease, vaultMessage } from './format'

export const isVaultConnection = (c: ConnectionConfig | undefined): c is ConnectionConfig & { vault: NonNullable<ConnectionConfig['vault']> } =>
  c?.authMode === 'vault' && c.vault !== undefined

/** The connection the status bar describes: the active tab's, else the one selected in the explorer. */
export function activeConnectionId(): string | undefined {
  const { tabs, activeTabId } = useTabs.getState()
  const tab = tabs.find((t) => t.id === activeTabId)
  if (tab?.connectionId) return tab.connectionId
  const selected = useExplorer.getState().selectedNode
  return selected ? connectionIdOf(selected) : undefined
}

/** The active connection when it uses Vault. */
export function activeVaultConnection(): (ConnectionConfig & { vault: NonNullable<ConnectionConfig['vault']> }) | undefined {
  const connection = connectionById(activeConnectionId())
  return isVaultConnection(connection) ? connection : undefined
}

/** Toast for an error: Vault failures get their own title. */
export function toastError(title: string, error: unknown, subject?: string): void {
  const info = errorInfo(error)
  if (info.kind === 'vault') {
    const message = vaultMessage(info.message)
    toast.error('Vault', error, { description: subject ? `${subject}: ${message}` : message })
    return
  }
  toast.error(title, error)
}

/** Renew the lease (or get new credentials) of a connected Vault connection. */
export async function refreshVaultCredentials(connectionId: string): Promise<void> {
  const connection = connectionById(connectionId)
  if (!isVaultConnection(connection)) return
  if (useConnections.getState().runtime[connectionId]?.status !== 'connected') {
    toast.info('Connect first', { description: `${connection.name} gets its Vault credentials when it connects.` })
    return
  }
  try {
    const status = await api.vault.refresh(connectionId)
    useVault.getState().setStatus(status)
    toast.success('Vault credentials refreshed', {
      description: status.info ? `${status.info.username} · ${describeLease(status.info, Date.now())}` : connection.name,
    })
  } catch (error) {
    toastError('Could not refresh the Vault credentials', error, connection.name)
  }
}

/** The Vault database user of a connected connection (null when it has no lease status). */
export function vaultUserOf(connectionId: string | undefined): string | null {
  if (!connectionId) return null
  return useVault.getState().statuses[connectionId]?.info?.username ?? null
}

/** Copy the Vault-issued database user (e.g. to find the session in pg_stat_activity), with its lease in the toast. */
export async function copyVaultUser(connectionId: string): Promise<void> {
  const info = useVault.getState().statuses[connectionId]?.info
  if (!info) return
  try {
    await copyText(info.username)
    toast.success('Vault database user copied', { description: `${info.username} · ${describeLease(info, Date.now())}` })
  } catch (error) {
    toast.error('Could not copy the Vault user', error)
  }
}

/**
 * Forget the cached Vault token of the connection's server: the next connection signs in again.
 * Open connections keep the credentials they already have.
 */
export async function signOutOfVault(connectionId: string): Promise<void> {
  const connection = connectionById(connectionId)
  if (!isVaultConnection(connection)) return
  const { address, namespace } = connection.vault
  try {
    await api.vault.logout(address, namespace)
    toast.success('Signed out of Vault', { description: namespace ? `${address} · ${namespace}` : address })
  } catch (error) {
    toastError('Could not sign out of Vault', error)
  }
}
