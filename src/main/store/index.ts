// All persistent stores of the app, rooted at one directory (Electron userData in production).
import { mkdirSync } from 'node:fs'
import { ConnectionStore } from './connections'
import { HistoryStore } from './history'
import { HostKeyStore } from './host-keys'
import { SecretStore, type SecretCrypto } from './secrets'
import { SettingsStore } from './settings'
import { VaultTokenStore } from './vault-tokens'
import { WindowStateStore } from './window-state'
import { WorkspaceStore } from './workspace'

export interface Stores {
  baseDir: string
  secrets: SecretStore
  connections: ConnectionStore
  settings: SettingsStore
  workspace: WorkspaceStore
  history: HistoryStore
  hostKeys: HostKeyStore
  windowState: WindowStateStore
  /** Vault sign-ins (encrypted) and the servers trusted with the vault CLI token. */
  vaultTokens: VaultTokenStore
  /** Write every pending change synchronously (used on quit). */
  flush(): void
}

export function createStores(baseDir: string, crypto: SecretCrypto, log: Pick<Console, 'warn' | 'error'> = console): Stores {
  mkdirSync(baseDir, { recursive: true })
  const secrets = new SecretStore(baseDir, crypto, log)
  const connections = new ConnectionStore(baseDir, secrets, { log })
  const settings = new SettingsStore(baseDir, log)
  const workspace = new WorkspaceStore(baseDir, { log })
  const history = new HistoryStore(baseDir, { log })
  const windowState = new WindowStateStore(baseDir, { log })
  const hostKeys = new HostKeyStore(baseDir, { log })
  const vaultTokens = new VaultTokenStore(baseDir, crypto, log)
  return {
    baseDir,
    secrets,
    connections,
    settings,
    workspace,
    history,
    hostKeys,
    windowState,
    vaultTokens,
    flush() {
      for (const store of [connections, settings, workspace, history, windowState, hostKeys, vaultTokens]) {
        try {
          store.flush()
        } catch (error) {
          log.error('[store] flush failed', error)
        }
      }
    },
  }
}

export type { SecretCrypto } from './secrets'
