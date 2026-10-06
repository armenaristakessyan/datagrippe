import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VaultConfig, VaultLoginEvent } from '@shared/types'
import { DriverError } from '../db/errors'
import { MemoryVaultTokenStore } from '../store/vault-tokens'
import { isLoginRequired, VaultAuth, type VaultAuthDeps } from './login'
import { FakeVault, freePort, loginReply, lookupSelf, requireToken } from './testing/fake-vault'

const quiet = { warn: () => undefined, error: () => undefined }

async function failure(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DriverError)
    return error as DriverError
  }
  throw new Error('expected a failure')
}

describe('VaultAuth', () => {
  let vault: FakeVault
  let home: string
  let env: Record<string, string | undefined>
  let now: number
  let events: VaultLoginEvent[]

  const make = (extra: Partial<VaultAuthDeps> = {}) =>
    new VaultAuth({ env: () => env, homeDir: () => home, now: () => now, emit: (e) => events.push(e), log: quiet, ...extra })
  const config = (patch: Partial<VaultConfig> = {}): VaultConfig => ({ address: vault.address, loginMethod: 'token', secretPath: 'database/creds/ro', ...patch })

  beforeEach(async () => {
    vault = await FakeVault.start()
    home = mkdtempSync(join(tmpdir(), 'dg-vault-home-'))
    // The CLI token belongs to VAULT_ADDR: only that server receives it.
    env = { VAULT_ADDR: vault.address }
    now = 1_000_000
    events = []
  })
  afterEach(async () => {
    await vault.close()
    rmSync(home, { recursive: true, force: true })
  })

  describe('token method', () => {
    it('prefers VAULT_TOKEN, then ~/.vault-token, then the stored token', async () => {
      const tokens = new Map([
        ['env-tok', lookupSelf()],
        ['cli-tok', lookupSelf()],
        ['stored-tok', lookupSelf()],
      ])
      vault.on('GET', 'auth/token/lookup-self', (req) => tokens.get(req.token ?? '') ?? { status: 403, body: { errors: ['permission denied'] } })
      env.VAULT_TOKEN = 'env-tok'
      writeFileSync(join(home, '.vault-token'), 'cli-tok\n')

      expect((await make().getToken(config(), { vaultToken: 'stored-tok' }, { interactive: true })).source).toBe('env')
      tokens.delete('env-tok')
      expect((await make().getToken(config(), { vaultToken: 'stored-tok' }, { interactive: true })).source).toBe('cli')
      tokens.delete('cli-tok')
      const stored = await make().getToken(config(), { vaultToken: 'stored-tok' }, { interactive: true })
      expect(stored).toMatchObject({ source: 'stored', token: 'stored-tok', renewable: true, expiresAt: now + 3_600_000 })
    })

    it('asks for a token (needs-password / vaultToken) when none is valid, without leaking any', async () => {
      vault.on('GET', 'auth/token/lookup-self', { status: 403, body: { errors: ['permission denied'] } })
      env.VAULT_TOKEN = 'env-bad-token'
      writeFileSync(join(home, '.vault-token'), 'cli-bad-token')
      const error = await failure(make().getToken(config({ oidcFallback: false }), { vaultToken: 'stored-bad-token' }, { interactive: true }))
      expect(error.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultToken', message: `Vault token required for ${vault.address}` })
      expect(error.info.detail).toBe('Vault rejected VAULT_TOKEN, ~/.vault-token, the saved token (expired or revoked).')
      expect(JSON.stringify(error.info)).not.toMatch(/bad-token/)

      env = {}
      rmSync(join(home, '.vault-token'))
      const none = await failure(make().getToken(config({ namespace: 'team', oidcFallback: false }), {}, { interactive: true }))
      expect(none.info.message).toBe(`Vault token required for ${vault.address} (namespace team)`)
      expect(none.info.detail).toBeUndefined()
    })

    it('reads ~/.vault-token but never writes it', async () => {
      vault.on('GET', 'auth/token/lookup-self', requireToken('cli-tok', lookupSelf()))
      const file = join(home, '.vault-token')
      writeFileSync(file, 'cli-tok')
      const before = statSync(file).mtimeMs
      const auth = make()
      await auth.getToken(config(), {}, { interactive: true })
      auth.logout(vault.address)
      await auth.getToken(config(), {}, { interactive: true })
      expect(readFileSync(file, 'utf8')).toBe('cli-tok')
      expect(statSync(file).mtimeMs).toBe(before)
    })

    it('sends VAULT_TOKEN / ~/.vault-token only to the VAULT_ADDR server, or to one the user approved', async () => {
      vault.on('GET', 'auth/token/lookup-self', lookupSelf())
      env = { VAULT_ADDR: 'https://vault.example.cloud', VAULT_TOKEN: 'env-tok' }
      writeFileSync(join(home, '.vault-token'), 'cli-tok')
      const noFallback = config({ oidcFallback: false })
      // VAULT_ADDR names another server: neither ambient token is sent, only the saved one.
      const stored = await make().getToken(noFallback, { vaultToken: 'stored-tok' }, { interactive: true })
      expect(stored.source).toBe('stored')
      expect(vault.requests.map((r) => r.token)).toEqual(['stored-tok'])
      vault.requests.length = 0

      // No VAULT_ADDR (started from Finder): the user is asked once per server and run.
      env = { VAULT_TOKEN: 'env-tok' }
      const asked: { address: string; sources: string[] }[] = []
      let answer: boolean | 'always' = false
      const auth = make({ confirmAmbientToken: async (request) => (asked.push(request), answer) })
      const none = await failure(auth.getToken(noFallback, {}, { interactive: true }))
      expect(none.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultToken' })
      expect(asked).toEqual([{ address: vault.address, sources: ['env', 'cli'] }])
      await failure(auth.getToken(noFallback, {}, { interactive: true }))
      expect(asked).toHaveLength(1) // refused: not asked again
      expect(vault.requests).toHaveLength(0)

      answer = true
      const approving = make({ confirmAmbientToken: async (request) => (asked.push(request), answer) })
      // Background logins never ask.
      await failure(approving.getToken(noFallback, {}, { interactive: false }))
      expect(asked).toHaveLength(1)
      expect((await approving.getToken(noFallback, {}, { interactive: true })).source).toBe('env')
      expect(asked).toHaveLength(2)
      expect((await approving.getToken(noFallback, {}, { interactive: false })).source).toBe('env') // cached
      // Signing out also withdraws the permission: the next interactive login asks again.
      approving.logout(vault.address)
      await failure(approving.getToken(noFallback, {}, { interactive: false }))
      expect((await approving.getToken(noFallback, {}, { interactive: true })).source).toBe('env')
      expect(asked).toHaveLength(3)
    })

    it('trusts the VAULT_ADDR of the login shell like the terminal does, without asking', async () => {
      vault.on('GET', 'auth/token/lookup-self', requireToken('cli-tok', lookupSelf()))
      env = {}
      writeFileSync(join(home, '.vault-token'), 'cli-tok')
      const asked: string[] = []
      const shell = make({
        environment: async () => ({ address: `${vault.address}/`, source: 'login-shell' }),
        confirmAmbientToken: async (request) => (asked.push(request.address), false),
      })
      expect((await shell.getToken(config(), {}, { interactive: true })).source).toBe('cli')
      expect(asked).toEqual([])

      // The login shell names another server: the CLI token never goes to this one (no question either).
      const other = make({
        environment: async () => ({ address: 'https://vault.example.shared', source: 'login-shell' }),
        confirmAmbientToken: async (request) => (asked.push(request.address), true),
      })
      await failure(other.getToken(config({ oidcFallback: false }), {}, { interactive: true }))
      expect(asked).toEqual([])
    })

    it('remembers "always" per server across runs (token store), until sign-out', async () => {
      vault.on('GET', 'auth/token/lookup-self', requireToken('cli-tok', lookupSelf()))
      env = {}
      writeFileSync(join(home, '.vault-token'), 'cli-tok')
      const store = new MemoryVaultTokenStore()
      const asked: string[] = []
      const first = make({ tokenStore: store, confirmAmbientToken: async (request) => (asked.push(request.address), 'always') })
      expect((await first.getToken(config(), {}, { interactive: true })).source).toBe('cli')
      const second = make({ tokenStore: store, confirmAmbientToken: async (request) => (asked.push(request.address), false) })
      // A new run: trusted without asking, even for a background login.
      expect((await second.getToken(config(), {}, { interactive: false })).source).toBe('cli')
      expect(asked).toHaveLength(1)
      second.logout(vault.address)
      expect(store.trusted.size).toBe(0)
    })

    it('propagates network failures instead of asking for a token', async () => {
      const port = await freePort()
      env = { VAULT_ADDR: `http://127.0.0.1:${port}`, VAULT_TOKEN: 'tok' }
      const error = await failure(make().getToken(config({ address: `http://127.0.0.1:${port}` }), {}, { interactive: true }))
      expect(error.info.kind).toBe('vault')
    })
  })

  describe('token cache', () => {
    it('caches per identity, renews near expiry and forgets on logout', async () => {
      vault.on('GET', 'auth/token/lookup-self', lookupSelf(3600, true))
      vault.on('POST', 'auth/token/renew-self', loginReply('tok', 3600, true))
      env.VAULT_TOKEN = 'tok'
      const auth = make()
      const first = await auth.getToken(config(), {}, { interactive: true })
      expect(first.cached).toBe(false)
      const second = await auth.getToken(config(), {}, { interactive: true })
      expect(second.cached).toBe(true)
      expect(vault.calls('GET', 'auth/token/lookup-self')).toHaveLength(1)

      now += 2_500_000 // less than a third of the TTL left
      const renewed = await auth.getToken(config(), {}, { interactive: true })
      expect(vault.calls('POST', 'auth/token/renew-self')).toHaveLength(1)
      expect(renewed.expiresAt).toBe(now + 3_600_000)

      auth.logout(`${vault.address}/`)
      await auth.getToken(config(), {}, { interactive: true })
      expect(vault.calls('GET', 'auth/token/lookup-self')).toHaveLength(2)
    })

    it('renewToken() extends a token in the last third of its TTL, shares the call and detects the max TTL', async () => {
      let granted = 600
      vault.on('POST', 'auth/userpass/login/alice', loginReply('up-tok', 600))
      vault.on('POST', 'auth/token/renew-self', (req) => ({ body: { auth: { client_token: req.token, lease_duration: granted, renewable: true } } }))
      const auth = make()
      const cfg = config({ loginMethod: 'userpass', username: 'alice' })
      const token = await auth.getToken(cfg, { vaultPassword: 'pw' }, { interactive: false })
      expect(token).toMatchObject({ ttlSec: 600, incrementSec: 600, expiresAt: now + 600_000 })
      expect(await auth.renewToken(cfg, token)).toBe(token) // not due yet: no call
      expect(vault.calls('POST', 'auth/token/renew-self')).toHaveLength(0)

      now += 450_000
      const [a, b] = await Promise.all([auth.renewToken(cfg, token), auth.renewToken(cfg, token)])
      expect(vault.calls('POST', 'auth/token/renew-self')).toHaveLength(1)
      expect(vault.calls('POST', 'auth/token/renew-self')[0].body).toEqual({ increment: 600 })
      expect(a).toEqual(b)
      expect(a).toMatchObject({ expiresAt: now + 600_000, final: false })
      // Another holder with the old copy reuses the renewed token from the cache.
      expect(await auth.renewToken(cfg, token)).toMatchObject({ expiresAt: now + 600_000 })
      expect(vault.calls('POST', 'auth/token/renew-self')).toHaveLength(1)

      now += 450_000
      granted = 120 // capped by token_max_ttl
      const capped = await auth.renewToken(cfg, a)
      expect(capped).toMatchObject({ expiresAt: now + 120_000, final: true })
      expect(await auth.renewToken(cfg, capped)).toBe(capped) // cannot be extended: no more calls
      expect(vault.calls('POST', 'auth/token/renew-self')).toHaveLength(2)
    })

    it('drops an expired token and invalidate() forces a new login', async () => {
      vault.on('GET', 'auth/token/lookup-self', lookupSelf(60, false))
      env.VAULT_TOKEN = 'tok'
      const auth = make()
      const token = await auth.getToken(config(), {}, { interactive: true })
      now += 45_000 // within the 30 s safety margin
      await auth.getToken(config(), {}, { interactive: true })
      expect(vault.calls('GET', 'auth/token/lookup-self')).toHaveLength(2)
      auth.invalidate({ ...token, token: 'other' }) // another token: no effect
      await auth.getToken(config(), {}, { interactive: true })
      expect(vault.calls('GET', 'auth/token/lookup-self')).toHaveLength(2)
      auth.invalidate(token)
      await auth.getToken(config(), {}, { interactive: true })
      expect(vault.calls('GET', 'auth/token/lookup-self')).toHaveLength(3)
    })
  })

  describe('ldap / userpass', () => {
    it('logs in on auth/<mount>/login/<user> with the Vault password', async () => {
      vault.on('POST', 'auth/userpass/login/alice', (req) => (req.body?.password === 'alice-pw' ? loginReply('up-tok', 600) : { status: 400, body: { errors: ['invalid username or password'] } }))
      vault.on('POST', 'auth/corp-ldap/login/bob%40corp', loginReply('ldap-tok'))
      const token = await make().getToken(config({ loginMethod: 'userpass', username: 'alice' }), { vaultPassword: 'alice-pw' }, { interactive: false })
      expect(token).toMatchObject({ token: 'up-tok', source: 'userpass', expiresAt: now + 600_000 })
      const ldap = await make().getToken(config({ loginMethod: 'ldap', username: 'bob@corp', authMount: 'corp-ldap' }), { vaultPassword: 'x' }, { interactive: true })
      expect(ldap.source).toBe('ldap')
    })

    it('asks for the Vault password when missing or rejected, never echoing it', async () => {
      vault.on('POST', 'auth/userpass/login/alice', { status: 400, body: { errors: ['invalid username or password'] } })
      const missing = await failure(make().getToken(config({ loginMethod: 'userpass', username: 'alice' }), {}, { interactive: true }))
      expect(missing.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultPassword', message: `Vault password required for alice on ${vault.address}` })
      const wrong = await failure(make().getToken(config({ loginMethod: 'userpass', username: 'alice' }), { vaultPassword: 'wrong-pw-123' }, { interactive: true }))
      expect(wrong.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultPassword', code: '400' })
      expect(wrong.info.message).toBe(`Vault rejected the password for alice on ${vault.address}`)
      expect(JSON.stringify(wrong.info)).not.toContain('wrong-pw-123')
    })

    it('reports a missing auth mount (403) as a Vault error, not as a rejected password', async () => {
      vault.on('POST', 'auth/team-ldap/login/alice', { status: 403, body: { errors: ['permission denied'] } })
      const error = await failure(make().getToken(config({ loginMethod: 'ldap', username: 'alice', authMount: 'team-ldap' }), { vaultPassword: 'right-pw-123' }, { interactive: true }))
      expect(error.info).toMatchObject({ kind: 'vault', code: '403' })
      expect(error.info.secretField).toBeUndefined()
      expect(error.message).toBe(`Vault refused the sign-in at auth/team-ldap (permission denied). Check the auth mount: "team-ldap" may not exist on ${vault.address}.`)
      expect(JSON.stringify(error.info)).not.toContain('right-pw-123')
    })
  })

  describe('oidc', () => {
    let port: number
    let state: string
    let nonce: string
    let redirect: string

    beforeEach(async () => {
      port = await freePort()
      state = `st-${Math.random().toString(36).slice(2)}`
      nonce = ''
      redirect = ''
      vault.on('POST', 'auth/oidc/oidc/auth_url', (req) => {
        nonce = String(req.body?.client_nonce ?? '')
        redirect = String(req.body?.redirect_uri ?? '')
        return { body: { data: { auth_url: `https://idp.example.cloud/authorize?client_id=dg&state=${state}&nonce=n&redirect_uri=${encodeURIComponent(redirect)}` } } }
      })
      vault.on('GET', 'auth/oidc/oidc/callback', (req) =>
        req.query.get('code') === 'the-code' && req.query.get('state') === state && req.query.get('client_nonce') === nonce
          ? loginReply('oidc-tok', 28800)
          : { status: 400, body: { errors: ['invalid code'] } },
      )
    })

    const oidc = (patch: Partial<VaultConfig> = {}) => config({ loginMethod: 'oidc', ...patch })

    /** Plays the browser: follows the redirect to the local callback. */
    const browser = (steps: (redirectUri: string) => Promise<void>) => async (url: string) => {
      const target = new URL(url)
      expect(target.origin).toBe('https://idp.example.cloud')
      setTimeout(() => void steps(target.searchParams.get('redirect_uri') ?? ''), 10)
    }

    it('runs the vault CLI flow end to end', async () => {
      const pages: { status: number; text: string }[] = []
      const auth = make({
        oidcPort: port,
        openExternal: browser(async (uri) => {
          const res = await fetch(`${uri}?code=the-code&state=${state}`)
          pages.push({ status: res.status, text: await res.text() })
        }),
      })
      const token = await auth.getToken(oidc({ oidcRole: 'reader' }), {}, { interactive: true })
      expect(token).toMatchObject({ token: 'oidc-tok', source: 'oidc', expiresAt: now + 28_800_000 })
      expect(redirect).toBe(`http://localhost:${port}/oidc/callback`)
      expect(vault.calls('POST', 'auth/oidc/oidc/auth_url')[0].body).toMatchObject({ role: 'reader', redirect_uri: redirect })
      expect(nonce.length).toBeGreaterThan(20)
      await new Promise((r) => setTimeout(r, 20))
      expect(pages).toHaveLength(1)
      expect(pages[0].status).toBe(200)
      expect(pages[0].text).toContain('Signed in to Vault')
      expect(pages[0].text).not.toMatch(/<script|https?:\/\/(?!localhost)/)
      expect(events.map((e) => e.state)).toEqual(['browser-opened', 'completed'])
      expect(events[0].url).toContain('https://idp.example.cloud/authorize')
      // The callback server is gone.
      await expect(fetch(`http://127.0.0.1:${port}/oidc/callback`)).rejects.toThrow()
    })

    it('refuses other paths and a mismatched state, then accepts the real callback', async () => {
      const statuses: number[] = []
      const auth = make({
        oidcPort: port,
        openExternal: browser(async (uri) => {
          statuses.push((await fetch(uri.replace('/oidc/callback', '/other'))).status)
          statuses.push((await fetch(`${uri}?code=the-code&state=forged`)).status)
          statuses.push((await fetch(`${uri}?code=the-code&state=${state}`)).status)
        }),
      })
      await auth.getToken(oidc(), {}, { interactive: true })
      await new Promise((r) => setTimeout(r, 20))
      expect(statuses).toEqual([404, 400, 200])
      expect(vault.calls('GET', 'auth/oidc/oidc/callback')).toHaveLength(1)
    })

    it('token method: falls back to the browser sign-in when ~/.vault-token is missing or expired', async () => {
      vault.on('GET', 'auth/token/lookup-self', requireToken('oidc-tok', lookupSelf(28800)))
      writeFileSync(join(home, '.vault-token'), 'expired-cli-tok')
      const opened: string[] = []
      const auth = make({
        oidcPort: port,
        openExternal: async (url) => {
          opened.push(url)
          await browser(async (uri) => void (await fetch(`${uri}?code=the-code&state=${state}`)))(url)
        },
      })
      const token = await auth.getToken(config({ oidcRole: 'reader' }), {}, { interactive: true })
      expect(token).toMatchObject({ token: 'oidc-tok', source: 'oidc' })
      expect(opened).toHaveLength(1)
      expect(vault.calls('POST', 'auth/oidc/oidc/auth_url')[0].body).toMatchObject({ role: 'reader' })
      // Cached for the token identity: no second browser window.
      expect((await auth.getToken(config({ oidcRole: 'reader' }), {}, { interactive: true })).token).toBe('oidc-tok')
      expect(opened).toHaveLength(1)
    })

    it('token method: a Vault without OIDC never opens the callback port', async () => {
      vault.on('POST', 'auth/oidc/oidc/auth_url', { status: 400, body: { errors: ['no handler for route "auth/oidc/oidc/auth_url"'] } })
      const blocker = http.createServer()
      await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
      try {
        // The port is busy: had the flow bound it first, the error would be about the port.
        const error = await failure(make({ oidcPort: port }).getToken(config(), {}, { interactive: true }))
        expect(error.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultToken' })
        expect(error.info.detail).toMatch(/no handler for route/)
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })

    it('token method: background logins never open the browser; a failed fallback asks for a token', async () => {
      vault.on('GET', 'auth/token/lookup-self', { status: 403, body: { errors: ['permission denied'] } })
      const auth = make({ oidcPort: port, openExternal: async () => expect.fail('no browser') })
      const background = await failure(auth.getToken(config(), {}, { interactive: false }))
      expect(isLoginRequired(background)).toBe(true)
      expect(background.message).toMatch(/vault login -method=oidc/)

      vault.on('POST', 'auth/oidc/oidc/auth_url', { status: 400, body: { errors: ['role "default" could not be found'] } })
      const prompt = await failure(make({ oidcPort: port }).getToken(config(), {}, { interactive: true }))
      expect(prompt.info).toMatchObject({ kind: 'needs-password', secretField: 'vaultToken' })
      expect(prompt.info.detail).toMatch(/Browser sign-in \(OIDC\) failed/)
    })

    it('keeps a browser sign-in (encrypted store) for the next run while Vault accepts it', async () => {
      vault.on('GET', 'auth/token/lookup-self', requireToken('oidc-tok', lookupSelf(20000)))
      const store = new MemoryVaultTokenStore()
      let opened = 0
      const first = make({
        oidcPort: port,
        tokenStore: store,
        openExternal: async (url) => {
          opened++
          await browser(async (uri) => void (await fetch(`${uri}?code=the-code&state=${state}`)))(url)
        },
      })
      await first.getToken(oidc(), {}, { interactive: true })
      expect(opened).toBe(1)
      expect([...store.tokens.values()].map((t) => t.source)).toEqual(['oidc'])

      // Next run: reused without the browser (validated with lookup-self).
      const second = make({ oidcPort: port, tokenStore: store, openExternal: async () => expect.fail('no browser') })
      const restored = await second.getToken(oidc(), {}, { interactive: false })
      expect(restored).toMatchObject({ token: 'oidc-tok', source: 'oidc', expiresAt: now + 20_000_000 })

      // Vault no longer accepts it: dropped, and a sign-in is needed again.
      vault.on('GET', 'auth/token/lookup-self', { status: 403, body: { errors: ['permission denied'] } })
      const third = make({ oidcPort: port, tokenStore: store, openExternal: async () => expect.fail('no browser') })
      expect(isLoginRequired(await failure(third.getToken(oidc(), {}, { interactive: false })))).toBe(true)
      expect(store.tokens.size).toBe(0)
    })

    it('sign-out deletes saved sign-ins of that server only', async () => {
      const store = new MemoryVaultTokenStore()
      const auth = make({ tokenStore: store })
      const saved = { token: 't', source: 'oidc' as const, expiresAt: now + 3_600_000, renewable: true, obtainedAt: now }
      store.setToken(`${vault.address.toLowerCase()}||oidc|oidc|`, saved)
      store.setToken('https://vault.example.shared||oidc|oidc|', saved)
      auth.logout(vault.address)
      expect([...store.tokens.keys()]).toEqual(['https://vault.example.shared||oidc|oidc|'])
    })

    it('fails when the identity provider refuses', async () => {
      const auth = make({
        oidcPort: port,
        openExternal: browser(async (uri) => {
          await fetch(`${uri}?error=access_denied&error_description=User+cancelled&state=${state}`)
        }),
      })
      const error = await failure(auth.getToken(oidc(), {}, { interactive: true }))
      expect(error.message).toBe('Vault sign-in failed: User cancelled')
      expect(events.map((e) => e.state)).toEqual(['browser-opened', 'failed'])
    })

    it('can be cancelled', async () => {
      const auth = make({ oidcPort: port, openExternal: async () => undefined, emit: (e) => {
        events.push(e)
        if (e.state === 'browser-opened') setTimeout(() => auth.cancelLogin(), 10)
      } })
      const error = await failure(auth.getToken(oidc(), {}, { interactive: true }))
      expect(error.info.kind).toBe('cancelled')
      expect(events.map((e) => e.state)).toEqual(['browser-opened', 'cancelled'])
      // The port is free again.
      const again = make({ oidcPort: port, openExternal: browser(async (uri) => void (await fetch(`${uri}?code=the-code&state=${state}`))) })
      expect((await again.getToken(oidc(), {}, { interactive: true })).token).toBe('oidc-tok')
    })

    it('times out', async () => {
      const auth = make({ oidcPort: port, oidcTimeoutMs: 150, openExternal: async () => undefined })
      const error = await failure(auth.getToken(oidc(), {}, { interactive: true }))
      expect(error.info.kind).toBe('vault')
      expect(error.message).toMatch(/timed out/)
      expect(events.map((e) => e.state)).toEqual(['browser-opened', 'failed'])
    })

    it('reports a busy callback port', async () => {
      const blocker = http.createServer()
      await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', () => resolve()))
      try {
        const opened: string[] = []
        const error = await failure(make({ oidcPort: port, openExternal: async (url) => void opened.push(url) }).getToken(oidc(), {}, { interactive: true }))
        expect(error.message).toBe(`Port ${port} is in use — is another Vault login in progress?`)
        // Vault was asked first (a server without OIDC must never open the port), but no browser opened.
        expect(vault.calls('POST', 'auth/oidc/oidc/auth_url')).toHaveLength(1)
        expect(opened).toEqual([])
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })

    it('a caller that gives up (abort) stops waiting at once; the sign-in stops when nobody waits any more', async () => {
      const opened: string[] = []
      const auth = make({ oidcPort: port, openExternal: async (url) => void opened.push(url) })
      const first = new AbortController()
      const second = new AbortController()
      const a = failure(auth.getToken(oidc(), {}, { interactive: true, signal: first.signal }))
      const b = failure(auth.getToken(oidc(), {}, { interactive: true, signal: second.signal }))
      for (let i = 0; i < 100 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      first.abort()
      expect((await a).info.kind).toBe('cancelled')
      // The other caller still waits for the shared sign-in.
      await new Promise((r) => setTimeout(r, 50))
      expect(events.map((e) => e.state)).toEqual(['browser-opened'])
      second.abort()
      expect((await b).info.kind).toBe('cancelled')
      await new Promise((r) => setTimeout(r, 50))
      expect(events.map((e) => e.state)).toEqual(['browser-opened', 'cancelled'])
      // The callback port is free again.
      await expect(fetch(`http://127.0.0.1:${port}/oidc/callback`)).rejects.toThrow()
    })

    it('cancelLogin() also cancels sign-ins queued behind the running one', async () => {
      const opened: string[] = []
      const auth = make({ oidcPort: port, openExternal: async (url) => void opened.push(url) })
      const a = failure(auth.getToken(oidc({ oidcRole: 'reader' }), {}, { interactive: true }))
      const b = failure(auth.getToken(oidc({ oidcRole: 'banking-reader' }), {}, { interactive: true }))
      for (let i = 0; i < 100 && opened.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      auth.cancelLogin()
      expect((await a).info.kind).toBe('cancelled')
      expect((await b).info.kind).toBe('cancelled')
      await new Promise((r) => setTimeout(r, 100))
      expect(opened).toHaveLength(1)
    })

    it('shares one login between concurrent connects', async () => {
      let opened = 0
      const auth = make({
        oidcPort: port,
        openExternal: browser(async (uri) => {
          opened++
          await fetch(`${uri}?code=the-code&state=${state}`)
        }),
      })
      const [a, b] = await Promise.all([auth.getToken(oidc(), {}, { interactive: true }), auth.getToken(oidc(), {}, { interactive: true })])
      expect(a.token).toBe('oidc-tok')
      expect(b.token).toBe('oidc-tok')
      expect(opened).toBe(1)
      expect(vault.calls('POST', 'auth/oidc/oidc/auth_url')).toHaveLength(1)
    })

    it('never opens a browser for a background (non-interactive) login', async () => {
      const auth = make({ oidcPort: port, openExternal: async () => expect.fail('no browser') })
      const error = await failure(auth.getToken(oidc(), {}, { interactive: false }))
      expect(isLoginRequired(error)).toBe(true)
      expect(error.info.kind).toBe('vault')
    })

    it('explains an empty auth_url', async () => {
      vault.on('POST', 'auth/sso/oidc/auth_url', { body: { data: { auth_url: '' } } })
      const error = await failure(make({ oidcPort: port }).getToken(oidc({ authMount: 'sso', oidcRole: 'dev' }), {}, { interactive: true }))
      expect(error.message).toBe(`Vault returned no OIDC sign-in URL. Check the OIDC role "dev" and that http://localhost:${port}/oidc/callback is an allowed redirect URI.`)
    })
  })
})
