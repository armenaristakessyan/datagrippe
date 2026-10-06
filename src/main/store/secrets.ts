// Connection secrets: encrypted on disk with Electron safeStorage (secrets.json), plus an
// in-memory cache for passwords that must not be persisted (savePassword=false) or when the OS
// keychain is unavailable.
import { join } from 'node:path'
import type { ConnectionSecrets } from '@shared/types'
import { isRecord, JsonFile } from './json-file'

/** Subset of Electron's safeStorage, injectable for tests. */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

type SecretsFile = Record<string, string>

/** Every secret kind kept for a connection (Vault token / password included). */
export const SECRET_KEYS = ['password', 'sshPassword', 'sshPassphrase', 'vaultToken', 'vaultPassword'] as const

export class SecretStore {
  private readonly file: JsonFile<SecretsFile>
  private readonly crypto: SecretCrypto
  private readonly log: Pick<Console, 'warn' | 'error'>
  /** Decrypted view of secrets.json (or the in-memory stand-in when encryption is unavailable). */
  private readonly stored = new Map<string, ConnectionSecrets>()
  /** Values valid for this app run only. */
  private readonly cache = new Map<string, ConnectionSecrets>()
  /**
   * Entries of secrets.json that could not be decrypted in this run (keychain access denied, key
   * temporarily unavailable…). Their ciphertext is written back unchanged so they are not lost; only an
   * explicit delete or a new value for that connection replaces them.
   */
  private readonly unreadable = new Map<string, string>()
  readonly encryptionAvailable: boolean

  constructor(baseDir: string, crypto: SecretCrypto, log: Pick<Console, 'warn' | 'error'> = console) {
    this.crypto = crypto
    this.log = log
    this.encryptionAvailable = safeAvailable(crypto)
    this.file = new JsonFile<SecretsFile>(join(baseDir, 'secrets.json'), {
      fallback: () => ({}),
      parse: (raw) => {
        if (!isRecord(raw)) throw new Error('expected an object')
        const out: SecretsFile = {}
        for (const [id, value] of Object.entries(raw)) if (typeof value === 'string') out[id] = value
        return out
      },
      log,
    })
    if (!this.encryptionAvailable) {
      log.warn('[secrets] OS encryption is unavailable: passwords are kept in memory for this session only.')
      return
    }
    for (const [id, encoded] of Object.entries(this.file.get())) {
      try {
        const parsed: unknown = JSON.parse(crypto.decryptString(Buffer.from(encoded, 'base64')))
        const secrets = sanitize(parsed)
        if (!isEmpty(secrets)) this.stored.set(id, secrets)
      } catch (error) {
        this.unreadable.set(id, encoded)
        log.warn(`[secrets] Cannot decrypt the secrets of connection ${id}; they are kept on disk but unavailable in this session.`, error)
      }
    }
  }

  /** Persisted secrets (disk, or memory when encryption is unavailable). */
  getStored(id: string): ConnectionSecrets {
    return { ...this.stored.get(id) }
  }

  getCached(id: string): ConnectionSecrets {
    return { ...this.cache.get(id) }
  }

  /** Stored secrets overridden by cached ones. */
  resolve(id: string): ConnectionSecrets {
    return { ...this.stored.get(id), ...this.cache.get(id) }
  }

  hasStoredPassword(id: string): boolean {
    return this.hasStored(id, 'password')
  }

  hasStored(id: string, key: keyof ConnectionSecrets): boolean {
    const value = this.stored.get(id)?.[key]
    return value !== undefined && value !== ''
  }

  /** Connections whose saved secrets could not be decrypted in this session. */
  unreadableIds(): string[] {
    return [...this.unreadable.keys()]
  }

  /** Replace the persisted secrets of a connection (empty values are dropped). */
  setStored(id: string, secrets: ConnectionSecrets): void {
    const clean = sanitize(secrets)
    if (isEmpty(clean)) {
      // Clearing secrets nobody could read is a no-op: keep them for a run where they can be decrypted.
      if (!this.stored.delete(id)) return
    } else {
      this.stored.set(id, clean)
      this.unreadable.delete(id)
    }
    this.persist()
  }

  /** Merge values into the in-memory cache; '' removes a key. */
  setCached(id: string, secrets: ConnectionSecrets): void {
    const next: ConnectionSecrets = { ...this.cache.get(id) }
    for (const key of SECRET_KEYS) {
      const value = secrets[key]
      if (value === undefined) continue
      if (value === '') delete next[key]
      else next[key] = value
    }
    if (isEmpty(next)) this.cache.delete(id)
    else this.cache.set(id, next)
  }

  forgetCached(id: string, key?: keyof ConnectionSecrets): void {
    if (!key) {
      this.cache.delete(id)
      return
    }
    const next = { ...this.cache.get(id) }
    delete next[key]
    if (isEmpty(next)) this.cache.delete(id)
    else this.cache.set(id, next)
  }

  copy(fromId: string, toId: string): void {
    const stored = this.stored.get(fromId)
    if (stored) this.setStored(toId, stored)
    const cached = this.cache.get(fromId)
    if (cached) this.cache.set(toId, { ...cached })
  }

  delete(id: string): void {
    this.cache.delete(id)
    const hadUnreadable = this.unreadable.delete(id)
    if (this.stored.delete(id) || hadUnreadable) this.persist()
  }

  flush(): void {
    this.file.flush()
  }

  private persist(): void {
    if (!this.encryptionAvailable) return
    const out: SecretsFile = {}
    for (const [id, encoded] of this.unreadable) if (!this.stored.has(id)) out[id] = encoded
    for (const [id, secrets] of this.stored) {
      try {
        out[id] = this.crypto.encryptString(JSON.stringify(secrets)).toString('base64')
      } catch (error) {
        this.log.error(`[secrets] Cannot encrypt the secrets of connection ${id}.`, error)
      }
    }
    this.file.set(out)
  }
}

function safeAvailable(crypto: SecretCrypto): boolean {
  try {
    return crypto.isEncryptionAvailable()
  } catch {
    return false
  }
}

function sanitize(raw: unknown): ConnectionSecrets {
  const out: ConnectionSecrets = {}
  if (!isRecord(raw)) return out
  for (const key of SECRET_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

function isEmpty(secrets: ConnectionSecrets): boolean {
  return SECRET_KEYS.every((key) => secrets[key] === undefined)
}
