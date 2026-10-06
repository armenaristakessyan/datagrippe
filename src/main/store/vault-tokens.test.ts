import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretCrypto } from './secrets'
import { VaultTokenStore, type PersistedVaultToken } from './vault-tokens'

const fakeCrypto = (available = true): SecretCrypto => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
  decryptString: (encrypted) => {
    const text = encrypted.toString()
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
    return Buffer.from(text.slice(4), 'base64').toString()
  },
})

const quiet = { warn: () => undefined, error: () => undefined }
const token = (patch: Partial<PersistedVaultToken> = {}): PersistedVaultToken => ({
  token: 'hvs.secret-oidc-token',
  source: 'oidc',
  expiresAt: 10_000,
  renewable: true,
  obtainedAt: 1_000,
  ...patch,
})

describe('VaultTokenStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-vault-tokens-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps interactive sign-ins encrypted across instances until they expire', () => {
    const store = new VaultTokenStore(dir, fakeCrypto(), quiet)
    store.setToken('https://vault.example.shared||token|||', token())
    store.flush()
    const raw = readFileSync(join(dir, 'vault-tokens.json'), 'utf8')
    expect(raw).not.toContain('hvs.secret-oidc-token')

    const reopened = new VaultTokenStore(dir, fakeCrypto(), quiet)
    expect(reopened.getToken('https://vault.example.shared||token|||', 5_000)?.token).toBe('hvs.secret-oidc-token')
    expect(reopened.getToken('https://vault.example.shared||token|||', 10_000)).toBeNull()
    reopened.flush()
    expect(new VaultTokenStore(dir, fakeCrypto(), quiet).getToken('https://vault.example.shared||token|||', 0)).toBeNull()
  })

  it('never persists tokens of other sources, nor anything without OS encryption', () => {
    const store = new VaultTokenStore(dir, fakeCrypto(), quiet)
    // The CLI / typed tokens live elsewhere; LDAP / userpass sign-ins must ask the password again after a restart.
    for (const source of ['cli', 'stored', 'env', 'ldap', 'userpass'] as const) {
      store.setToken(`k-${source}`, token({ source }))
      expect(store.getToken(`k-${source}`, 0)).toBeNull()
    }

    const plain = new VaultTokenStore(dir, fakeCrypto(false), quiet)
    plain.setToken('k', token())
    expect(plain.getToken('k', 0)?.token).toBe('hvs.secret-oidc-token') // this run only
    plain.flush()
    expect(new VaultTokenStore(dir, fakeCrypto(), quiet).getToken('k', 0)).toBeNull()
  })

  it('deletes the sign-ins of one server and remembers trusted servers', () => {
    const store = new VaultTokenStore(dir, fakeCrypto(), quiet)
    store.setToken('https://a.example.shared||oidc|oidc|', token())
    store.setToken('https://a.example.shared||token|||', token())
    store.setToken('https://b.example.shared||oidc|oidc|', token())
    store.deleteTokens('https://a.example.shared||')
    expect(store.getToken('https://a.example.shared||oidc|oidc|', 0)).toBeNull()
    expect(store.getToken('https://a.example.shared||token|||', 0)).toBeNull()
    expect(store.getToken('https://b.example.shared||oidc|oidc|', 0)).not.toBeNull()

    store.trust('https://a.example.shared|')
    store.flush()
    const reopened = new VaultTokenStore(dir, fakeCrypto(), quiet)
    expect(reopened.isTrusted('https://a.example.shared|')).toBe(true)
    reopened.untrust('https://a.example.shared|')
    expect(reopened.isTrusted('https://a.example.shared|')).toBe(false)
  })

  it('drops entries it cannot decrypt without failing', () => {
    const store = new VaultTokenStore(dir, fakeCrypto(), quiet)
    store.setToken('k', token())
    store.flush()
    const broken: SecretCrypto = { ...fakeCrypto(), decryptString: () => { throw new Error('keychain locked') } }
    expect(new VaultTokenStore(dir, broken, quiet).getToken('k', 0)).toBeNull()
  })
})
