import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VaultConfig } from '@shared/types'
import { DriverError } from '../db/errors'
import { VaultClient } from './client'
import { credentialsInfo, parseSecret, readCredentials } from './credentials'
import { FakeVault } from './testing/fake-vault'

const base: VaultConfig = { address: 'https://vault.example.cloud', loginMethod: 'token', secretPath: 'database/creds/ro' }

function parseError(fn: () => unknown): DriverError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(DriverError)
    return error as DriverError
  }
  throw new Error('expected a failure')
}

describe('parseSecret', () => {
  it('reads a database secrets engine answer (dynamic lease)', () => {
    const creds = parseSecret(
      { lease_id: 'database/creds/ro/abc', lease_duration: 3600, renewable: true, data: { username: 'v-token-ro-xyz', password: 'A1a-secret' } },
      base,
      5_000,
    )
    expect(creds).toEqual({
      username: 'v-token-ro-xyz',
      password: 'A1a-secret',
      kind: 'dynamic',
      leaseId: 'database/creds/ro/abc',
      leaseDurationSec: 3600,
      renewable: true,
      issuedAt: 5_000,
      expiresAt: 5_000 + 3_600_000,
    })
    expect(credentialsInfo(creds, 'oidc')).toEqual({
      username: 'v-token-ro-xyz',
      kind: 'dynamic',
      tokenSource: 'oidc',
      issuedAt: 5_000,
      expiresAt: 3_605_000,
      leaseDurationSec: 3600,
      renewable: true,
    })
    expect(JSON.stringify(credentialsInfo(creds, 'oidc'))).not.toContain('A1a-secret')
  })

  it('reads KV v2 (data.data) and KV v1 (data) secrets, with custom keys', () => {
    const kv2 = parseSecret({ data: { data: { username: 'app', password: 'pw' }, metadata: { version: 3 } } }, { ...base, secretPath: 'secret/data/app' }, 1)
    expect(kv2).toEqual({ username: 'app', password: 'pw', kind: 'static', issuedAt: 1 })
    const kv1 = parseSecret({ data: { db_user: 'legacy', db_pass: 'pw1' }, lease_duration: 2764800 }, { ...base, usernameKey: 'db_user', passwordKey: 'db_pass' }, 2)
    expect(kv1).toEqual({ username: 'legacy', password: 'pw1', kind: 'static', issuedAt: 2 })
    // database/static-creds: no lease, rotated by Vault.
    const staticCreds = parseSecret({ data: { username: 'svc', password: 'pw2', ttl: 100, last_vault_rotation: 'x' } }, base, 3)
    expect(staticCreds.kind).toBe('static')
  })

  it('gives database static roles (static-creds) an expiry at the next password rotation', () => {
    const body = { data: { username: 'svc', password: 'pw2', ttl: 100, rotation_period: 3600, last_vault_rotation: '2026-10-05T10:00:00Z' } }
    expect(parseSecret(body, { ...base, secretPath: 'database/static-creds/svc' }, 3)).toEqual({ username: 'svc', password: 'pw2', kind: 'static', issuedAt: 3, expiresAt: 100_003 })
    expect(credentialsInfo(parseSecret(body, base, 3), 'ldap')).toMatchObject({ kind: 'static', expiresAt: 100_003 })
    // A KV secret that merely has a "ttl" field (no rotation fields) never expires.
    expect(parseSecret({ data: { username: 'app', password: 'pw', ttl: 30 } }, base, 3).expiresAt).toBeUndefined()
  })

  it('refuses a secret that hands back the Vault token itself', () => {
    const error = parseError(() =>
      parseSecret({ data: { id: 'hvs.the-token', accessor: 'acc' } }, { ...base, usernameKey: 'id', passwordKey: 'accessor' }, 1, 'hvs.the-token'),
    )
    expect(error.info.kind).toBe('vault')
    expect(error.message).not.toContain('hvs.the-token')
  })

  it('lists the available key names (never values) when keys are missing', () => {
    const error = parseError(() =>
      parseSecret({ data: { data: { user: 'u', pass: 'very-secret-value' }, metadata: {} } }, { ...base, secretPath: 'secret/data/app' }, 1),
    )
    expect(error.info.kind).toBe('vault')
    expect(error.message).toBe('Vault: the KV v2 secret at secret/data/app has no "username" and "password" key (available keys: "pass", "user")')
    expect(error.message).not.toContain('very-secret-value')
    const one = parseError(() => parseSecret({ data: { username: 'u' } }, base, 1))
    expect(one.message).toBe('Vault: the secret at database/creds/ro has no "password" key (available keys: "username")')
  })

  it('reports deleted KV v2 versions and empty answers', () => {
    expect(parseError(() => parseSecret({ data: { data: null, metadata: { deletion_time: 'x' } } }, base, 1)).message).toMatch(/deleted or destroyed/)
    expect(parseError(() => parseSecret(null, base, 1)).message).toBe('Vault: the secret at database/creds/ro has no data')
  })
})

describe('readCredentials', () => {
  let vault: FakeVault
  beforeEach(async () => {
    vault = await FakeVault.start()
  })
  afterEach(async () => vault.close())

  it('GETs the secret path with the token', async () => {
    vault.on('GET', 'database/creds/ro', { body: { lease_id: 'l1', lease_duration: 60, renewable: true, data: { username: 'u', password: 'p' } } })
    const creds = await readCredentials(new VaultClient({ address: vault.address }), 'tok', { ...base, address: vault.address }, { now: () => 10 })
    expect(creds).toMatchObject({ username: 'u', kind: 'dynamic', expiresAt: 60_010 })
    expect(vault.requests[0].token).toBe('tok')
  })

  it('hints at the KV v2 data/ prefix on a 404', async () => {
    const config = { ...base, address: vault.address, secretPath: 'secret/app' }
    try {
      await readCredentials(new VaultClient({ address: vault.address }), 'tok', config, { now: () => 0 })
      expect.fail('expected a failure')
    } catch (error) {
      expect((error as DriverError).message).toBe('Vault: nothing found at secret/app (404). For a KV v2 secret the path includes "data/" (e.g. secret/data/my-app).')
    }
  })
})
