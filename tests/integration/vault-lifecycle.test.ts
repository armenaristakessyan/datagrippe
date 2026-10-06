// Vault credential lifecycle against the dev Vault (docker-compose.test.yml): the issuing token's own TTL,
// database static roles, consoles on a superseded lease, sign-in errors and policies without revoke.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { VaultConfig } from '@shared/types'
import { DriverError } from '../../src/main/db/errors'
import { LEASE_ENDED_REASON } from '../../src/main/db/session-manager'
import { VaultAuth } from '../../src/main/vault/login'
import { REVOKE_DENIED_NOTE } from '../../src/main/vault/service'
import { vaultAvailable, vaultNames } from '../setup/vault'
import { TEST_PG, TEST_VAULT } from '../test-env'
import { createVaultHarness, pgVaultInput, quiet, rootApi } from './helpers/vault'

const available = await vaultAvailable()
const n = vaultNames()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!available)('Vault credential lifecycle (dev server)', () => {
  let admin: pg.Client
  const roleExists = async (name: string) => ((await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount ?? 0) > 0

  beforeAll(async () => {
    admin = new pg.Client({ host: TEST_PG.host, port: TEST_PG.port, user: TEST_PG.user, password: TEST_PG.password, database: TEST_PG.database })
    await admin.connect()
  })
  afterAll(async () => {
    await admin?.end()
  })

  const userpass = (user: string, secretPath: string): VaultConfig => ({
    address: TEST_VAULT.address,
    loginMethod: 'userpass',
    authMount: n.userpassMount,
    username: user,
    secretPath,
  })

  describe('a Vault token shorter-lived than the database lease', () => {
    const user = `${n.db}-shorttok`
    const capped = `${n.db}-cappedtok`
    const password = 'shorttok-test-pw'
    beforeAll(async () => {
      // Renewable tokens: 6 s TTL extendable up to 2 min, and 4 s TTL capped at 8 s. The database leases last 1 h.
      await rootApi('POST', `auth/${n.userpassMount}/users/${user}`, { password, token_policies: [n.readerPolicy], token_ttl: '6s', token_max_ttl: '120s' })
      await rootApi('POST', `auth/${n.userpassMount}/users/${capped}`, { password, token_policies: [n.readerPolicy], token_ttl: '4s', token_max_ttl: '8s' })
    })
    afterAll(async () => {
      await rootApi('DELETE', `auth/${n.userpassMount}/users/${user}`)
      await rootApi('DELETE', `auth/${n.userpassMount}/users/${capped}`)
    })

    it('renews the token so Vault keeps the database user, and reports the token-bound deadline', { timeout: 60_000 }, async () => {
      const h = createVaultHarness()
      try {
        const saved = h.store.save(pgVaultInput(userpass(user, `${n.dbMount}/creds/${n.pgRole}`), { vaultPassword: password }))
        await h.manager.connect(saved.id)
        const info = h.manager.vaultStatus(saved.id)?.info
        const dbUser = info?.username ?? ''
        expect(dbUser).toMatch(/^v-/)
        expect(info?.leaseDurationSec).toBe(3600)
        // Vault revokes the lease with its token: the real deadline is the token's (6 s), not the lease's (1 h).
        expect(info?.expiresAt).toBeLessThanOrEqual(Date.now() + 7_000)

        await sleep(10_000) // past the first token TTL

        expect(h.manager.vaultStatus(saved.id)?.state).toBe('valid')
        expect(await roleExists(dbUser)).toBe(true)
        const session = await h.manager.openSession({ connectionId: saved.id })
        const result = await h.manager.execute(session.sessionId, 'SELECT count(*) FROM public.customers', { maxRows: 1 })
        expect(result.results[0].error).toBeUndefined()
        expect(h.manager.vaultStatus(saved.id)?.info?.expiresAt).toBeGreaterThan(Date.now())
      } finally {
        await h.dispose()
      }
    })

    it('signs in again before a token at its max TTL ends, and moves the consoles opened earlier', { timeout: 60_000 }, async () => {
      const h = createVaultHarness()
      try {
        const saved = h.store.save(pgVaultInput(userpass(capped, `${n.dbMount}/creds/${n.pgRole}`), { vaultPassword: password }, 'dg-vault-capped'))
        await h.manager.connect(saved.id)
        const first = h.manager.vaultStatus(saved.id)?.info?.username ?? ''
        const early = await h.manager.openSession({ connectionId: saved.id })
        const who = async () => (await h.manager.execute(early.sessionId, 'SELECT current_user', { maxRows: 1 })).results[0]

        await vi.waitFor(() => expect(h.statuses.some((s) => s.state === 'expiring' && /Vault token cannot be renewed past/.test(s.message ?? ''))).toBe(true), {
          timeout: 10_000,
          interval: 200,
        })
        await vi.waitFor(() => expect(h.manager.vaultStatus(saved.id)?.info?.username).not.toBe(first), { timeout: 10_000, interval: 200 })
        const second = h.manager.vaultStatus(saved.id)?.info?.username
        await sleep(2_000) // the first token (and with it the first user) is gone by now
        expect(await roleExists(first)).toBe(false)
        const row = await who()
        expect(row.error).toBeUndefined()
        // The console was moved to the new user (same session id) before Vault dropped the first one.
        expect([second, h.manager.vaultStatus(saved.id)?.info?.username]).toContain(row.rows[0][0])
        expect(h.events.some((e) => e.event === 'event:sessionClosed')).toBe(false)
      } finally {
        await h.dispose()
      }
    })
  })

  describe('a database static role (static-creds)', () => {
    const dbRole = `${n.db}_static`
    const staticRole = `${n.db}-static`
    const dbConfig = `${n.db}-static-pg`
    const policy = `${n.db}-static`
    const user = `${n.db}-static-user`
    const password = 'static-test-pw'
    beforeAll(async () => {
      await admin.query(`DROP ROLE IF EXISTS "${dbRole}"`)
      await admin.query(`CREATE ROLE "${dbRole}" WITH LOGIN PASSWORD 'initial-static-pw'`)
      await admin.query(`GRANT CONNECT ON DATABASE "${n.db}" TO "${dbRole}"`)
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${dbRole}"`)
      await admin.query(`GRANT SELECT ON public.customers TO "${dbRole}"`)
      await rootApi('POST', `${n.dbMount}/config/${dbConfig}`, {
        plugin_name: 'postgresql-database-plugin',
        connection_url: `postgresql://{{username}}:{{password}}@${TEST_VAULT.pgHost}:${TEST_VAULT.pgPort}/${n.db}?sslmode=disable`,
        username: TEST_PG.user,
        password: TEST_PG.password,
        allowed_roles: [staticRole],
        verify_connection: true,
      })
      await rootApi('POST', `${n.dbMount}/static-roles/${staticRole}`, { db_name: dbConfig, username: dbRole, rotation_period: '1h' })
      await rootApi('PUT', `sys/policies/acl/${policy}`, { policy: `path "${n.dbMount}/static-creds/*" { capabilities = ["read"] }` })
      await rootApi('POST', `auth/${n.userpassMount}/users/${user}`, { password, token_policies: [policy], token_ttl: '1h' })
    })
    afterAll(async () => {
      await rootApi('DELETE', `auth/${n.userpassMount}/users/${user}`)
      await rootApi('DELETE', `${n.dbMount}/static-roles/${staticRole}`)
      await rootApi('DELETE', `${n.dbMount}/config/${dbConfig}`)
      await rootApi('DELETE', `sys/policies/acl/${policy}`)
      await admin.query(`REVOKE ALL ON public.customers FROM "${dbRole}"`).catch(() => undefined)
      await admin.query(`REVOKE USAGE ON SCHEMA public FROM "${dbRole}"`).catch(() => undefined)
      await admin.query(`REVOKE CONNECT ON DATABASE "${n.db}" FROM "${dbRole}"`).catch(() => undefined)
      await admin.query(`DROP ROLE IF EXISTS "${dbRole}"`).catch(() => undefined)
    })

    it('knows when the password rotates, and reads it again when the database refuses the old one', { timeout: 60_000 }, async () => {
      const h = createVaultHarness()
      try {
        const saved = h.store.save(pgVaultInput(userpass(user, `${n.dbMount}/static-creds/${staticRole}`), { vaultPassword: password }))
        await h.manager.connect(saved.id)
        const info = h.manager.vaultStatus(saved.id)?.info
        expect(info).toMatchObject({ username: dbRole, kind: 'static' })
        // Next rotation within the hour.
        expect(info?.expiresAt).toBeGreaterThan(Date.now())
        expect(info?.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)

        // Rotated out of schedule (or the timer missed it): new consoles and the explorer still work.
        await rootApi('POST', `${n.dbMount}/rotate-role/${staticRole}`, {})
        const session = await h.manager.openSession({ connectionId: saved.id })
        const result = await h.manager.execute(session.sessionId, 'SELECT count(*) FROM public.customers', { maxRows: 1 })
        expect(result.results[0].error).toBeUndefined()
        await rootApi('POST', `${n.dbMount}/rotate-role/${staticRole}`, {})
        await expect(h.manager.databases(saved.id)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ name: n.db })]))
      } finally {
        await h.dispose()
      }
    })
  })

  it('moves a console off a lease that reached its max TTL before Vault drops its user', { timeout: 60_000 }, async () => {
    const h = createVaultHarness()
    try {
      const saved = h.store.save(pgVaultInput(userpass(n.readerUser, `${n.dbMount}/creds/${n.pgShortRole}`), { vaultPassword: n.readerPassword }, 'dg-vault-maxttl'))
      await h.manager.connect(saved.id)
      const first = h.manager.vaultStatus(saved.id)?.info?.username
      const early = await h.manager.openSession({ connectionId: saved.id })
      const run = (sql: string) => h.manager.execute(early.sessionId, sql, { maxRows: 1 })
      expect((await run('SELECT count(*) FROM public.customers')).results[0].error).toBeUndefined()

      // Role: default_ttl 8 s, max_ttl 20 s → re-issued around 19 s, first lease revoked by Vault at 20 s.
      await vi.waitFor(() => expect(h.manager.vaultStatus(saved.id)?.info?.username).not.toBe(first), { timeout: 25_000, interval: 250 })
      const second = h.manager.vaultStatus(saved.id)?.info?.username
      await sleep(3_000)

      const after = await run('SELECT current_user, (SELECT count(*) FROM public.customers)')
      expect(after.results[0].error).toBeUndefined()
      expect(after.results[0].rows[0][0]).toBe(second)
      expect(h.manager.sessionInfo(early.sessionId).connectionId).toBe(saved.id)
      expect(h.events.some((e) => e.event === 'event:sessionClosed')).toBe(false)
      expect(LEASE_ENDED_REASON).toMatch(/maximum TTL/)
    } finally {
      await h.dispose()
    }
  })

  it('reports a wrong auth mount as a Vault error, not as a rejected password', async () => {
    const auth = new VaultAuth({ env: () => ({}), homeDir: () => '/nonexistent', log: quiet })
    const config: VaultConfig = { ...userpass(n.readerUser, `${n.dbMount}/creds/${n.pgRole}`), authMount: `${n.db}-no-such-userpass` }
    let error: unknown
    try {
      await auth.getToken(config, { vaultPassword: n.readerPassword }, { interactive: true })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).info).toMatchObject({ kind: 'vault', code: '403' })
    expect((error as DriverError).message).toMatch(new RegExp(`Check the auth mount: "${n.db}-no-such-userpass" may not exist`))
    // The right mount with a wrong password is still a password prompt.
    const wrong = await auth.getToken({ ...config, authMount: n.userpassMount }, { vaultPassword: 'not-the-password' }, { interactive: true }).catch((e: unknown) => e)
    expect((wrong as DriverError).info).toMatchObject({ kind: 'needs-password', secretField: 'vaultPassword' })
  })

  describe('a policy without sys/leases/revoke (Vault default policy)', () => {
    const policy = `${n.db}-norevoke`
    const user = `${n.db}-norevoke-user`
    const password = 'norevoke-test-pw'
    beforeAll(async () => {
      await rootApi('PUT', `sys/policies/acl/${policy}`, { policy: `path "${n.dbMount}/creds/*" { capabilities = ["read"] }` })
      await rootApi('POST', `auth/${n.userpassMount}/users/${user}`, { password, token_policies: [policy, 'default'], token_ttl: '1h' })
    })
    afterAll(async () => {
      await rootApi('DELETE', `auth/${n.userpassMount}/users/${user}`)
      await rootApi('DELETE', `sys/policies/acl/${policy}`)
    })

    it('tells the user that disconnecting cannot drop the temporary user', { timeout: 30_000 }, async () => {
      const h = createVaultHarness()
      try {
        const input = pgVaultInput(userpass(user, `${n.dbMount}/creds/${n.pgRole}`), { vaultPassword: password })
        const tested = await h.manager.vaultTest(input)
        expect(tested).toMatchObject({ ok: true, warnings: [REVOKE_DENIED_NOTE] })
        const saved = h.store.save(input)
        await h.manager.connect(saved.id)
        await vi.waitFor(() => expect(h.manager.vaultStatus(saved.id)).toMatchObject({ state: 'valid', message: REVOKE_DENIED_NOTE }))
        const dbUser = h.manager.vaultStatus(saved.id)?.info?.username ?? ''
        await h.manager.disconnect(saved.id)
        expect(await roleExists(dbUser)).toBe(true) // stays until its lease expires, as announced
        await rootApi('PUT', 'sys/leases/revoke-prefix/' + `${n.dbMount}/creds/${n.pgRole}`, {}).catch(() => undefined)
      } finally {
        await h.dispose()
      }
    })
  })

  it('never reads Vault APIs as a "secret" (the token would come back as the user name)', async () => {
    const h = createVaultHarness({ env: () => ({ VAULT_ADDR: TEST_VAULT.address }) })
    try {
      writeFileSync(join(h.home, '.vault-token'), TEST_VAULT.rootToken)
      const result = await h.manager.vaultTest(
        pgVaultInput({ address: TEST_VAULT.address, loginMethod: 'token', secretPath: 'auth/token/lookup-self', usernameKey: 'id', passwordKey: 'accessor' }, undefined),
      )
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-input' } })
      expect(JSON.stringify(result)).not.toContain(TEST_VAULT.rootToken)
    } finally {
      await h.dispose()
    }
  })
})
