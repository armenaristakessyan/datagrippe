// vault-tokens.json — Vault tokens obtained by a browser sign-in (OIDC), encrypted with
// Electron safeStorage and reused until they expire, so the browser does not open at every app start; plus the
// Vault servers the user allowed to receive the vault CLI token (~/.vault-token) for good.
// Never contains the CLI token itself, VAULT_TOKEN or a token typed by the user (those live elsewhere).
import { join } from 'node:path'
import type { VaultTokenSource } from '@shared/types'
import { isRecord, JsonFile } from './json-file'
import type { SecretCrypto } from './secrets'

/**
 * Sources whose tokens are persisted here: browser sign-ins only (OIDC, also the token method's fallback), so the
 * browser does not open at every start. LDAP / userpass sign-ins are not kept: a password the user chose not to
 * save must be asked again after a restart.
 */
export const PERSISTED_TOKEN_SOURCES: readonly VaultTokenSource[] = ['oidc']

export interface PersistedVaultToken {
  token: string
  source: VaultTokenSource
  /** Epoch ms; tokens without expiry (root) are never persisted. */
  expiresAt: number
  ttlSec?: number
  incrementSec?: number
  renewable: boolean
  final?: boolean
  obtainedAt: number
}

interface VaultTokensFile {
  /** identity key → base64(safeStorage(JSON PersistedVaultToken)) */
  tokens: Record<string, string>
  /** Vault server keys (vaultServerKey) allowed to receive the CLI token without asking. */
  trustedServers: string[]
}

export interface VaultTokenStoreLike {
  getToken(key: string, now: number): PersistedVaultToken | null
  setToken(key: string, token: PersistedVaultToken): void
  deleteToken(key: string): void
  /** Delete every token whose key starts with `prefix` (a Vault server: "<address>|<namespace>|"). */
  deleteTokens(prefix: string): void
  isTrusted(serverKey: string): boolean
  trust(serverKey: string): void
  untrust(serverKey: string): void
}

function isPersisted(value: unknown): value is PersistedVaultToken {
  return (
    isRecord(value) &&
    typeof value.token === 'string' &&
    value.token !== '' &&
    typeof value.source === 'string' &&
    PERSISTED_TOKEN_SOURCES.includes(value.source as VaultTokenSource) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.renewable === 'boolean' &&
    typeof value.obtainedAt === 'number'
  )
}

export class VaultTokenStore implements VaultTokenStoreLike {
  private readonly file: JsonFile<VaultTokensFile>
  private readonly crypto: SecretCrypto
  private readonly log: Pick<Console, 'warn' | 'error'>
  readonly encryptionAvailable: boolean
  /** Decrypted tokens (or the only copy when encryption is unavailable: then nothing is written to disk). */
  private readonly tokens = new Map<string, PersistedVaultToken>()

  constructor(baseDir: string, crypto: SecretCrypto, log: Pick<Console, 'warn' | 'error'> = console) {
    this.crypto = crypto
    this.log = log
    let available = false
    try {
      available = crypto.isEncryptionAvailable()
    } catch {
      available = false
    }
    this.encryptionAvailable = available
    this.file = new JsonFile<VaultTokensFile>(join(baseDir, 'vault-tokens.json'), {
      fallback: () => ({ tokens: {}, trustedServers: [] }),
      parse: (raw) => {
        if (!isRecord(raw)) throw new Error('expected an object')
        const tokens: Record<string, string> = {}
        if (isRecord(raw.tokens)) for (const [key, value] of Object.entries(raw.tokens)) if (typeof value === 'string') tokens[key] = value
        const trustedServers = Array.isArray(raw.trustedServers) ? raw.trustedServers.filter((s): s is string => typeof s === 'string' && s !== '') : []
        return { tokens, trustedServers }
      },
      log,
    })
    if (!available) return
    for (const [key, encoded] of Object.entries(this.file.get().tokens)) {
      try {
        const parsed: unknown = JSON.parse(crypto.decryptString(Buffer.from(encoded, 'base64')))
        if (isPersisted(parsed)) this.tokens.set(key, parsed)
      } catch {
        // Unreadable in this session (keychain refused): a new sign-in replaces it.
        this.log.warn('[vault] a saved Vault sign-in cannot be decrypted; the next connection signs in again.')
      }
    }
  }

  getToken(key: string, now: number): PersistedVaultToken | null {
    const token = this.tokens.get(key)
    if (!token) return null
    if (token.expiresAt <= now) {
      this.deleteToken(key)
      return null
    }
    return { ...token }
  }

  setToken(key: string, token: PersistedVaultToken): void {
    if (!PERSISTED_TOKEN_SOURCES.includes(token.source) || !Number.isFinite(token.expiresAt)) return
    this.tokens.set(key, { ...token })
    this.persist()
  }

  deleteToken(key: string): void {
    if (this.tokens.delete(key)) this.persist()
  }

  deleteTokens(prefix: string): void {
    let changed = false
    for (const key of [...this.tokens.keys()]) {
      if (key.startsWith(prefix)) {
        this.tokens.delete(key)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  isTrusted(serverKey: string): boolean {
    return this.file.get().trustedServers.includes(serverKey)
  }

  trust(serverKey: string): void {
    const current = this.file.get()
    if (current.trustedServers.includes(serverKey)) return
    this.file.set({ ...current, trustedServers: [...current.trustedServers, serverKey] })
  }

  untrust(serverKey: string): void {
    const current = this.file.get()
    if (!current.trustedServers.includes(serverKey)) return
    this.file.set({ ...current, trustedServers: current.trustedServers.filter((s) => s !== serverKey) })
  }

  flush(): void {
    this.file.flush()
  }

  private persist(): void {
    if (!this.encryptionAvailable) return
    const tokens: Record<string, string> = {}
    for (const [key, value] of this.tokens) {
      try {
        tokens[key] = this.crypto.encryptString(JSON.stringify(value)).toString('base64')
      } catch (error) {
        this.log.warn('[vault] cannot encrypt a Vault sign-in; it is kept for this session only.', error instanceof Error ? error.message : error)
      }
    }
    this.file.set({ ...this.file.get(), tokens })
  }
}

/** In-memory stand-in (tests, or when no store is wired). */
export class MemoryVaultTokenStore implements VaultTokenStoreLike {
  readonly tokens = new Map<string, PersistedVaultToken>()
  readonly trusted = new Set<string>()

  getToken(key: string, now: number): PersistedVaultToken | null {
    const token = this.tokens.get(key)
    if (!token) return null
    if (token.expiresAt <= now) {
      this.tokens.delete(key)
      return null
    }
    return { ...token }
  }

  setToken(key: string, token: PersistedVaultToken): void {
    if (PERSISTED_TOKEN_SOURCES.includes(token.source)) this.tokens.set(key, { ...token })
  }

  deleteToken(key: string): void {
    this.tokens.delete(key)
  }

  deleteTokens(prefix: string): void {
    for (const key of [...this.tokens.keys()]) if (key.startsWith(prefix)) this.tokens.delete(key)
  }

  isTrusted(serverKey: string): boolean {
    return this.trusted.has(serverKey)
  }

  trust(serverKey: string): void {
    this.trusted.add(serverKey)
  }

  untrust(serverKey: string): void {
    this.trusted.delete(serverKey)
  }
}
