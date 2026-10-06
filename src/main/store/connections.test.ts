import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInput } from '@shared/types'
import { DriverError } from '../db/errors'
import { ConnectionStore } from './connections'
import { SecretStore, type SecretCrypto } from './secrets'

const silent = { warn: vi.fn(), error: vi.fn() }

/** Reversible fake "encryption" so the tests can check what reaches the disk. */
function fakeCrypto(available = true): SecretCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (data) => {
      const text = data.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
  }
}

function input(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    name: 'Local PG',
    dialect: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'app',
    user: 'me',
    savePassword: true,
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'password' },
    color: 'blue',
    readOnly: false,
    productionGuard: false,
    options: {},
    ...overrides,
  }
}

function diskSecrets(dir: string): Record<string, unknown> {
  const path = join(dir, 'secrets.json')
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  return Object.fromEntries(
    Object.entries(raw).map(([id, enc]) => [id, JSON.parse(Buffer.from(enc, 'base64').toString('utf8').slice(4))]),
  )
}

describe('ConnectionStore', () => {
  let dir: string
  let secrets: SecretStore
  let store: ConnectionStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dg-conn-'))
    secrets = new SecretStore(dir, fakeCrypto(), silent)
    store = new ConnectionStore(dir, secrets, { log: silent, now: () => new Date('2026-01-02T03:04:05.000Z') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates a connection with id, timestamps and hasPassword, and never writes secrets to connections.json', () => {
    const saved = store.save(input({ secrets: { password: 's3cret' } }))
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(saved.updatedAt).toBe(saved.createdAt)
    expect(saved.hasPassword).toBe(true)
    const file = readFileSync(join(dir, 'connections.json'), 'utf8')
    expect(file).not.toContain('s3cret')
    expect(file).not.toContain('hasPassword')
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('s3cret')
    expect(diskSecrets(dir)[saved.id]).toEqual({ password: 's3cret' })
  })

  it('validates input', () => {
    const bad: [Partial<ConnectionInput>, RegExp][] = [
      [{ name: '  ' }, /name/i],
      [{ dialect: 'mysql' as never }, /type/i],
      [{ host: '' }, /host/i],
      [{ port: 0 }, /port/i],
      [{ port: 70000 }, /port/i],
      [{ ssh: { enabled: true, host: '', port: 22, username: 'u', authMethod: 'password' } }, /SSH host/],
      [{ ssh: { enabled: true, host: 'h', port: 22, username: '', authMethod: 'password' } }, /SSH user/],
      [{ ssh: { enabled: true, host: 'h', port: 22, username: 'u', authMethod: 'privateKey' } }, /key/],
    ]
    for (const [patch, message] of bad) {
      try {
        store.save(input(patch))
        throw new Error('expected a failure')
      } catch (error) {
        expect(error).toBeInstanceOf(DriverError)
        expect((error as DriverError).info.kind).toBe('invalid-input')
        expect((error as DriverError).message).toMatch(message)
      }
    }
  })

  it('updates keep createdAt; unknown id is not-found', () => {
    let tick = 0
    const s2 = new ConnectionStore(dir, secrets, { log: silent, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) })
    const created = s2.save(input())
    const updated = s2.save({ ...input({ name: 'Renamed' }), id: created.id })
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    expect(s2.list()).toHaveLength(1)
    expect(() => s2.save({ ...input(), id: 'missing' })).toThrow(/no longer exists/)
  })

  it('secret patch semantics: undefined keeps, empty clears, value sets', () => {
    const c = store.save(input({ secrets: { password: 'a', sshPassword: 'b' } }))
    store.save({ ...input(), id: c.id, secrets: { password: undefined } })
    expect(store.secrets(c.id)).toEqual({ password: 'a', sshPassword: 'b' })
    store.save({ ...input(), id: c.id, secrets: { password: '' } })
    expect(store.secrets(c.id)).toEqual({ sshPassword: 'b' })
    expect(store.get(c.id)?.hasPassword).toBe(false)
    store.save({ ...input(), id: c.id, secrets: { password: 'new' } })
    expect(store.secrets(c.id).password).toBe('new')
  })

  it('savePassword=false keeps the password in memory only', () => {
    const c = store.save(input({ savePassword: false, secrets: { password: 'mem' } }))
    expect(store.secrets(c.id).password).toBe('mem')
    expect(c.hasPassword).toBe(false)
    expect(diskSecrets(dir)[c.id]).toBeUndefined()
    // A fresh process (new stores on the same dir) does not know it.
    const reloaded = new ConnectionStore(dir, new SecretStore(dir, fakeCrypto(), silent), { log: silent })
    expect(reloaded.secrets(c.id).password).toBeUndefined()
  })

  it('switching savePassword off removes a stored password from disk but keeps it usable', () => {
    const c = store.save(input({ secrets: { password: 'disk' } }))
    expect(diskSecrets(dir)[c.id]).toEqual({ password: 'disk' })
    store.save({ ...input({ savePassword: false }), id: c.id })
    expect(diskSecrets(dir)[c.id]).toBeUndefined()
    expect(store.secrets(c.id).password).toBe('disk')
    // switching back on persists the in-memory password
    store.save({ ...input({ savePassword: true }), id: c.id })
    expect(diskSecrets(dir)[c.id]).toEqual({ password: 'disk' })
  })

  it('rememberSecrets caches and persists only when savePassword is true', () => {
    const keep = store.save(input())
    const memOnly = store.save(input({ name: 'B', savePassword: false }))
    store.rememberSecrets(keep.id, { password: 'p1' })
    store.rememberSecrets(memOnly.id, { password: 'p2' })
    expect(store.secrets(keep.id).password).toBe('p1')
    expect(store.secrets(memOnly.id).password).toBe('p2')
    expect(store.passwordIsCached(memOnly.id)).toBe(true)
    expect(diskSecrets(dir)).toEqual({ [keep.id]: { password: 'p1' } })
    store.forgetCachedPassword(memOnly.id)
    expect(store.secrets(memOnly.id).password).toBeUndefined()
  })

  it('duplicate copies the definition and secrets; delete removes secrets', () => {
    const c = store.save(input({ secrets: { password: 'x' } }))
    const copy = store.duplicate(c.id)
    expect(copy.name).toBe('Local PG copy')
    expect(copy.id).not.toBe(c.id)
    expect(store.secrets(copy.id).password).toBe('x')
    expect(copy.hasPassword).toBe(true)
    store.delete(c.id)
    expect(store.get(c.id)).toBeUndefined()
    expect(store.secrets(c.id)).toEqual({})
    expect(diskSecrets(dir)[c.id]).toBeUndefined()
    expect(store.list().map((x) => x.id)).toEqual([copy.id])
  })

  it('keeps secrets in memory only when encryption is unavailable', () => {
    const warn = vi.fn()
    const memSecrets = new SecretStore(dir, fakeCrypto(false), { warn, error: vi.fn() })
    expect(warn).toHaveBeenCalled()
    const s = new ConnectionStore(dir, memSecrets, { log: silent })
    const c = s.save(input({ secrets: { password: 'p' } }))
    expect(s.secrets(c.id).password).toBe('p')
    expect(c.hasPassword).toBe(true)
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false)
  })

  it('reloads connections and secrets from disk, ignoring invalid entries', () => {
    const c = store.save(input({ secrets: { password: 'p' } }))
    const raw = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8')) as unknown[]
    writeFileSync(join(dir, 'connections.json'), JSON.stringify([...raw, { nope: true }, { id: 'x', dialect: 'oracle' }]))
    const reloaded = new ConnectionStore(dir, new SecretStore(dir, fakeCrypto(), silent), { log: silent })
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.get(c.id)?.hasPassword).toBe(true)
    expect(reloaded.secrets(c.id).password).toBe('p')
  })

  describe('HashiCorp Vault', () => {
    const vaultInput = (overrides: Partial<ConnectionInput> = {}): ConnectionInput =>
      input({
        user: '',
        authMode: 'vault',
        vault: { address: 'https://vault.example.cloud/', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/ro' },
        ...overrides,
      })

    it('normalizes legacy connections to authMode "password"', () => {
      const c = store.save(input())
      expect(c.authMode).toBe('password')
      const raw = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8')) as Record<string, unknown>[]
      delete raw[0].authMode
      writeFileSync(join(dir, 'connections.json'), JSON.stringify(raw))
      const reloaded = new ConnectionStore(dir, new SecretStore(dir, fakeCrypto(), silent), { log: silent })
      expect(reloaded.get(c.id)?.authMode).toBe('password')
      expect(reloaded.get(c.id)?.hasVaultSecret).toBeUndefined()
    })

    it('saves a Vault connection without a database user and normalizes its settings', () => {
      const c = store.save(vaultInput())
      expect(c.user).toBe('')
      expect(c.authMode).toBe('vault')
      expect(c.vault).toEqual({ address: 'https://vault.example.cloud', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/ro' })
      expect(c.hasVaultSecret).toBe(false)
    })

    it('rejects invalid Vault settings', () => {
      const cases: [Partial<ConnectionInput>, RegExp][] = [
        [{ authMode: 'kerberos' as never }, /authentication mode/],
        [{ vault: undefined }, /Vault settings are required/],
        [{ vault: { address: 'vault.example.cloud', loginMethod: 'token', secretPath: 'a/b' } }, /Vault address/],
        [{ vault: { address: 'https://v.example.cloud', loginMethod: 'token', secretPath: ' ' } }, /secret path/],
        [{ vault: { address: 'https://v.example.cloud', loginMethod: 'token', secretPath: '/v1/database/creds/ro' } }, /\/v1\//],
        [{ vault: { address: 'https://v.example.cloud', loginMethod: 'magic' as never, secretPath: 'a/b' } }, /login method/],
        [{ vault: { address: 'https://v.example.cloud', loginMethod: 'userpass', secretPath: 'a/b' } }, /user name/],
      ]
      for (const [patch, message] of cases) {
        try {
          store.save(vaultInput(patch))
          throw new Error('expected a failure')
        } catch (error) {
          expect(error).toBeInstanceOf(DriverError)
          expect((error as DriverError).info.kind).toBe('invalid-input')
          expect((error as DriverError).message).toMatch(message)
        }
      }
    })

    it('keeps the Vault settings (unchecked) when switching back to a password', () => {
      const c = store.save(input({ vault: { address: 'https://vault.example.cloud', loginMethod: 'oidc', secretPath: '' } }))
      expect(c.authMode).toBe('password')
      expect(c.vault).toEqual({ address: 'https://vault.example.cloud', loginMethod: 'oidc', secretPath: '' })
    })

    it('loads incomplete Vault settings from disk instead of dropping the connection', () => {
      const c = store.save(vaultInput())
      const raw = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8')) as { vault: Record<string, unknown> }[]
      raw[0].vault = { address: 'vault.example.cloud', loginMethod: 'ldap', secretPath: '' }
      writeFileSync(join(dir, 'connections.json'), JSON.stringify(raw))
      const reloaded = new ConnectionStore(dir, new SecretStore(dir, fakeCrypto(), silent), { log: silent })
      expect(reloaded.get(c.id)?.vault).toEqual({ address: 'vault.example.cloud', loginMethod: 'ldap', secretPath: '' })
    })

    it('stores the Vault token / password encrypted only when savePassword is true', () => {
      const kept = store.save(vaultInput({ secrets: { vaultPassword: 'ldap-pw' } }))
      expect(kept.hasVaultSecret).toBe(true)
      expect(diskSecrets(dir)[kept.id]).toEqual({ vaultPassword: 'ldap-pw' })
      expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('ldap-pw')
      expect(readFileSync(join(dir, 'connections.json'), 'utf8')).not.toContain('ldap-pw')

      const tokenConn = store.save(
        vaultInput({ name: 'T', savePassword: false, vault: { address: 'https://v.example.cloud', loginMethod: 'token', secretPath: 'a/b' }, secrets: { vaultToken: 'hvs.mem' } }),
      )
      expect(tokenConn.hasVaultSecret).toBe(false)
      expect(store.secrets(tokenConn.id).vaultToken).toBe('hvs.mem')
      expect(diskSecrets(dir)[tokenConn.id]).toBeUndefined()

      // rememberSecrets (typed at connect time) follows the same rule.
      store.rememberSecrets(tokenConn.id, { vaultToken: 'hvs.typed' })
      expect(diskSecrets(dir)[tokenConn.id]).toBeUndefined()
      store.rememberSecrets(kept.id, { vaultPassword: 'ldap-pw-2' })
      expect(diskSecrets(dir)[kept.id]).toEqual({ vaultPassword: 'ldap-pw-2' })

      // Turning savePassword on persists the in-memory token; '' clears.
      store.save({ ...vaultInput({ name: 'T', vault: { address: 'https://v.example.cloud', loginMethod: 'token', secretPath: 'a/b' } }), id: tokenConn.id })
      expect(diskSecrets(dir)[tokenConn.id]).toEqual({ vaultToken: 'hvs.typed' })
      expect(store.get(tokenConn.id)?.hasVaultSecret).toBe(true)
      store.forgetCachedSecret(tokenConn.id, 'vaultToken')
      store.save({ ...vaultInput({ name: 'T', vault: { address: 'https://v.example.cloud', loginMethod: 'token', secretPath: 'a/b' } }), id: tokenConn.id, secrets: { vaultToken: '' } })
      expect(store.secrets(tokenConn.id).vaultToken).toBeUndefined()
    })

    it('drops the saved Vault token / password when the Vault identity changes (asked again)', () => {
      const c = store.save(vaultInput({ secrets: { vaultPassword: 'ldap-pw', password: 'db-pw' } }))
      // Same identity (secret path / role / name changes): kept.
      store.save({ ...vaultInput({ name: 'Renamed', vault: { address: 'https://vault.example.cloud', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/rw' } }), id: c.id })
      expect(store.secrets(c.id).vaultPassword).toBe('ldap-pw')
      // Another address (typo, or a compromised renderer): dropped from disk and from the run cache.
      store.rememberSecrets(c.id, { vaultPassword: 'ldap-pw-typed' })
      store.save({ ...vaultInput({ vault: { address: 'https://vault.example.internal', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/ro' } }), id: c.id })
      expect(store.secrets(c.id)).toEqual({ password: 'db-pw' })
      expect(store.get(c.id)?.hasVaultSecret).toBe(false)
      expect(diskSecrets(dir)[c.id]).toEqual({ password: 'db-pw' })
      // A secret typed together with the change is kept; other identity changes (user, mount, method) drop it too.
      store.save({ ...vaultInput({ vault: { address: 'https://vault.example.internal', loginMethod: 'ldap', username: 'alice', secretPath: 'database/creds/ro' } }), id: c.id, secrets: { vaultPassword: 'new-pw' } })
      expect(store.secrets(c.id).vaultPassword).toBe('new-pw')
      store.save({ ...vaultInput({ vault: { address: 'https://vault.example.internal', loginMethod: 'ldap', username: 'bob', secretPath: 'database/creds/ro' } }), id: c.id })
      expect(store.secrets(c.id).vaultPassword).toBeUndefined()
    })
  })
})
