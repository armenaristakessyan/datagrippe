import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VaultConfig, VaultStatus } from '@shared/types'
import { vaultIdentityKey } from './config'
import { REVOKE_DENIED_NOTE, VaultService } from './service'
import { dynamicCreds, FakeVault, loginReply, lookupSelf, requireToken } from './testing/fake-vault'

const quiet = { warn: () => undefined, error: () => undefined }

describe('VaultService', () => {
  let vault: FakeVault
  let statuses: VaultStatus[]
  let service: VaultService
  let validTokens: Set<string>
  let issued: number

  const config = (patch: Partial<VaultConfig> = {}): VaultConfig => ({
    address: vault.address,
    loginMethod: 'userpass',
    username: 'alice',
    secretPath: 'database/creds/ro',
    ...patch,
  })

  beforeEach(async () => {
    vault = await FakeVault.start()
    statuses = []
    issued = 0
    validTokens = new Set()
    let logins = 0
    vault.on('POST', 'auth/userpass/login/alice', (req) => {
      if (req.body?.password !== 'alice-pw') return { status: 400, body: { errors: ['invalid username or password'] } }
      const token = `tok-${++logins}`
      validTokens.add(token)
      return loginReply(token)
    })
    vault.on('GET', 'auth/token/lookup-self', (req) => (validTokens.has(req.token ?? '') ? lookupSelf() : { status: 403, body: { errors: ['permission denied'] } }))
    vault.on('GET', 'database/creds/ro', (req) => {
      if (!validTokens.has(req.token ?? '')) return { status: 403, body: { errors: ['permission denied'] } }
      issued++
      return dynamicCreds(`v-alice-ro-${issued}`, `pw-${issued}`, `database/creds/ro/lease-${issued}`, 3600)
    })
    vault.on('PUT', 'sys/leases/revoke', (req) => (validTokens.has(req.token ?? '') ? { status: 204 } : { status: 403, body: { errors: ['permission denied'] } }))
    vault.on('PUT', 'sys/leases/renew', (req) => (validTokens.has(req.token ?? '') ? { body: { lease_id: req.body?.lease_id, lease_duration: 3600, renewable: true } } : { status: 403, body: { errors: ['permission denied'] } }))
    service = new VaultService({ log: quiet, onStatus: (s) => statuses.push(s), revokeTimeoutMs: 300 })
  })
  afterEach(async () => {
    await service.dispose()
    await vault.close()
  })

  it('drops a cached token Vault no longer accepts and logs in again once', async () => {
    await service.issue(config(), { vaultPassword: 'alice-pw' }, { interactive: true })
    validTokens.clear() // token revoked server-side
    const again = await service.issue(config(), { vaultPassword: 'alice-pw' }, { interactive: true })
    expect(again.token.token).toBe('tok-2')
    expect(vault.calls('POST', 'auth/userpass/login/alice')).toHaveLength(2)
  })

  it('does not log in again when the token is valid but the policy denies the path', async () => {
    vault.on('GET', 'database/creds/admin', { status: 403, body: { errors: ['permission denied'] } })
    await service.issue(config(), { vaultPassword: 'alice-pw' }, { interactive: true })
    await expect(service.issue(config({ secretPath: 'database/creds/admin' }), { vaultPassword: 'alice-pw' }, { interactive: true })).rejects.toMatchObject({
      info: {
        kind: 'vault',
        code: '403',
        message: 'Vault: permission denied on database/creds/admin (403)',
        detail: 'DataGrippe used a userpass sign-in: check that its Vault policy can read this path.',
      },
    })
    expect(vault.calls('POST', 'auth/userpass/login/alice')).toHaveLength(1)
  })

  it('says which token a refused secret read used (VAULT_TOKEN wins over a typed token)', async () => {
    vault.on('GET', 'auth/token/lookup-self', (req) => (req.token === 'env-tok' ? lookupSelf() : { status: 403, body: { errors: ['permission denied'] } }))
    vault.on('GET', 'database/creds/ro', { status: 403, body: { errors: ['permission denied'] } })
    const tokenService = new VaultService({ log: quiet, env: () => ({ VAULT_ADDR: vault.address, VAULT_TOKEN: 'env-tok' }) })
    try {
      const result = await tokenService.test(config({ loginMethod: 'token' }), { vaultToken: 'typed-tok' })
      expect(result).toMatchObject({ ok: false, error: { code: '403', detail: expect.stringContaining('the token from VAULT_TOKEN') } })
      expect(JSON.stringify(result)).not.toMatch(/env-tok|typed-tok/)
    } finally {
      await tokenService.dispose()
    }
  })

  it('test() logs in, reads the secret, revokes the lease and never throws', async () => {
    const result = await service.test(config(), { vaultPassword: 'alice-pw' })
    expect(result.ok).toBe(true)
    expect(result.info).toMatchObject({ username: 'v-alice-ro-1', kind: 'dynamic', tokenSource: 'userpass', leaseDurationSec: 3600 })
    expect(JSON.stringify(result)).not.toMatch(/pw-1|alice-pw|tok-1/)
    expect(vault.calls('PUT', 'sys/leases/revoke').map((r) => r.body)).toEqual([{ lease_id: 'database/creds/ro/lease-1' }])

    service.logout(vault.address) // otherwise the cached token is used
    const failed = await service.test(config(), { vaultPassword: 'nope' })
    expect(failed).toMatchObject({ ok: false, error: { kind: 'needs-password', secretField: 'vaultPassword' } })
    const invalid = await service.test(config({ address: 'http://127.0.0.1:1' }), { vaultPassword: 'alice-pw' })
    expect(invalid.ok).toBe(false)
    expect(invalid.error?.kind).toBe('vault')
  })

  it('acquire() installs credentials; end() revokes the leases unless revokeOnDisconnect is false', async () => {
    const creds = await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({ vaultPassword: 'alice-pw' }), onRotated: async () => undefined })
    expect(creds).toMatchObject({ username: 'v-alice-ro-1', password: 'pw-1' })
    expect(service.current('c1')).toEqual(creds)
    expect(service.status('c1')).toMatchObject({ state: 'valid', info: { username: 'v-alice-ro-1' } })
    expect(statuses).toHaveLength(1)
    await service.end('c1', 'another-key') // not ours: ignored
    expect(service.has('c1')).toBe(true)
    await service.end('c1', creds.leaseKey)
    expect(service.status('c1')).toBeNull()
    expect(vault.calls('PUT', 'sys/leases/revoke')).toHaveLength(1)

    await service.acquire('c2', config({ revokeOnDisconnect: false }), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    await service.end('c2')
    expect(vault.calls('PUT', 'sys/leases/revoke')).toHaveLength(1)
  })

  it('refresh() issues new credentials, calls onRotated and revokes the unused previous lease', async () => {
    let rotated = 0
    const first = await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({ vaultPassword: 'alice-pw' }), onRotated: async () => void rotated++ })
    service.retain('c1', first.leaseKey, 'metadata')
    const status = await service.refresh('c1')
    expect(status.info?.username).toBe('v-alice-ro-2')
    expect(rotated).toBe(1)
    expect(vault.calls('PUT', 'sys/leases/revoke')).toHaveLength(0)
    service.release('c1', first.leaseKey, 'metadata')
    await new Promise((r) => setTimeout(r, 20))
    expect(vault.calls('PUT', 'sys/leases/revoke').map((r) => r.body?.lease_id)).toEqual(['database/creds/ro/lease-1'])
    await expect(service.refresh('unknown')).rejects.toMatchObject({ info: { kind: 'not-found' } })
  })

  it('bounds a hanging revocation', async () => {
    vault.on('PUT', 'sys/leases/revoke', { hang: true })
    await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    const started = Date.now()
    await service.end('c1')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('renews with a current token when the issuing token expired', async () => {
    const creds = await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({ vaultPassword: 'alice-pw' }), onRotated: async () => undefined })
    validTokens.clear()
    // The renewal op (normally run by the lease timer) first uses the issuing token (403), then a fresh login.
    const renew = (service as unknown as { renew: (...a: unknown[]) => Promise<{ leaseDurationSec: number }> }).renew.bind(service)
    const lease = { creds: { leaseId: 'database/creds/ro/lease-1' }, token: { token: 'tok-1', key: vaultIdentityKey(config()), source: 'userpass', renewable: true, cached: false, obtainedAt: 0 } }
    const result = await renew(config(), () => ({ vaultPassword: 'alice-pw' }), lease, 3600)
    expect(result.leaseDurationSec).toBe(3600)
    expect(vault.calls('PUT', 'sys/leases/renew').map((r) => r.token)).toEqual(['tok-1', 'tok-2'])
    expect(creds.username).toBe('v-alice-ro-1')
  })

  it('a policy without sys/leases/revoke: no retry with another token, reported by test() and the status', async () => {
    vault.on('PUT', 'sys/leases/revoke', { status: 403, body: { errors: ['permission denied'] } })
    const tested = await service.test(config(), { vaultPassword: 'alice-pw' })
    expect(tested).toMatchObject({ ok: true, warnings: [REVOKE_DENIED_NOTE] })
    expect(vault.calls('POST', 'auth/userpass/login/alice')).toHaveLength(1) // the token is valid: no new login
    expect(vault.calls('PUT', 'sys/leases/revoke')).toHaveLength(1)

    await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    expect(service.status('c1')).toMatchObject({ state: 'valid', message: REVOKE_DENIED_NOTE })
    // Not shown when the connection does not revoke anyway.
    await service.acquire('c2', config({ revokeOnDisconnect: false }), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    expect(service.status('c2')?.message).toBeUndefined()
    expect((await service.test(config({ revokeOnDisconnect: false }), { vaultPassword: 'alice-pw' })).warnings).toBeUndefined()
  })

  it('learns at connect time (sys/capabilities-self) that the policy does not allow revoking', async () => {
    vault.on('POST', 'sys/capabilities-self', { body: { capabilities: ['deny'], 'sys/leases/revoke': ['deny'], data: { capabilities: ['deny'], 'sys/leases/revoke': ['deny'] } } })
    await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    await new Promise((r) => setTimeout(r, 50))
    expect(service.status('c1')?.message).toBe(REVOKE_DENIED_NOTE)
    expect(statuses.at(-1)?.message).toBe(REVOKE_DENIED_NOTE)
    expect(vault.calls('POST', 'sys/capabilities-self')[0].body).toEqual({ paths: ['sys/leases/revoke'] })
  })

  it('revokes with the current token when the issuing one was revoked (403 + lookup-self refused)', async () => {
    const creds = await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({ vaultPassword: 'alice-pw' }), onRotated: async () => undefined })
    validTokens.delete('tok-1')
    service.logout(vault.address)
    await service.issue(config(), { vaultPassword: 'alice-pw' }, { interactive: false }) // caches tok-2
    await service.end('c1', creds.leaseKey)
    expect(vault.calls('PUT', 'sys/leases/revoke').map((r) => r.token)).toEqual(['tok-1', 'tok-2'])
  })

  it('dispose() revokes what the session manager could not (shutdown timed out)', async () => {
    await service.acquire('c1', config(), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    await service.acquire('c2', config({ revokeOnDisconnect: false }), { vaultPassword: 'alice-pw' }, { secrets: () => ({}), onRotated: async () => undefined })
    await service.dispose()
    expect(vault.calls('PUT', 'sys/leases/revoke').map((r) => r.body?.lease_id)).toEqual(['database/creds/ro/lease-1'])
  })

  it('a token that cannot outlive the lease is not reused for the new credentials', async () => {
    vault.on('GET', 'auth/token/lookup-self', (req) => (req.token === 'env-tok' ? { body: { data: { ttl: 60, renewable: false } } } : { status: 403, body: { errors: ['permission denied'] } }))
    vault.on('GET', 'database/creds/ro', dynamicCreds('v-tok', 'pw', 'database/creds/ro/t', 3600))
    const tokenService = new VaultService({ log: quiet, env: () => ({ VAULT_ADDR: vault.address, VAULT_TOKEN: 'env-tok' }) })
    try {
      await tokenService.acquire('c1', config({ loginMethod: 'token' }), {}, { secrets: () => ({}), onRotated: async () => undefined })
      expect(tokenService.status('c1')?.info?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000)
      // VAULT_TOKEN is still the same dying token: refreshing says what to do instead of issuing credentials that die with it.
      await expect(tokenService.refresh('c1')).rejects.toMatchObject({ message: expect.stringMatching(/The Vault token expires at .+ and cannot be renewed: sign in to Vault again/) })
      expect(vault.calls('GET', 'database/creds/ro')).toHaveLength(1)
    } finally {
      await tokenService.dispose()
    }
  })

  it('requireToken helper sanity', async () => {
    vault.on('GET', 'x', requireToken('a', { body: { data: {} } }))
    expect((await fetch(`${vault.address}/v1/x`)).status).toBe(403)
  })
})
